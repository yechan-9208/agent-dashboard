'use strict';
// ================= 스킬 호출 "횟수" 집계 (신호 B — 세션 로그) =================
// 배경: 대시보드는 작업을 직접 하지 않으므로 사용량을 "바깥에서 관찰"만 한다.
//  · A 신호(파일 mtime/git) = 마지막 "수정" 1회 → 빈도(몇 번 호출됐나)를 만들 수 없다.
//  · B 신호(세션 transcript 파싱) = 실제 tool_use 라인에서 Skill 호출 "횟수"를 센다.
// 이 모듈은 B만 담당한다 — Claude 세션 로그에서 **스킬 이름·호출 시각만** 뽑아 집계한다.
//
// 출처(0번 검증: docs/verification/usage-log-verification.md):
//   ~/.claude/projects/<인코딩된 프로젝트경로>/<세션id>.jsonl
//   각 줄이 message / tool use / metadata 중 하나인 JSONL.
//   ⚠ 공식 경고: "내부 형식이고 버전마다 바뀌며 직접 파싱은 어느 릴리스에서나 깨질 수 있다"
//     → 어떤 줄이든 깨지면 조용히 skip(방어적 파싱). 실패해도 예외를 던지지 않고 계속한다.
//
// ★ 보안 클로즈(최우선 — 위반 시 무효):
//   · 본문(대화/코드/입력)은 **메모리 밖으로 절대 내보내지 않는다**. 반환값·저장 파일·로그 어디에도
//     스킬 이름·시각(ISO) 외의 내용을 싣지 않는다.
//   · Codex(~/.codex/sessions/·history.jsonl)는 거부목록 — 이 모듈은 절대 접근하지 않는다.

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

// ── 경로 상수 (paths.js 수정 금지 → 여기서 정의) ─────────────────────────────
// 스캔 대상 루트: ~/.claude/projects (AAD_SESSIONS_ROOT로 격리 테스트 가능).
function claudeProjectsRoot() {
  return process.env.AAD_SESSIONS_ROOT || path.join(os.homedir(), '.claude', 'projects');
}

// 커서·이벤트 파일은 canonicalRoot() 아래(AAD_CANONICAL 오버라이드 시 자동 격리).
//  - 커서 : 파일별 {size, mtimeMs, lines}(마지막 처리 라인 수) — 증분 스캔용.
//  - 이벤트: { [skillName]: [ISO...] } — 스킬당 최신순 상한 1000. 이름·시각만(본문 0).
function cursorPath() {
  return path.join(paths.canonicalRoot(), '.usage-scan.json');
}
function eventsPath() {
  return path.join(paths.canonicalRoot(), '.usage-events.json');
}

const DEFAULT_WINDOW_DAYS = 30; // 스캔 윈도(파일 mtime 밖이면 skip — 성능)
const MAX_EVENTS_PER_SKILL = 1000; // 스킬당 이벤트 상한(최신 우선)
const DAY_MS = 24 * 60 * 60 * 1000;

// ── JSON 파일 안전 로드/저장 (깨지면 빈 객체) ────────────────────────────────
function loadJson(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}
function saveJson(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj, null, 0));
  } catch {
    /* 저장 실패도 조용히 무시(집계는 best-effort 신호) */
  }
}

// ── 스킬 이름 정규화 ─────────────────────────────────────────────────────────
// 'personal:pdf' / 'plugin:skill' → 마지막 세그먼트. 공백 트림. 비문자열/빈값은 null.
function normalizeSkillName(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  if (s.includes(':')) {
    const seg = s.split(':').pop().trim();
    if (seg) s = seg;
  }
  return s || null;
}

// ── 한 줄(파싱된 객체)에서 Skill 호출 이름을 방어적으로 추출 ──────────────────
// 알려진/변형 패턴을 몇 가지 지원한다. 어느 것에도 안 맞으면 [](스킵).
//  형식은 내부용이라 버전마다 다를 수 있어, tool_use 성격 엔트리를 여러 shape로 훑는다.
//  ★ 스킬 이름 문자열만 취한다. 그 외 필드(input 본문 등)는 절대 읽지/반환하지 않는다.
function extractSkillNamesFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return [];
  const names = [];

  // tool_use 블록 하나에서 "Skill 호출이면" 스킬 이름을 뽑는다.
  //  - name 이 'Skill'(대소문자 무시)인 tool_use → input.skill / input.command 이 스킬 이름.
  //  - name 이 'skill:foo' / 'Skill(foo)' 같은 변형이면 그 안의 이름.
  const fromToolUse = (blk) => {
    if (!blk || typeof blk !== 'object') return;
    if (blk.type !== 'tool_use' && blk.type !== 'tool-use') return;
    const toolName = typeof blk.name === 'string' ? blk.name : '';
    const input = blk.input && typeof blk.input === 'object' ? blk.input : {};
    if (/^skill$/i.test(toolName)) {
      // 대표 패턴: {type:'tool_use', name:'Skill', input:{skill|command:'...'}}
      const nm = normalizeSkillName(input.skill || input.command || input.name);
      if (nm) names.push(nm);
      return;
    }
    // 변형: name 자체가 'Skill:foo' 또는 'Skill(foo)' 형태로 스킬명을 품는 경우.
    let m = /^skill[:(]\s*([^)\s]+)\)?$/i.exec(toolName);
    if (m) {
      const nm = normalizeSkillName(m[1]);
      if (nm) names.push(nm);
    }
  };

  // (a) message.content[] 안의 tool_use 블록들
  const content = entry.message && Array.isArray(entry.message.content) ? entry.message.content : null;
  if (content) {
    for (const blk of content) fromToolUse(blk);
  }
  // (b) 최상위가 곧 tool_use 엔트리인 변형
  fromToolUse(entry);
  // (c) 최상위 content[](message 래핑 없이)
  if (Array.isArray(entry.content)) {
    for (const blk of entry.content) fromToolUse(blk);
  }

  return names;
}

// ── 한 줄에서 timestamp(ISO) 추출 (있으면). 없으면 null → 호출자가 파일 mtime로 대체. ──
function extractTimestamp(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const ts = entry.timestamp || entry.ts || (entry.message && entry.message.timestamp);
  if (ts == null) return null;
  const d = new Date(ts);
  const ms = d.getTime();
  return Number.isFinite(ms) ? d.toISOString() : null;
}

// ── 이벤트 병합: skill → 시각 배열(최신순, 상한). 중복 시각은 넣지 않는다. ──────
function pushEvent(events, name, iso) {
  if (!events[name]) events[name] = [];
  const arr = events[name];
  // 증분 스캔이라 같은 라인을 두 번 처리하지 않지만, 방어적으로 동일 ISO 중복은 배제.
  if (arr.length && arr[arr.length - 1] === iso) return;
  arr.push(iso);
}

// 배열을 최신순 정렬 + 상한 절단(스킬당 MAX_EVENTS_PER_SKILL).
function trimEvents(events) {
  for (const name of Object.keys(events)) {
    const arr = events[name];
    arr.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // 최신(큰 ISO) 먼저
    if (arr.length > MAX_EVENTS_PER_SKILL) events[name] = arr.slice(0, MAX_EVENTS_PER_SKILL);
  }
}

// ── 한 파일을 증분 처리: cursor 기준 새 라인만 파싱해 events에 누적, 새 cursor 반환. ──
//  · 파일이 줄어들었거나(size↓) 새 파일이면 처음부터.
//  · 각 줄 JSON.parse 실패 → 그 줄만 skip. 파일 자체 읽기 실패 → 파일 통째 skip(cursor 유지).
function processFile(filePath, prevCursor, events) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return prevCursor || null; // stat 실패 → 손대지 않음
  }
  const fileMtimeIso = new Date(stat.mtimeMs).toISOString();

  // 증분: 이전보다 파일이 커졌고 size가 줄지 않았으면 startLine부터 이어서 처리.
  let startLine = 0;
  if (prevCursor && typeof prevCursor.lines === 'number' && typeof prevCursor.size === 'number') {
    if (stat.size >= prevCursor.size) startLine = prevCursor.lines; // 이어서
    else startLine = 0; // 파일이 줄었음 → 처음부터(로테이션 등)
  }

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return prevCursor || null; // 읽기 실패 → cursor 유지
  }

  // JSONL: 줄 단위. 마지막 빈 줄은 무시. 라인 수 = 실제 콘텐츠 라인 수.
  const lines = raw.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 깨진 줄 skip
    }
    const skillNames = extractSkillNamesFromEntry(entry);
    if (!skillNames.length) continue;
    const iso = extractTimestamp(entry) || fileMtimeIso; // 없으면 파일 mtime
    for (const nm of skillNames) pushEvent(events, nm, iso);
  }

  return { size: stat.size, mtimeMs: stat.mtimeMs, lines: lines.length };
}

// ── 스캔 대상 파일 목록: <root>/*/*.jsonl 중 mtime이 윈도 안인 것만. ──────────
//  ★ 실제 모드에서는 이 목록화가 곧 ~/.claude/projects 접근이다 — 사용자가 실제 모드를
//    명시적으로 켰을 때만 도달한다(더미 기본). 존재하지 않으면 빈 배열(조용히).
function listSessionFiles(root, windowDays) {
  const out = [];
  const cutoff = Date.now() - windowDays * DAY_MS;
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out; // 루트 없음(로그 전혀 없음) → 빈 목록
  }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files;
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const fp = path.join(dir, f.name);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) continue; // 윈도 밖 → skip(성능)
      } catch {
        continue;
      }
      out.push(fp);
    }
  }
  return out;
}

// ── 공개 API: scan ───────────────────────────────────────────────────────────
// 증분 수집(요청 시 1회 — 자동 폴링 없음). 오류는 조용히 skip하고 계속.
// 반환: { scanned:파일수, events:스킬종류수, source:'claude-sessions'|'none' }
//  (반환값에도 스킬 이름/횟수 요약만 — 본문 없음.)
function scan({ windowDays } = {}) {
  const win = typeof windowDays === 'number' && windowDays > 0 ? windowDays : DEFAULT_WINDOW_DAYS;
  const root = claudeProjectsRoot();
  const cursorFile = cursorPath();
  const eventsFile = eventsPath();

  const cursors = loadJson(cursorFile); // { [absPath]: {size,mtimeMs,lines} }
  const events = loadJson(eventsFile); // { [skill]: [ISO...] }

  let files;
  try {
    files = listSessionFiles(root, win);
  } catch {
    files = [];
  }

  let scanned = 0;
  for (const fp of files) {
    try {
      const next = processFile(fp, cursors[fp], events);
      if (next) cursors[fp] = next;
      scanned++;
    } catch {
      /* 파일 하나가 깨져도 전체는 계속(우아한 실패) */
    }
  }

  trimEvents(events);
  saveJson(eventsFile, events);
  saveJson(cursorFile, cursors);

  const kinds = Object.keys(events).length;
  return {
    scanned,
    events: kinds,
    // 로그 파일 자체가 없었으면(=이벤트 0 & 스캔 0) 'none'을 알려 폴백 표시에 쓴다.
    source: scanned === 0 && kinds === 0 ? 'none' : 'claude-sessions',
  };
}

// ── 공개 API: statsFor ───────────────────────────────────────────────────────
// 저장된 이벤트에서 이름 목록별 빈도 집계.
//  반환: { [name]: { day1, day7, total, lastUsed } }
//   · day1  = now 기준 24h 이내 호출 수
//   · day7  = now 기준 7일 이내 호출 수
//   · total = 누적 이벤트 수(★ 커서 시작 이후 누적임 — 그 전 기록은 없음)
//   · lastUsed = 가장 최근 호출 ISO(없으면 null)
function statsFor(names, now) {
  const nowDate = now instanceof Date ? now : now ? new Date(now) : new Date();
  const nowMs = nowDate.getTime();
  const day1Cut = nowMs - 1 * DAY_MS;
  const day7Cut = nowMs - 7 * DAY_MS;

  const events = loadJson(eventsPath());
  const out = {};
  const list = Array.isArray(names) ? names : [];
  for (const rawName of list) {
    const name = normalizeSkillName(rawName) || String(rawName);
    const arr = Array.isArray(events[name]) ? events[name] : [];
    let day1 = 0;
    let day7 = 0;
    let lastUsed = null;
    for (const iso of arr) {
      const ms = new Date(iso).getTime();
      if (!Number.isFinite(ms)) continue;
      if (ms >= day1Cut) day1++;
      if (ms >= day7Cut) day7++;
      if (lastUsed == null || iso > lastUsed) lastUsed = iso;
    }
    out[name] = { day1, day7, total: arr.length, lastUsed };
  }
  return out;
}

module.exports = {
  scan,
  statsFor,
  normalizeSkillName, // (테스트/재사용용)
  // 경로 접근자(격리 검증용) — 본문 없음, 경로 문자열만.
  _paths: { claudeProjectsRoot, cursorPath, eventsPath },
};
