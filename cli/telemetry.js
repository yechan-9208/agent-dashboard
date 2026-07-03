'use strict';
// 항목별 사용량 telemetry + 결정론적 노후화(stale/archived) 계산.
//
// 신호는 두 종류다(plan2.md 1절):
//  - A) 편집/변경 — backbone, 항상 가능. canonical git 이력(churn_count·last_changed),
//       git 저장소가 아니면 파일 mtime 폴백.
//  - B) 실제 호출 — best-effort. invocation_count·last_invoked. (이 모듈은 B를 "건드리지" 않는다.
//       기본 0/null로만 두고, 별도 작업이 채울 수 있게 병합 시 기존 B 값을 보존한다.)
//
// 활동 = max(last_changed, last_invoked). 무활동 기간으로 상태를 전이한다(LLM 없이):
//   active → stale(기본 30일) → archived(기본 90일). pinned=true면 전이에서 제외.
//
// 사이드카: canonicalRoot()/.telemetry.json (항목 id → 메타).
// 설정:    canonicalRoot()/.telemetry-config.json {staleDays, archiveDays} (없으면 코드 상수).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('./paths');
const canonical = require('./canonical');

// 기본 노후화 임계값(일). .telemetry-config.json 으로 덮어쓸 수 있다.
const DEFAULT_THRESHOLDS = { staleDays: 30, archiveDays: 90 };

const SIDECAR_NAME = '.telemetry.json';
const CONFIG_NAME = '.telemetry-config.json';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- 경로 ----------

function sidecarPath() {
  return path.join(paths.canonicalRoot(), SIDECAR_NAME);
}

function configPath() {
  return path.join(paths.canonicalRoot(), CONFIG_NAME);
}

// ---------- 설정/사이드카 입출력 ----------

// 노후화 임계값을 읽는다. 인자(overrides)가 최우선, 그다음 설정 파일, 마지막이 코드 상수.
function loadThresholds(overrides) {
  let fileCfg = {};
  try {
    if (fs.existsSync(configPath())) {
      fileCfg = JSON.parse(fs.readFileSync(configPath(), 'utf8')) || {};
    }
  } catch {
    // 설정 파일이 깨졌으면 조용히 기본값으로 폴백(telemetry가 죽으면 안 된다).
    fileCfg = {};
  }
  return { ...DEFAULT_THRESHOLDS, ...fileCfg, ...(overrides || {}) };
}

// 사이드카(.telemetry.json)를 읽는다. 없거나 깨졌으면 빈 객체.
function load() {
  try {
    if (!fs.existsSync(sidecarPath())) return {};
    return JSON.parse(fs.readFileSync(sidecarPath(), 'utf8')) || {};
  } catch {
    return {};
  }
}

// 사이드카를 저장한다.
function save(data) {
  fs.mkdirSync(paths.canonicalRoot(), { recursive: true });
  fs.writeFileSync(sidecarPath(), JSON.stringify(data, null, 2) + '\n');
  return data;
}

// ---------- canonical 항목 목록 ----------

// canonical에 존재하는 모든 항목을 { id, file } 로 모은다.
//  - skill : canonical/skills/<name>/SKILL.md
//  - agent : canonical/agents/<id>.json
//  - 지시문 : canonical/instructions/<id>.md  (현재 슬라이스는 instr-global 1개)
// file 은 절대 경로(git 상대경로 계산과 mtime 둘 다에 쓴다).
function listItems() {
  const items = [];

  // skill: meta.name 으로 폴더를 찾는다.
  for (const meta of canonical.listSkills()) {
    items.push({
      id: meta.id, // 'skill-<name>'
      kind: 'skill',
      file: path.join(canonical.skillsDir(), meta.name, 'SKILL.md'),
    });
  }

  // agent: <id>.json
  for (const agent of canonical.listAgents()) {
    items.push({
      id: agent.id,
      kind: 'agent',
      file: path.join(canonical.agentsDir(), `${agent.id}.json`),
    });
  }

  // 지시문(글로벌). 현재는 instr-global 하나만 다룬다.
  const INSTR_ID = 'instr-global';
  if (canonical.exists(INSTR_ID)) {
    items.push({
      id: INSTR_ID,
      kind: 'instruction',
      file: path.join(canonical.instrDir(), `${INSTR_ID}.md`),
    });
  }

  return items;
}

// ---------- A 신호: git 이력 또는 mtime 폴백 ----------

// canonicalRoot 가 git 저장소인지 한 번만 확인한다.
function isGitRepo(root) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// 한 파일의 A 신호를 계산한다.
// 반환: { churn_count, last_changed(ISO|null), source: 'git'|'mtime' }
function computeChangeSignal(file, root, gitAvailable) {
  // 1) git 이력 우선
  if (gitAvailable) {
    try {
      const rel = path.relative(root, file);
      // 각 커밋의 committer date(ISO)를 한 줄씩. 해당 파일을 건드린 커밋만.
      const out = execFileSync('git', ['log', '--format=%cI', '--', rel], {
        cwd: root,
        encoding: 'utf8',
      });
      const lines = out.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length > 0) {
        return {
          churn_count: lines.length, // 이 파일을 건드린 커밋 수
          last_changed: lines[0], // git log 는 최신순 → 첫 줄이 최종 변경 시각
          source: 'git',
        };
      }
      // 커밋 이력이 없으면(아직 add/commit 안 됨) mtime 폴백으로 떨어진다.
    } catch {
      // git 호출 실패 시 mtime 폴백.
    }
  }

  // 2) mtime 폴백: churn 은 알 수 없으므로 0, last_changed 는 파일 수정 시각.
  try {
    const st = fs.statSync(file);
    return {
      churn_count: 0,
      last_changed: new Date(st.mtimeMs).toISOString(),
      source: 'mtime',
    };
  } catch {
    // 파일이 없으면(이론상) 신호 없음.
    return { churn_count: 0, last_changed: null, source: 'mtime' };
  }
}

// ---------- 상태(노후화) 계산 ----------

// 두 ISO 시각 중 더 최근 것을 ISO 로 반환(없으면 null). 활동 시각 계산에 쓴다.
function latestActivity(meta) {
  const times = [meta.last_changed, meta.last_invoked].filter(Boolean).map((t) => Date.parse(t));
  const valid = times.filter((n) => !Number.isNaN(n));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid)).toISOString();
}

// 결정론적 상태 전이. pinned 면 무조건 active 로 본다(자동 전이 제외).
// now 는 Date 또는 ISO/타임스탬프. thresholds 는 {staleDays, archiveDays}.
function getState(meta, now, thresholds) {
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  if (meta && meta.pinned) return 'active';

  const activity = latestActivity(meta);
  // 활동 시각을 전혀 모르면 보수적으로 active(섣불리 archive 하지 않는다).
  if (!activity) return 'active';

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const idleDays = (nowMs - Date.parse(activity)) / DAY_MS;

  if (idleDays >= th.archiveDays) return 'archived';
  if (idleDays >= th.staleDays) return 'stale';
  return 'active';
}

// ---------- pin / unpin ----------

// 항목을 pin/unpin 한다. 사이드카에 항목이 없으면 새로 만든다(기본 스키마로).
function setPinned(id, pinned) {
  const data = load();
  data[id] = mergeRecord(data[id], { pinned: !!pinned });
  save(data);
  return data[id];
}

function pin(id) {
  return setPinned(id, true);
}

function unpin(id) {
  return setPinned(id, false);
}

// ---------- 레코드 병합(스키마 단일 출처) ----------

// 기본 스키마. B(invocation_count·last_invoked)는 0/null 기본 — 별도 작업이 채운다.
function baseRecord() {
  return {
    churn_count: 0,
    last_changed: null,
    invocation_count: 0,
    last_invoked: null,
    signal_sources: [],
    state: 'active',
    pinned: false,
  };
}

// 기존 레코드 위에 patch 를 덮어쓴다. B 필드(invocation_count·last_invoked)는
// patch 에 명시되지 않으면 항상 기존 값을 보존한다 — A 재계산이 B를 지우면 안 된다.
function mergeRecord(prev, patch) {
  const base = { ...baseRecord(), ...(prev || {}) };
  return { ...base, ...(patch || {}) };
}

// ---------- 재계산(메인 진입점) ----------

// 모든 canonical 항목의 A 신호를 다시 계산하고, 상태를 전이해 사이드카를 갱신·반환한다.
//  - now: 활동/노후화 기준 시각(테스트 용이성을 위해 인자로 받는다). 생략 시 new Date().
//  - thresholds: {staleDays, archiveDays} 덮어쓰기(생략 시 설정 파일/상수).
// B 값은 보존한다(이 함수는 A만 갱신).
function recompute(now, thresholds) {
  const nowDate = now instanceof Date ? now : now ? new Date(now) : new Date();
  const th = loadThresholds(thresholds);

  const root = paths.canonicalRoot();
  const gitAvailable = isGitRepo(root);

  const data = load();
  const items = listItems();
  const seen = new Set();

  for (const item of items) {
    seen.add(item.id);
    const prev = data[item.id];
    const a = computeChangeSignal(item.file, root, gitAvailable);

    // signal_sources: A 출처('git'|'mtime')를 보장하고, 기존 B 출처(예: 'claude:transcript')는 유지.
    const prevSources = (prev && Array.isArray(prev.signal_sources) ? prev.signal_sources : []).filter(
      (s) => s !== 'git' && s !== 'mtime'
    );
    const signal_sources = [a.source, ...prevSources];

    // A 신호와 출처만 갱신(병합으로 B 보존).
    let rec = mergeRecord(prev, {
      churn_count: a.churn_count,
      last_changed: a.last_changed,
      signal_sources,
    });

    // 상태 전이는 갱신된 A(+보존된 B)를 바탕으로 계산.
    rec.state = getState(rec, nowDate, th);
    data[item.id] = rec;
  }

  // canonical 에서 사라진 항목은 사이드카에 남겨둔다(이력/복구 목적). 삭제하지 않는다.

  save(data);
  return data;
}

// ---------- 조회 ----------

// 항목 목록 + telemetry + 상태를 합쳐 반환. 재계산은 하지 않고 현재 사이드카를 읽는다.
// 사이드카에 없는 항목은 기본 스키마로 채워 함께 반환한다.
function list(now, thresholds) {
  const nowDate = now instanceof Date ? now : now ? new Date(now) : new Date();
  const th = loadThresholds(thresholds);
  const data = load();

  return listItems().map((item) => {
    const telemetry = mergeRecord(data[item.id], {});
    return {
      id: item.id,
      kind: item.kind,
      telemetry,
      state: telemetry.pinned ? 'active' : getState(telemetry, nowDate, th),
    };
  });
}

module.exports = {
  // 입출력
  load,
  save,
  loadThresholds,
  sidecarPath,
  configPath,
  // 핵심
  recompute,
  getState,
  list,
  listItems,
  // pin
  pin,
  unpin,
  // 내부 신호(테스트/재사용용으로 노출)
  computeChangeSignal,
  latestActivity,
  isGitRepo,
  DEFAULT_THRESHOLDS,
};
