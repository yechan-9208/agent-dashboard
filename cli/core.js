'use strict';
// 명령 로직의 단일 소스. CLI(bin/aad.js)와 서버(server/serve.js)가 모두 여기를 호출한다.
// 여기 함수들은 콘솔 출력/exit을 하지 않고 "데이터"만 돌려준다 (CLI는 출력용으로 포장, 서버는 JSON으로).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const matter = require('gray-matter');
const TOML = require('@iarna/toml'); // (F5) codex(.toml) 에이전트의 참조 스킬 파싱용

const paths = require('./paths');
const scanner = require('./scanner');
const canonical = require('./canonical');
const diff = require('./diff');
const backup = require('./backup');
const transformInstr = require('./transform/instructions');
const transformAgent = require('./transform/agent');
const transformSkill = require('./transform/skill');
const telemetry = require('./telemetry');
const maintenance = require('./maintenance');
const usagelog = require('./usagelog');
const synclog = require('./synclog');
const store = require('./store');
const registry = require('./registry');
const category = require('./category');
const search = require('./search');
const playground = require('./playground');
const projects = require('./projects');

const CANON_ID = 'instr-global'; // 슬라이스: 글로벌 지시문 1개

// ================= 로컬 자동 카테고리화 (표시용 — 디스크 쓰기 없음) =================
// canonical 메타가 없어 태그가 빈 항목이 대부분이므로(스킬 ~700행), 매트릭스 행 생성 시
// 이름(+메모리에 있으면 설명)에 skill-tags.json 키워드 규칙을 적용해 카테고리를 파생한다.
// 순수 계산: canonical/디스크에 쓰지 않고 행에 autoTags로만 실어 UI가 은은하게 표시한다.
// 성능: 소문자 includes 수준의 매칭만(파일 본문 추가 읽기 금지). 키워드 정의는 1회 로드 후 캐시.

let _autoTagDefsCache = null;
function autoTagDefs() {
  if (_autoTagDefsCache) return _autoTagDefsCache;
  let defs = [];
  try {
    const file = path.join(path.dirname(paths.catalogPath()), 'skill-tags.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && Array.isArray(data.tags)) {
      defs = data.tags.map((t) => ({
        key: String(t.key),
        // 키워드(영어) + 라벨(ko/en) + 키 자체를 매칭 후보로. 모두 소문자.
        keywords: []
          .concat(Array.isArray(t.keywords) ? t.keywords : [])
          .concat([t.key, t.en, t.ko].filter(Boolean))
          .map((k) => String(k).toLowerCase())
          .filter((k) => k.length >= 2),
      }));
    }
  } catch {
    defs = []; // 파일 없거나 깨짐 → 자동분류 스킵(우아한 실패)
  }
  _autoTagDefsCache = defs;
  return _autoTagDefsCache;
}

// 이름(+설명)에서 skill-tags 키워드를 소문자 includes로 매칭해 카테고리 key 배열을 파생.
// 순수함수. 중복 제거·정의 순서 보존.
function deriveAutoTags(name, description) {
  const defs = autoTagDefs();
  if (!defs.length) return [];
  const hay = (String(name || '') + ' ' + String(description || '')).toLowerCase();
  if (!hay.trim()) return [];
  const out = [];
  for (const def of defs) {
    if (def.keywords.some((kw) => hay.includes(kw))) out.push(def.key);
  }
  return out;
}

// PI 게이트는 D33으로 제거 — 로컬 전용·사용자 본인만 열람하므로 본문 개인정보
// 확인 절차가 불필요(외부 통신 없음). 파일 경로 기반 거부목록(security.isDenied)만 유지.

// canonical 저장소에 변경 커밋 (로컬 전용). 미초기화/변경없음이면 조용히 넘어감.
// 주의: canonical 폴더 "자체"가 git 저장소일 때만 커밋한다. 자체 저장소가 아니면
// rev-parse가 상위(프로젝트) 저장소에서 성공해 add -A가 저장소 전체를 커밋해버리므로
// toplevel == canonicalRoot 을 확인하고, add도 canonical 하위로만 한정한다.
function gitCommit(message) {
  const cwd = paths.canonicalRoot();
  let top;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return;
  }
  try {
    if (path.resolve(fs.realpathSync(top)) !== path.resolve(fs.realpathSync(cwd))) return;
  } catch {
    return;
  }
  try {
    execFileSync('git', ['add', '-A', '--', '.'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', message], { cwd, stdio: 'ignore' });
  } catch {
    /* 변경 없음 등 무시 */
  }
}

// ================= 프로젝트 레지스트리 (T2) =================
// 로직은 cli/projects.js 단일 소스 — 여기는 위임 래퍼만 둔다.

// 등록된 프로젝트 목록. 각 항목에 exists(디스크에 root가 실제로 있는지)를 덧붙인다 —
// UI가 "이미 없는 프로젝트"를 표시/정리할 수 있게(stat만, 내용 안 읽음).
function projectsList() {
  return {
    projects: projects.list().map((p) => ({ ...p, exists: projects.rootExists(p.root) })),
  };
}

// 디스크에서 사라진 프로젝트(root 미존재)를 레지스트리에서 정리한다. 반환 { removed:[...], remaining:N }.
function projectsPrune() {
  return projects.prune();
}

// 디스크 스캔(존재/이름만) — 후보 반환만 하고 자동 등록하지 않는다.
// root 미지정 시 기본 루트 = 사용자 홈.
function projectsScan({ root } = {}) {
  const scanRoot = root || paths.projectScanDefaultRoot();
  const known = new Set(projects.list().map((p) => p.root));
  const candidates = projects
    .scan(scanRoot)
    .map((c) => ({ ...c, registered: known.has(c.root) }));
  return { root: scanRoot, candidates };
}

// scan 결과(후보)를 레지스트리에 병합 — 사용자가 명시적으로 채택할 때만.
function projectsAdopt({ candidates } = {}) {
  return projects.adoptScan(candidates || []);
}

function projectsAdd({ root }) {
  if (!root) throw new Error('root 경로가 필요합니다');
  return projects.add(root);
}

function projectsRemove({ root }) {
  if (!root) throw new Error('root 경로가 필요합니다');
  return projects.remove(root);
}

// 레지스트리 초기화(과제1): projects.json을 비우고 기본 루트(paths.projectScanDefaultRoot)를
// 재스캔해 후보 전체를 adopt한다. 반환 { reset:true, adopted:N }.
//  - 격리: projects.save/load/scan/adoptScan은 paths.projectsFile() 아래에서만 동작 —
//    AAD_CANONICAL 오버라이드로 실제 canonical과 완전히 분리 검증 가능.
//  - scan은 AAD 저장소 내부 경로 제외 규칙(projects.scan)을 그대로 상속해 스캔 오염을 막는다.
function projectsReset() {
  projects.save({ version: 1, projects: [] }); // 레지스트리 비우기
  const candidates = projects.scan(paths.projectScanDefaultRoot());
  const r = projects.adoptScan(candidates); // 후보 전체 재등록(비었으므로 known 없음 → 전량)
  return { reset: true, adopted: r.adopted };
}

// 자동 발견 (UX-E1): 레지스트리(projects.json)가 비어 있을 때만 1회 스캔 후 자동 등록.
//  - 비어 있지 않으면 아무것도 하지 않는다("최초 1회만 스캔" 결정 유지, D27-③).
//  - 트리거는 사용자가 매트릭스 화면을 여는 것(자동 폴링 아님, D14 정합).
//  - 반환: { scanned:boolean, adopted:number }.
function projectsEnsureScanned() {
  if (projects.list().length > 0) return { scanned: false, adopted: 0 };
  const candidates = projects.scan(paths.projectScanDefaultRoot());
  const r = projects.adoptScan(candidates);
  return { scanned: true, adopted: r.adopted };
}

// (보안 가드) 등록된 프로젝트만 pull 소스로 허용 — 임의 경로 읽기를 코드로 차단.
function requireRegisteredProject(root) {
  const abs = path.resolve(root);
  const found = projects.list().find((p) => p.root === abs);
  if (!found) throw new Error('등록되지 않은 프로젝트입니다 (먼저 aad projects add --root <path>): ' + abs);
  return abs;
}

// 하이브리드: 존재만 (내용 안 읽음) + canonical 존재 여부
function overview() {
  const items = scanner.discoverInstructions().map((it) => ({
    id: it.id,
    type: it.type,
    scope: it.scope,
    tool: it.tool,
    name: it.name,
    exists: it.exists,
  }));
  // T2: 등록 프로젝트의 지시문은 "존재 여부만" 별도 필드로 노출.
  // items에 합치지 않는 이유: 지시문 트랙은 단일 canonical(instr-global) 구조라
  // 기존 소비자(status drift 계산·대시보드 카운트)가 items=글로벌 전제를 갖는다.
  // 프로젝트 지시문의 pull/push는 이번 범위 밖 — 표시 전용.
  const projectItems = scanner.discoverProjectInstructions().map((it) => ({
    id: it.id,
    type: it.type,
    scope: it.scope,
    projectRoot: it.projectRoot,
    tool: it.tool,
    name: it.name,
    exists: it.exists,
  }));
  const canon = canonical.read(CANON_ID);
  return {
    canonId: CANON_ID,
    canonicalExists: !!canon,
    source: canon ? canon.meta.source_tool : null,
    items,
    projectItems,
  };
}

// 클릭 시: 특정 도구 배포본과 canonical의 drift (내용 읽기 — 사용자 동작)
function diffFor(tool) {
  if (!paths.TOOLS.includes(tool)) throw new Error('알 수 없는 도구: ' + tool);
  const canon = canonical.read(CANON_ID);
  if (!canon) return { canonicalExists: false };
  const target = paths.instructionPath(tool);
  const deployed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const d = diff.lineDiff(canon.body, deployed);
  return {
    canonicalExists: true,
    tool,
    exists: fs.existsSync(target),
    targetPath: target,
    diff: d,
    hasChanges: diff.hasChanges(d),
  };
}

// import: 도구 지시문 → canonical. (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람.)
function pull({ from }) {
  if (!paths.TOOLS.includes(from)) throw new Error('알 수 없는 도구: ' + from);
  const item = scanner.discoverInstructions().find((i) => i.tool === from);
  if (!item.exists) throw new Error(`${from}의 지시문 파일이 없습니다: ${item.path}`);

  const { text } = scanner.readItemContent(item);
  const meta = canonical.write(CANON_ID, text, { sourceTool: from });
  gitCommit(`pull: ${from} → canonical (${CANON_ID})`);
  return { imported: true, meta };
}

// sync: canonical → 도구. apply=false면 미리보기(diff)만, true면 백업 후 쓰기.
function push({ to, apply }) {
  if (!paths.TOOLS.includes(to)) throw new Error('알 수 없는 도구: ' + to);
  const canon = canonical.read(CANON_ID);
  if (!canon) throw new Error('canonical이 비어 있습니다. 먼저 pull 하세요.');

  const rendered = transformInstr.render(canon.body, to);
  const deployed = fs.existsSync(rendered.targetPath)
    ? fs.readFileSync(rendered.targetPath, 'utf8')
    : '';
  const d = diff.lineDiff(deployed, rendered.body);

  if (!apply) {
    return {
      applied: false,
      to,
      targetPath: rendered.targetPath,
      diff: d,
      hasChanges: diff.hasChanges(d),
      losses: rendered.losses,
    };
  }
  const backupPath = backup.backupFile(rendered.targetPath, to, { kind: 'instruction', item: CANON_ID });
  fs.mkdirSync(path.dirname(rendered.targetPath), { recursive: true });
  fs.writeFileSync(rendered.targetPath, rendered.body);
  synclog.recordPush(to);
  return { applied: true, to, targetPath: rendered.targetPath, backupPath, losses: rendered.losses };
}

// ================= agent 트랙 =================

// (F5) 에이전트 파일에서 "참조 스킬" 이름 목록을 파싱한다(공식 메커니즘, F0 검증).
//  - Claude(.md): frontmatter `skills:` (배열 또는 콤마/공백 구분 문자열).
//  - Codex(.toml): `skills` 배열 또는 `skills.config` 유사 키(있으면). tools가 tool별로 없듯
//    codex 에이전트에 skills가 없을 수 있으므로 파악 가능한 형태만 취한다(없으면 []).
// 반환: 정규화된(중복 제거·트림) 스킬 이름 문자열 배열. 파싱 실패는 [](우아한 실패).
function parseReferencedSkills(text, tool) {
  if (text == null) return [];
  const toList = (v) => {
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return v.split(/[\s,]+/);
    return [];
  };
  let raw = [];
  try {
    if (tool === 'codex') {
      const data = TOML.parse(text) || {};
      // codex는 skills 배열 또는 skills.config(테이블/문자열) 두 형태를 모두 시도.
      raw = toList(data.skills);
      if (!raw.length && data.skills && typeof data.skills === 'object' && !Array.isArray(data.skills)) {
        raw = toList(data.skills.config).concat(toList(data.skills.names));
      }
    } else {
      const fm = matter(text).data || {};
      raw = toList(fm.skills);
    }
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    const name = String(s == null ? '' : s).trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}
// (F5) 도구별 agent 폴더(글로벌)가 로컬에 실제로 존재하는지 — 매트릭스 응답에 실어
// "미사용(폴더 없음)"과 "있음(행 없음)"을 UI가 구분하게 한다.
function agentToolDirs() {
  const dirs = {};
  for (const tool of paths.TOOLS) {
    try {
      dirs[tool] = fs.existsSync(paths.agentDir(tool));
    } catch {
      dirs[tool] = false;
    }
  }
  return dirs;
}

// 개요: canonical agent 목록 + 도구별 발견(존재) + 비표준 파일
function agentOverview() {
  const disc = scanner.discoverAgents();
  return {
    canonicalAgents: canonical.listAgents().map((a) => ({
      id: a.id,
      name: a.name,
      tools: a.tools || [],
      source_tool: a.source_tool,
      tags: a.tags || [],
      // T2: 프로젝트에서 pull한 항목 표시 (글로벌 항목은 필드 없음 → JSON에서 생략됨)
      scope: a.scope,
      project_root: a.project_root,
    })),
    toolAgents: disc.agents, // {tool, name, ...}
    nonStandard: disc.nonStandard,
  };
}

// import: 도구의 agent 파일 → canonical 중립 스키마. (PI 게이트는 D33으로 제거.)
// T2: projectRoot가 있으면 "등록된 프로젝트"의 agent 폴더에서 읽는다 (미등록 경로는 거부).
function agentPull({ from, name, projectRoot }) {
  if (!paths.TOOLS.includes(from)) throw new Error('알 수 없는 도구: ' + from);
  const projRoot = projectRoot ? requireRegisteredProject(projectRoot) : null;
  const filePath = projRoot
    ? path.join(paths.projectAgentDir(projRoot, from), name + paths.agentExt(from))
    : paths.agentPath(from, name);
  if (!fs.existsSync(filePath)) throw new Error(`agent 파일이 없습니다: ${filePath}`);

  const { text } = scanner.readItemContent({ path: filePath });
  const neutral = transformAgent.parse(text, from, name);
  // 프로젝트 출처 표기 — writeAgent는 중립 스키마를 spread로 보존하므로 여기서 필드만 더한다.
  if (projRoot) {
    neutral.scope = 'project';
    neutral.project_root = projRoot;
  } else {
    neutral.scope = 'global';
  }
  const record = canonical.writeAgent(neutral);
  gitCommit(`pull agent: ${projRoot ? projRoot + ':' : ''}${from}/${name} → canonical (${record.id})`);
  return { imported: true, agent: record };
}

// 미리보기: canonical agent → 특정 도구 렌더 결과(diff + 손실)
function agentDiff(id, to) {
  const neutral = canonical.readAgent(id);
  if (!neutral) return { canonicalExists: false };
  const rendered = transformAgent.render(neutral, to);
  const target = paths.agentPath(to, neutral.name);
  const deployed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const d = diff.lineDiff(deployed, rendered.content);
  return {
    canonicalExists: true,
    to,
    targetPath: target,
    diff: d,
    hasChanges: diff.hasChanges(d),
    losses: rendered.losses,
  };
}

// sync: canonical agent → 도구. apply=false면 미리보기, true면 백업 후 쓰기.
// T3(스코프 인지): projectRoot가 주어지면 대상 디렉토리만 그 프로젝트의 agent 위치로 바꾼다.
//   (등록된 프로젝트만 허용 — 임의 경로 쓰기 차단.) 백업·synclog·미리보기 로직은 그대로 상속.
function agentPush({ id, to, apply, projectRoot }) {
  if (!paths.TOOLS.includes(to)) throw new Error('알 수 없는 도구: ' + to);
  const neutral = canonical.readAgent(id);
  if (!neutral) throw new Error('canonical에 해당 agent가 없습니다: ' + id);
  const rendered = transformAgent.render(neutral, to);
  const projRoot = projectRoot ? requireRegisteredProject(projectRoot) : null;
  const target = projRoot
    ? path.join(paths.projectAgentDir(projRoot, to), neutral.name + paths.agentExt(to))
    : paths.agentPath(to, neutral.name);
  const deployed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const d = diff.lineDiff(deployed, rendered.content);

  if (!apply) {
    return { applied: false, to, targetPath: target, diff: d, hasChanges: diff.hasChanges(d), losses: rendered.losses };
  }
  const backupPath = backup.backupFile(target, to, { kind: 'agent', item: neutral.name });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, rendered.content);
  synclog.recordPush(to);
  return { applied: true, to, targetPath: target, backupPath, losses: rendered.losses };
}

// ================= skill 트랙 =================

// 개요: canonical skill 목록 + 도구별 발견(존재). 비공식 소스는 official:false로 표시(D11).
function skillOverview() {
  const discovered = scanner.discoverSkills();
  return {
    canonicalSkills: canonical.listSkills().map((s) => ({
      id: s.id,
      name: s.name,
      source_tool: s.source_tool,
      official: s.official,
      tags: s.tags || [],
      // T2: 프로젝트에서 pull한 항목 표시 (글로벌 항목은 필드 없음 → JSON에서 생략됨)
      scope: s.scope,
      project_root: s.project_root,
    })),
    toolSkills: discovered, // {name, tool, source_id, official, shared, plugin, path}
    // 비공식 위치의 skill은 별도로 모아 사용자에게 알릴 수 있게 한다
    unofficial: discovered.filter((s) => s.official === false),
  };
}

// import: 도구의 skill(SKILL.md) → canonical. name으로 첫 매칭 소스를 쓴다. (PI 게이트는 D33으로 제거.)
// T2: projectRoot가 있으면 "등록된 프로젝트"의 소스로 좁힌다 (글로벌이 목록 앞이라 기본 동작 불변).
function skillPull({ name, source_id, projectRoot }) {
  let matches = scanner.discoverSkills().filter((s) => s.name === name);
  if (!matches.length) throw new Error(`skill을 찾을 수 없습니다: ${name}`);
  if (projectRoot) {
    const projRoot = requireRegisteredProject(projectRoot);
    matches = matches.filter((s) => s.projectRoot === projRoot);
    if (!matches.length) throw new Error(`해당 프로젝트에 skill이 없습니다: ${name} (${projRoot})`);
  }
  // source_id가 주어지면 그 소스, 아니면 첫 매칭
  const item = source_id ? matches.find((s) => s.source_id === source_id) : matches[0];
  if (!item) throw new Error(`해당 소스에 skill이 없습니다: ${name} (${source_id})`);

  const { text } = scanner.readItemContent({ path: item.path });
  const meta = canonical.writeSkill(name, text, {
    source_id: item.source_id,
    source_tool: item.tool,
    official: item.official,
    // 프로젝트 출처 표기 — 글로벌 pull은 scope:'global' + project_root 제거(null)로 정리.
    scope: item.scope === 'project' ? 'project' : 'global',
    project_root: item.scope === 'project' ? item.projectRoot : null,
  });
  gitCommit(`pull skill: ${item.source_id}/${name} → canonical`);
  return { imported: true, skill: meta, unofficialSource: item.official === false };
}

// 미리보기: canonical skill → 특정 도구로 복사할 결과(diff)
function skillDiff(name, to) {
  const canon = canonical.readSkill(name);
  if (!canon) return { canonicalExists: false };
  const rendered = transformSkill.render(canon.body, name, to);
  const deployed = fs.existsSync(rendered.targetPath) ? fs.readFileSync(rendered.targetPath, 'utf8') : '';
  const d = diff.lineDiff(deployed, rendered.content);
  return {
    canonicalExists: true,
    to,
    targetPath: rendered.targetPath,
    diff: d,
    hasChanges: diff.hasChanges(d),
    losses: rendered.losses,
  };
}

// 프로젝트 스코프의 skill push 대상 디렉토리 — projectSkillSources와 대칭.
//   claude → <root>/.claude/skills, codex → <root>/.agents/skills(공유 표준 위치).
function projectSkillTargetDir(root, tool) {
  if (tool === 'claude') return path.join(root, '.claude', 'skills');
  if (tool === 'codex') return path.join(root, '.agents', 'skills');
  throw new Error('알 수 없는 도구: ' + tool);
}

// sync: canonical skill → 도구. apply=false면 미리보기, true면 백업 후 쓰기.
// T3(스코프 인지): projectRoot가 주어지면 대상 경로만 그 프로젝트의 skill 위치(<root>/.claude/skills,
//   <root>/.agents/skills)로 바꾼다(등록된 프로젝트만 허용). 백업·synclog·미리보기 로직은 그대로 상속.
function skillPush({ name, to, apply, projectRoot }) {
  const canon = canonical.readSkill(name);
  if (!canon) throw new Error('canonical에 해당 skill이 없습니다: ' + name);
  const rendered = transformSkill.render(canon.body, name, to);
  if (projectRoot) {
    const projRoot = requireRegisteredProject(projectRoot);
    rendered.targetPath = path.join(projectSkillTargetDir(projRoot, to), name, 'SKILL.md');
  }
  const deployed = fs.existsSync(rendered.targetPath) ? fs.readFileSync(rendered.targetPath, 'utf8') : '';
  const d = diff.lineDiff(deployed, rendered.content);
  if (!apply) {
    return { applied: false, to, targetPath: rendered.targetPath, diff: d, hasChanges: diff.hasChanges(d), losses: rendered.losses };
  }
  const backupPath = backup.backupFile(rendered.targetPath, to, { kind: 'skill', item: name });
  fs.mkdirSync(path.dirname(rendered.targetPath), { recursive: true });
  fs.writeFileSync(rendered.targetPath, rendered.content);
  synclog.recordPush(to);
  return { applied: true, to, targetPath: rendered.targetPath, backupPath, losses: rendered.losses };
}

// ================= 한 번에 동기화(Sync) — UX-A =================
// 사용자가 "미등록 소스"에서 [Sync]를 명시적으로 누른 항목이므로 각 도구 사본의
// 내용을 읽어 비교해도 된다(D9: 클릭 시 읽기). 실제 쓰기는 syncApply만 하고,
// 그 쓰기는 전부 기존 pull/push 함수 경유 → PI 게이트·백업·synclog·gitCommit 자동 상속.
// 새 쓰기 경로는 만들지 않는다.

function contentHash(text) {
  return crypto.createHash('sha256').update(text == null ? '' : text, 'utf8').digest('hex').slice(0, 12);
}

// agent "내용 동일" 판정 = 비교 대상 필드만 정규화한 JSON 해시.
// syncPlan(agentSyncPlan)과 syncMatrix가 공유한다(단일 규칙).
function agentNeutralKey(n) {
  return contentHash(
    JSON.stringify({
      name: n.name || '',
      description: n.description || '',
      system_prompt: n.system_prompt || '',
      model: n.model || null,
      tools: [...(n.tools || [])].sort(),
    })
  );
}

// skill 동기화의 "도구 슬롯" = push 대상과 대칭인 3개 위치.
//  - claude → ~/.claude/skills(claude-user)
//  - codex  → .agents/skills(shared-agents, discoverSkills에선 tool='shared')
// discoverSkills가 돌려준 항목 중 위 공식 소스만 도구 슬롯에 매핑한다.
// (플러그인/비공식/프로젝트 소스는 baseCandidate가 아니라 notes로만 알린다.)
const SKILL_TOOL_SOURCE = { claude: 'claude-user', codex: 'shared-agents' };
// 프로젝트 스코프 slot(=projectSkillSources와 대칭). skillMatrix의 PROJECT_SLOT과 동일.
const SKILL_PROJECT_SOURCE = { claude: 'claude-project', codex: 'shared-project' };

// scope 정규화: 미지정/'global'이면 'global', 그 외(프로젝트 root)는 등록 프로젝트로 검증한 절대경로.
//   기존 호출(scope 없음)은 'global'로 동작 → 하위호환.
function normalizeScope(scope) {
  if (!scope || scope === 'global') return 'global';
  return requireRegisteredProject(scope);
}

// (1) 동기화 계획 — 읽기 전용(디스크 쓰기 0). kind: 'skill'|'agent'.
//   scope: 'global'(기본) 또는 등록된 프로젝트 root. 지정 시 그 스코프의 소스만 그룹핑.
function syncPlan({ kind, name, scope }) {
  const sc = normalizeScope(scope);
  if (kind === 'skill') return skillSyncPlan(name, sc);
  if (kind === 'agent') return agentSyncPlan(name, sc);
  throw new Error('알 수 없는 kind: ' + kind + " ('skill'|'agent')");
}

// skill: 도구별 SKILL.md 내용 해시로 그룹핑. canonical 동명 항목도 참고 정보로 포함.
//   scope='global'이면 글로벌 슬롯(SKILL_TOOL_SOURCE), 프로젝트 root면 그 프로젝트 슬롯만 대상.
function skillSyncPlan(name, scope = 'global') {
  if (!name) throw new Error('name이 필요합니다');
  const isProject = scope !== 'global';
  const slotMap = isProject ? SKILL_PROJECT_SOURCE : SKILL_TOOL_SOURCE;
  // 이 스코프에 해당하는 발견 항목만 판정 대상. (프로젝트면 그 root, 글로벌이면 scope!=='project')
  const inScope = (s) => (isProject ? s.scope === 'project' && s.projectRoot === scope : s.scope !== 'project');
  const discovered = scanner.discoverSkills().filter((s) => s.name === name);
  const canon = canonical.readSkill(name);
  const canonicalExists = !!canon;
  const canonicalHash = canonicalExists ? contentHash(canon.body) : null;

  // 내용 → 그룹 번호(1부터). canonical 내용도 같은 사전에 넣어 "같은 그룹"이면 도구=canonical.
  const groupOf = new Map();
  let nextGroup = 0;
  function assignGroup(h) {
    if (!groupOf.has(h)) groupOf.set(h, ++nextGroup);
    return groupOf.get(h);
  }
  if (canonicalExists) assignGroup(canonicalHash);

  const tools = paths.TOOLS.map((tool) => {
    const sourceId = slotMap[tool];
    // 이 도구 슬롯(선택 스코프의 공식 push 대상)에 실제로 발견된 skill
    const official = discovered.find((s) => s.source_id === sourceId && inScope(s));
    const notes = [];
    // 이번 동기화 대상(선택 scope의 이 도구 슬롯)이 아닌 "다른 위치"에 같은 이름이 있을 때만 알린다.
    //   자기 자신(선택 scope의 이 슬롯 파일)은 notes에 넣지 않는다.
    for (const s of discovered) {
      if (s.source_id === sourceId && inScope(s)) continue; // 자기 자신 — 스킵
      notes.push(`다른 위치에도 같은 이름이 있습니다(이번 동기화와 무관): ${s.path}`);
    }
    if (!official) {
      return { tool, exists: false, sourceId, official: true, group: null, notes };
    }
    const { text } = scanner.readItemContent({ path: official.path });
    const group = assignGroup(contentHash(text));
    return {
      tool,
      exists: true,
      sourceId: official.source_id,
      official: official.official !== false,
      scope: official.scope || 'global',
      group,
      notes,
    };
  });

  const baseCandidates = tools.filter((t) => t.exists).map((t) => t.tool);
  return {
    kind: 'skill',
    name,
    scope,
    canonicalExists,
    canonicalGroup: canonicalExists ? groupOf.get(canonicalHash) : null,
    tools,
    groups: groupOf.size,
    baseCandidates,
    // 스킬은 도구 간 변환 손실이 없다(SKILL.md 복사) → perBaseLosses는 빈 요약.
    perBaseLosses: Object.fromEntries(baseCandidates.map((t) => [t, {}])),
  };
}

// agent: 도구별 파일 파싱(transform 재사용) 후 중립 스키마 비교 + 기준별 변환 손실.
//   scope='global'이면 글로벌 agent, 프로젝트 root면 그 프로젝트의 agent만 대상.
function agentSyncPlan(name, scope = 'global') {
  if (!name) throw new Error('name이 필요합니다');
  const isProject = scope !== 'global';
  const id = 'agent-' + name;
  const inScope = (a) => (isProject ? a.scope === 'project' && a.projectRoot === scope : a.scope !== 'project');
  const disc = scanner.discoverAgents().agents.filter((a) => a.name === name && inScope(a));
  const canonNeutral = canonical.readAgent(id);
  const canonicalExists = !!canonNeutral;

  // 중립 스키마의 "내용 동일" 판정은 agentNeutralKey(모듈 공유)로 위임.
  const neutralKey = agentNeutralKey;
  const groupOf = new Map();
  let nextGroup = 0;
  function assignGroup(h) {
    if (!groupOf.has(h)) groupOf.set(h, ++nextGroup);
    return groupOf.get(h);
  }
  if (canonicalExists) assignGroup(neutralKey(canonNeutral));

  // 각 도구별로 파싱한 중립 스키마를 담아둔다(perBaseLosses 계산에 재사용).
  const parsedByTool = {};
  const tools = paths.TOOLS.map((tool) => {
    const found = disc.find((a) => a.tool === tool);
    const notes = [];
    if (!found) {
      // Codex는 에이전트별 tools 필드가 없다는 구조적 특이사항을 미리 알린다.
      if (tool === 'codex') notes.push('codex는 에이전트별 tools 필드가 없음 → tools는 codex로 내보낼 때 손실');
      return { tool, exists: false, group: null, notes };
    }
    const { text } = scanner.readItemContent({ path: found.path });
    const neutral = transformAgent.parse(text, tool, name);
    parsedByTool[tool] = neutral;
    const group = assignGroup(neutralKey(neutral));
    if (tool === 'codex') notes.push('codex 파일은 tools 필드가 없어 tools 정보가 없음(중립 스키마 tools=[])');
    if (neutral.source_notes) notes.push(neutral.source_notes);
    return { tool, exists: true, scope: found.scope || 'global', group, notes };
  });

  const baseCandidates = tools.filter((t) => t.exists).map((t) => t.tool);
  // 각 후보를 기준으로 삼았을 때, 다른 도구로 render 시 생기는 손실 요약.
  const perBaseLosses = {};
  for (const base of baseCandidates) {
    const neutral = parsedByTool[base];
    const losses = {};
    for (const target of paths.TOOLS) {
      if (target === base) continue;
      losses[target] = transformAgent.render(neutral, target).losses;
    }
    perBaseLosses[base] = losses;
  }

  return {
    kind: 'agent',
    name,
    scope,
    canonicalExists,
    canonicalGroup: canonicalExists ? groupOf.get(neutralKey(canonNeutral)) : null,
    tools,
    groups: groupOf.size,
    baseCandidates,
    perBaseLosses,
  };
}

// (2) 동기화 실행 — pull(기준→canonical) + push(나머지 도구, 내용 다르거나 없으면).
//  모든 쓰기는 기존 skillPull/agentPull/skillPush/agentPush 경유.
//  (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람.)
//  T3(스코프 인지): scope='global'(기본) 또는 등록 프로젝트 root. pull/push 모두 그 스코프의
//   경로를 읽고 쓴다 — pull은 projectRoot 파라미터, push는 projectRoot 옵션으로 대상 디렉토리만 이동.
//   (백업·synclog·gitCommit은 기존 guarded 함수에서 그대로 상속. 새 쓰기 경로 없음.)
function syncApply({ kind, name, baseTool, scope, sourceId }) {
  if (kind !== 'skill' && kind !== 'agent') throw new Error("알 수 없는 kind: " + kind + " ('skill'|'agent')");
  if (!name) throw new Error('name이 필요합니다');
  if (!paths.TOOLS.includes(baseTool)) throw new Error('기준 도구가 올바르지 않습니다(baseTool): ' + baseTool);
  const sc = normalizeScope(scope); // 'global' | 검증된 프로젝트 root
  const isProject = sc !== 'global';
  const projectRoot = isProject ? sc : undefined; // pull/push에 전달할 값(글로벌이면 undefined → 기존 동작)

  const plan = syncPlan({ kind, name, scope: sc });
  const baseSlot = plan.tools.find((t) => t.tool === baseTool);
  if (!baseSlot || !baseSlot.exists) {
    throw new Error(`기준 도구(${baseTool})에 ${kind} "${name}"가 없습니다(scope: ${sc}). baseCandidates: [${plan.baseCandidates.join(', ')}]`);
  }

  // 1) pull: 기준 도구 → canonical (기존 함수 재사용 — gitCommit 상속)
  //   프로젝트 스코프면 기준 소스도 그 프로젝트 슬롯(claude-project/shared-project)에서 읽는다.
  let pulled;
  if (kind === 'skill') {
    const defaultSource = isProject ? SKILL_PROJECT_SOURCE[baseTool] : SKILL_TOOL_SOURCE[baseTool];
    const r = skillPull({ name, source_id: sourceId || defaultSource, projectRoot });
    pulled = { from: baseTool, kind: 'skill', name, source_tool: r.skill.source_tool, unofficialSource: r.unofficialSource };
  } else {
    const r = agentPull({ from: baseTool, name, projectRoot });
    pulled = { from: baseTool, kind: 'agent', id: r.agent.id, source_tool: r.agent.source_tool };
  }

  // pull 이후의 canonical 내용으로 나머지 도구와 비교(기준 자신은 skip). 대상 경로는 선택 스코프.
  const results = [];
  for (const tool of paths.TOOLS) {
    if (tool === baseTool) continue;
    try {
      const preview = kind === 'skill'
        ? skillPush({ name, to: tool, apply: false, projectRoot })
        : agentPush({ id: 'agent-' + name, to: tool, apply: false, projectRoot });
      if (!preview.hasChanges) {
        // canonical과 내용 동일(대상이 이미 존재하고 같음) → skip
        results.push({ tool, action: 'skipped_same', targetPath: preview.targetPath, losses: preview.losses });
        continue;
      }
      const applied = kind === 'skill'
        ? skillPush({ name, to: tool, apply: true, projectRoot })
        : agentPush({ id: 'agent-' + name, to: tool, apply: true, projectRoot });
      results.push({ tool, action: 'pushed', targetPath: applied.targetPath, backup: applied.backupPath, losses: applied.losses });
    } catch (e) {
      // 부분 실패: 중단하지 말고 도구별 결과로 기록.
      results.push({ tool, action: 'error', error: e.message });
    }
  }
  return { pulled, scope: sc, results };
}

// ================= 동기화 매트릭스 (UX-E1) =================
// D27: 화면의 주인공 = "홈(~)과 각 프로젝트의 스킬·에이전트가 서로 동기화되어 있는가".
// 행 = (scope, name). scope = 'global'(전역 ~) 또는 등록 프로젝트 root.
// 각 행은 2개 도구(claude/codex) 슬롯의 존재/내용해시그룹 + 동기화 상태를 담는다.
//
// 읽기 전용(디스크 쓰기 0). 로컬 파일이므로 표 로드 시 그대로 읽어 해시 계산(캐시 불필요, D27-④).
// 파일 읽기 실패는 "행 단위 error"로 우아하게 표면화하고 전체는 계속 계산한다(D26-② 우아한 실패).

// scope 라벨: 전역은 '전역(~)', 프로젝트는 '폴더명 (전체경로)'.
function scopeLabelFor(scope) {
  if (scope === 'global') return '전역(~)';
  return path.basename(scope) + ' (' + scope + ')';
}

// canonical 메타의 동명 항목 태그를 우선, 없으면 파일 frontmatter의 tags(있을 때만).
function skillTagsFor(name, fallbackText) {
  const canon = canonical.readSkill(name);
  if (canon && Array.isArray(canon.meta.tags) && canon.meta.tags.length) return canon.meta.tags;
  if (fallbackText != null) {
    try {
      const fm = matter(fallbackText).data || {};
      if (Array.isArray(fm.tags) && fm.tags.length) return fm.tags;
    } catch {
      /* frontmatter 파싱 실패 — 태그 없음으로 취급 */
    }
  }
  return [];
}
function agentTagsFor(name, fallbackNeutral) {
  const canon = canonical.readAgent('agent-' + name);
  if (canon && Array.isArray(canon.tags) && canon.tags.length) return canon.tags;
  if (fallbackNeutral && Array.isArray(fallbackNeutral.tags) && fallbackNeutral.tags.length) {
    return fallbackNeutral.tags;
  }
  return [];
}

// 세 도구 슬롯의 group(내용 그룹 번호)으로 동기화 상태를 판정한다.
//  - synced : 3도구 모두 존재 + 같은 그룹
//  - drift  : 존재하는 것 중 서로 다른 그룹이 섞임(내용 다름)
//  - partial: 일부 도구에만 있지만 있는 것끼리는 동일
//  - single : 1곳만 존재
function syncStateOf(toolSlots) {
  const present = paths.TOOLS.map((t) => toolSlots[t]).filter((s) => s && s.exists && s.group != null);
  if (present.length === 0) return 'single'; // (이론상 매트릭스에 안 올라오지만 방어적으로)
  if (present.length === 1) return 'single';
  const groups = new Set(present.map((s) => s.group));
  if (groups.size > 1) return 'drift';
  // 그룹 1개(있는 것끼리 동일) → 3도구 모두면 synced, 일부면 partial
  return present.length === paths.TOOLS.length ? 'synced' : 'partial';
}

// ── skill 매트릭스 ──
// scope 슬롯: global은 SKILL_TOOL_SOURCE(공식 push 대상)와 대칭.
//             project는 projectSkillSources(claude/shared)와 대칭.
// codex 열은 shared(.agents/skills) 소스를 매핑한다(push 대칭과 동일, syncPlan과 정합).
function skillMatrix() {
  const discovered = scanner.discoverSkills();

  // 행 키 = scope|name. scope = 'global' | projectRoot.
  // 각 (scope,name)에 대해 도구 슬롯을 채운다.
  //  - global 슬롯 매핑: claude→claude-user, codex→shared-agents
  //  - project 슬롯 매핑: claude→claude-project, codex→shared-project
  const GLOBAL_SLOT = { claude: 'claude-user', codex: 'shared-agents' };
  const PROJECT_SLOT = { claude: 'claude-project', codex: 'shared-project' };

  // rows[rowKey] = { scope, name, slotItem:{tool->discovered item} }
  const rows = new Map();
  function rowFor(scope, name) {
    const key = scope + ' ' + name;
    if (!rows.has(key)) rows.set(key, { scope, name, slots: {} });
    return rows.get(key);
  }
  for (const s of discovered) {
    const scope = s.scope === 'project' ? s.projectRoot : 'global';
    const slotMap = scope === 'global' ? GLOBAL_SLOT : PROJECT_SLOT;
    // 이 항목이 어느 도구 열에 속하는지 = source_id로 역매핑.
    const tool = paths.TOOLS.find((t) => slotMap[t] === s.source_id);
    if (!tool) continue; // 플러그인/비공식/codex-native 등 도구 열 밖 소스는 매트릭스 슬롯에 넣지 않음
    const row = rowFor(scope, s.name);
    if (!row.slots[tool]) row.slots[tool] = s; // 첫 매칭만(중복 방지)
  }

  return [...rows.values()].map((row) => buildSkillRow(row));
}

// (개요용) 존재하는 도구 파일들의 mtime 중 최댓값을 ISO 문자열로. 없거나 stat 실패 시 null(throw 금지).
// "지난 1일/7일 내 수정된 스킬 수" 계산의 원천. 순수 계산(디스크 stat만, 본문 안 읽음).
function lastModifiedOf(filePaths) {
  let maxMs = null;
  for (const p of filePaths) {
    if (!p) continue;
    try {
      const ms = fs.statSync(p).mtimeMs;
      if (typeof ms === 'number' && (maxMs == null || ms > maxMs)) maxMs = ms;
    } catch {
      /* stat 실패 슬롯은 무시(우아한 실패) */
    }
  }
  return maxMs == null ? null : new Date(maxMs).toISOString();
}

function buildSkillRow(row) {
  const { scope, name } = row;
  const errors = [];
  // 행별 내용 해시 그룹(존재 사본만). canonical도 참고용으로 같은 사전에 넣는다.
  const groupOf = new Map();
  let nextGroup = 0;
  const assign = (h) => {
    if (!groupOf.has(h)) groupOf.set(h, ++nextGroup);
    return groupOf.get(h);
  };
  const canon = canonical.readSkill(name);
  const canonicalExists = !!canon;
  if (canonicalExists) assign(contentHash(canon.body));

  let anyText = null;
  const tools = {};
  for (const tool of paths.TOOLS) {
    const item = row.slots[tool];
    if (!item) {
      tools[tool] = { exists: false, group: null };
      continue;
    }
    try {
      const { text } = scanner.readItemContent({ path: item.path });
      if (anyText == null) anyText = text;
      tools[tool] = { exists: true, group: assign(contentHash(text)) };
    } catch (e) {
      // 우아한 실패(D26): 이 도구 슬롯만 error, 나머지는 계속.
      tools[tool] = { exists: false, group: null, error: e.message };
      errors.push(tool + ': ' + e.message);
    }
  }
  // 기존 태그는 새 어휘로 변환해 표시(원본 메타는 그대로). 비어 있으면 이름으로 autoTags 파생.
  const rawTags = skillTagsFor(name, anyText);
  const mappedTags = category.mapLegacyTags(rawTags);
  const autoTags = mappedTags.length ? [] : deriveAutoTags(name, '');
  return {
    scope,
    scopeLabel: scopeLabelFor(scope),
    name,
    tags: mappedTags,
    autoTags,
    tools,
    groups: groupOf.size,
    syncState: syncStateOf(tools),
    canonicalExists,
    canonicalGroup: canonicalExists ? groupOf.get(contentHash(canon.body)) : null,
    // 존재하는 도구 파일들의 mtime 중 최댓값(ISO). 개요의 "최근 수정" 카운트용.
    lastModified: lastModifiedOf(paths.TOOLS.map((t) => (row.slots[t] ? row.slots[t].path : null))),
    ...(errors.length ? { error: errors.join(' | ') } : {}),
  };
}

// ── agent 매트릭스 ──
// 도구별 파일을 파싱(transformAgent.parse)해 중립 스키마로 정규화 후 비교(syncPlan과 동일 규칙).
function agentMatrix() {
  const disc = scanner.discoverAgents();
  // 행 키 = scope|name.
  const rows = new Map();
  function rowFor(scope, name) {
    const key = scope + ' ' + name;
    if (!rows.has(key)) rows.set(key, { scope, name, slots: {}, nonstandard: {} });
    return rows.get(key);
  }
  for (const a of disc.agents) {
    const scope = a.scope === 'project' ? a.projectRoot : 'global';
    const row = rowFor(scope, a.name);
    if (!row.slots[a.tool]) row.slots[a.tool] = a; // 도구당 첫 파일
  }
  // (F5) 비표준 실물: 도구가 읽지 않는 위치의 파일(예: ~/.codex/agents/*.md).
  //  스캐너가 nonStandard로 분리한 항목을 그 도구 열에 "비표준" 슬롯으로 얹는다(내용 비교 안 함).
  //  파일명(확장자 제거)을 이름 키로 삼아 같은 이름의 정식 행과 합류시킨다.
  for (const ns of disc.nonStandard) {
    const scope = ns.scope === 'project' ? ns.projectRoot : 'global';
    const nm = ns.file.replace(/\.[^.]+$/, '');
    const row = rowFor(scope, nm);
    if (!row.nonstandard[ns.tool]) row.nonstandard[ns.tool] = ns;
  }
  return [...rows.values()].map((row) => buildAgentRow(row));
}

function buildAgentRow(row) {
  const { scope, name } = row;
  const errors = [];
  const groupOf = new Map();
  let nextGroup = 0;
  const assign = (h) => {
    if (!groupOf.has(h)) groupOf.set(h, ++nextGroup);
    return groupOf.get(h);
  };
  const canonNeutral = canonical.readAgent('agent-' + name);
  const canonicalExists = !!canonNeutral;
  if (canonicalExists) assign(agentNeutralKey(canonNeutral));

  let firstNeutral = null;
  const tools = {};
  // (F5) 참조 스킬: 존재하는 도구 파일들에서 파싱한 스킬 이름의 합집합(중복 제거).
  const refSet = new Set();
  const nonstandard = row.nonstandard || {};
  for (const tool of paths.TOOLS) {
    const item = row.slots[tool];
    if (!item) {
      // (F5) 정식 파일은 없지만 비표준 파일(예: codex/*.md)이 있으면 셀에 표시.
      tools[tool] = nonstandard[tool]
        ? { exists: false, group: null, nonstandard: true }
        : { exists: false, group: null };
      continue;
    }
    try {
      const { text } = scanner.readItemContent({ path: item.path });
      const neutral = transformAgent.parse(text, tool, name);
      if (firstNeutral == null) firstNeutral = neutral;
      for (const s of parseReferencedSkills(text, tool)) refSet.add(s);
      tools[tool] = { exists: true, group: assign(agentNeutralKey(neutral)) };
    } catch (e) {
      tools[tool] = { exists: false, group: null, error: e.message };
      errors.push(tool + ': ' + e.message);
    }
  }
  // 기존 태그는 새 어휘로 변환해 표시. 비어 있으면 이름+설명(메모리에 있으면)으로 autoTags 파생.
  const rawTags = agentTagsFor(name, firstNeutral);
  const mappedTags = category.mapLegacyTags(rawTags);
  const desc = firstNeutral && firstNeutral.description ? firstNeutral.description : '';
  const autoTags = mappedTags.length ? [] : deriveAutoTags(name, desc);
  return {
    scope,
    scopeLabel: scopeLabelFor(scope),
    name,
    tags: mappedTags,
    autoTags,
    tools,
    groups: groupOf.size,
    syncState: syncStateOf(tools),
    canonicalExists,
    canonicalGroup: canonicalExists ? groupOf.get(agentNeutralKey(canonNeutral)) : null,
    referencedSkills: [...refSet],
    // 존재하는 도구 파일들의 mtime 중 최댓값(ISO). 스킬 행과 동일 규칙.
    lastModified: lastModifiedOf(paths.TOOLS.map((t) => (row.slots[t] ? row.slots[t].path : null))),
    ...(errors.length ? { error: errors.join(' | ') } : {}),
  };
}

// (공개) 동기화 매트릭스. kind: 'skill'|'agent'.
//  - 시작 시 projectsEnsureScanned()로 자동 발견(레지스트리 비었을 때만 1회 스캔+등록, D27-③).
//  - 반환: { kind, autoScan:{scanned,adopted}, rows:[...], counts:{synced,partial,drift,single} }.
function syncMatrix({ kind }) {
  if (kind !== 'skill' && kind !== 'agent') {
    throw new Error("알 수 없는 kind: " + kind + " ('skill'|'agent')");
  }
  const autoScan = projectsEnsureScanned();
  const rows = kind === 'skill' ? skillMatrix() : agentMatrix();
  // scope 정렬: 전역 먼저, 그다음 프로젝트 경로순. 같은 scope 내에서는 이름순.
  rows.sort((a, b) => {
    if (a.scope !== b.scope) {
      if (a.scope === 'global') return -1;
      if (b.scope === 'global') return 1;
      return a.scope < b.scope ? -1 : 1;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  const counts = { synced: 0, partial: 0, drift: 0, single: 0 };
  for (const r of rows) counts[r.syncState] = (counts[r.syncState] || 0) + 1;
  // (F5) agent 뷰: 도구별 agent 폴더의 실제 존재 여부를 함께 실어, "미사용(폴더 없음)"과
  //  "폴더는 있으나 이 이름은 없음"을 UI가 구분한다(예: codex 폴더 자체가 없으면 "미사용").
  const toolDirs = kind === 'agent' ? agentToolDirs() : undefined;
  return { kind, autoScan, rows, counts, ...(toolDirs ? { toolDirs } : {}) };
}

// ================= 지시문 매트릭스 / 한 방 동기화 (UX v2 — F2) =================
// D27/UX v2: canonical은 순수 백업이라 지시문 비교 계산에 넣지 않는다(3파일만 비교).
// 해시·그룹·상태 로직은 syncMatrix(buildSkillRow)의 규칙을 그대로 재사용한다(contentHash + 그룹 번호).
// 읽기 실패는 throw하지 않고 해당 모델에 readError로 담아 우아하게 반환한다(D26).

// (1) instrMatrix — 전역 지시문 3파일 비교.
//  - 모델별 { exists, group(내용 해시 그룹 번호|null), readError? } 반환.
//  - 종합 상태(syncState):
//      synced : 셋 다 존재 + 같은 해시(그룹 1개)
//      drift  : 존재하는 것끼리 해시가 갈림(그룹 2개 이상)
//      partial: 일부만 존재(있는 것끼리는 동일)
//      none   : 하나도 없음
function instrMatrix() {
  // 내용 해시 → 그룹 번호(1부터). buildSkillRow와 동일한 idiom.
  const groupOf = new Map();
  let nextGroup = 0;
  const assign = (h) => {
    if (!groupOf.has(h)) groupOf.set(h, ++nextGroup);
    return groupOf.get(h);
  };

  const discovered = scanner.discoverInstructions(); // {tool, path, exists, ...}[]
  const models = {};
  for (const tool of paths.TOOLS) {
    const item = discovered.find((i) => i.tool === tool);
    if (!item || !item.exists) {
      models[tool] = { exists: false, group: null };
      continue;
    }
    try {
      // readItemContent는 거부목록/PI 가드를 상속(지시문 본문 읽기는 사용자 트리거 화면 로드).
      const { text } = scanner.readItemContent({ path: item.path });
      models[tool] = { exists: true, group: assign(contentHash(text)) };
    } catch (e) {
      // 우아한 실패(D26): 이 모델만 readError, 나머지는 계속.
      models[tool] = { exists: false, group: null, readError: e.message };
    }
  }

  // 종합 상태 판정(지시문 전용 — none이 별도 상태라 syncStateOf와 규칙이 다름).
  const present = paths.TOOLS.map((t) => models[t]).filter((s) => s.exists && s.group != null);
  let syncState;
  if (present.length === 0) syncState = 'none';
  else if (groupOf.size > 1) syncState = 'drift';
  else syncState = present.length === paths.TOOLS.length ? 'synced' : 'partial';

  return {
    canonId: CANON_ID,
    models,
    groups: groupOf.size,
    syncState,
  };
}

// (1b) instrContent — 지시문 매트릭스 셀 클릭 시 두 모델의 본문 + 좌우 diff.
//  - 본문은 scanner.readItemContent로 읽어 거부목록을 상속. (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람.)
//  - syncState는 instrMatrix()의 판정을 재사용(중복 구현 금지).
//  - 개별 읽기 실패는 해당 모델 readError로 담고 throw하지 않는다(D26 우아한 실패).
//  - sideBySide: 두 모델 본문이 모두 있고 서로 다를 때만 diff.sideBySide, 아니면 null.
// 반환: { syncState, models:{ [tool]:{exists,path,body,readError?} }, sideBySide|null }
function instrContent() {
  const syncState = instrMatrix().syncState; // 판정 재사용(3파일 해시 그룹 기반)
  const discovered = scanner.discoverInstructions(); // {tool, path, exists}[]
  const models = {};
  for (const tool of paths.TOOLS) {
    const item = discovered.find((i) => i.tool === tool);
    const filePath = item ? item.path : paths.instructionPath(tool);
    if (!item || !item.exists) {
      models[tool] = { exists: false, path: filePath, body: null };
      continue;
    }
    try {
      const { text } = scanner.readItemContent({ path: filePath });
      models[tool] = { exists: true, path: filePath, body: text };
    } catch (e) {
      models[tool] = { exists: false, path: filePath, body: null, readError: e.message };
    }
  }

  const claudeBody = models.claude && models.claude.exists ? models.claude.body : null;
  const codexBody = models.codex && models.codex.exists ? models.codex.body : null;
  const sideBySide =
    claudeBody != null && codexBody != null && claudeBody !== codexBody
      ? diff.sideBySide(claudeBody, codexBody)
      : null;

  return { syncState, models, sideBySide };
}

// (2) instrSync — 기준 모델로 한 방 동기화.
//  - base = 'claude'|'codex'.
//  - apply:false(기본): 실제 쓰기 없이 모델별 diff 요약(변경 라인 수·생성될 파일 여부)만 반환.
//      · 쓰기 없음 검증을 위해 canonical에도 쓰지 않는다 — 기준 파일 본문을 직접 읽어
//        transformInstr.render + diff.lineDiff로 대상별 미리보기를 만든다(디스크 무변경).
//  - apply:true: 기존 pull({from:base}) → push({to,apply:true}) 파이프라인을 그대로 재사용
//      (자동 백업·synclog·gitCommit 상속). 새 쓰기 경로는 만들지 않는다.
//      (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람.)
function instrSync({ base, apply }) {
  if (!paths.TOOLS.includes(base)) {
    throw new Error("기준 모델(base)이 올바르지 않습니다: " + base + " ('claude'|'codex')");
  }
  const baseItem = scanner.discoverInstructions().find((i) => i.tool === base);
  if (!baseItem || !baseItem.exists) {
    throw new Error(`기준 모델(${base})의 지시문 파일이 없습니다: ${baseItem ? baseItem.path : base}`);
  }

  if (!apply) {
    // 미리보기: 디스크 무변경. 기준 파일 본문을 읽어 대상 모델별 diff 요약만 만든다.
    const { text: baseBody } = scanner.readItemContent({ path: baseItem.path });
    const targets = paths.TOOLS.filter((t) => t !== base).map((to) => {
      const rendered = transformInstr.render(baseBody, to); // 지시문은 본문 변환 없음(파일명만)
      const exists = fs.existsSync(rendered.targetPath);
      const deployed = exists ? fs.readFileSync(rendered.targetPath, 'utf8') : '';
      const d = diff.lineDiff(deployed, rendered.body);
      const added = d.filter((x) => x.type === '+').length;
      const removed = d.filter((x) => x.type === '-').length;
      return {
        to,
        targetPath: rendered.targetPath,
        exists,
        willCreate: !exists,     // 대상 파일이 없으면 새로 생성됨
        hasChanges: diff.hasChanges(d),
        added,                   // 추가될 라인 수
        removed,                 // 사라질 라인 수
        changedLines: added + removed,
      };
    });
    return { applied: false, base, targets };
  }

  // 적용: 기존 파이프라인 재사용. pull(base→canonical) 후 나머지 모델로 push(apply:true).
  const pulled = pull({ from: base });
  const results = [];
  for (const to of paths.TOOLS) {
    if (to === base) continue;
    try {
      const r = push({ to, apply: true }); // 자동 백업·synclog·gitCommit 상속
      results.push({ to, applied: true, targetPath: r.targetPath, backupPath: r.backupPath || null });
    } catch (e) {
      // 부분 실패: 중단하지 말고 모델별 결과로 기록.
      results.push({ to, applied: false, error: e.message });
    }
  }
  return {
    applied: true,
    base,
    pulled: { imported: true, source_tool: pulled.meta.source_tool },
    results,
  };
}

// ================= 백업 목록 / 복구 (UX-D1) =================
// 로직은 cli/backup.js 단일 소스 — 여기는 위임 래퍼만 둔다.
// push 계열이 덮어쓰기 전에 남긴 백업을 목록으로 보여주고, 원위치로 복구한다.
// 복구는 backup.js에서 경로 탈출 차단 + 대상 화이트리스트 검증을 강제한다.

function backupsList() {
  return { backups: backup.listBackups() };
}

function backupRestore({ path: backupFilePath }) {
  if (!backupFilePath) throw new Error('백업 파일 경로가 필요합니다 (--path)');
  return backup.restoreBackup({ backupFilePath });
}

// ================= 카테고리(태그) 배선 =================

// 태그 추천 목록(프리셋 + 누적 커스텀).
function tagSuggestions() {
  return category.suggestions();
}

// 항목에 태그 지정/변경(정규화 후 저장). id: skill이면 name, agent면 agent-id, instruction이면 canon id.
function setItemTags({ kind, id, tags }) {
  const norm = category.normalizeTags(tags || []);
  if (kind === 'skill') {
    const cur = canonical.readSkill(id);
    if (!cur) throw new Error('canonical skill 없음: ' + id);
    canonical.writeSkill(id, cur.body, {
      source_id: cur.meta.source_id,
      source_tool: cur.meta.source_tool,
      official: cur.meta.official,
      tags: norm,
    });
  } else if (kind === 'agent') {
    const neutral = canonical.readAgent(id);
    if (!neutral) throw new Error('canonical agent 없음: ' + id);
    canonical.writeAgent({ ...neutral, tags: norm });
  } else if (kind === 'instruction') {
    const cur = canonical.read(id);
    if (!cur) throw new Error('canonical 지시문 없음: ' + id);
    canonical.write(id, cur.body, {
      type: cur.meta.type,
      scope: cur.meta.scope,
      sourceTool: cur.meta.source_tool,
      tags: norm,
    });
  } else {
    throw new Error('알 수 없는 kind: ' + kind);
  }
  if (norm.length) category.registerCustom(norm);
  gitCommit(`tags: ${kind}/${id} = [${norm.join(',')}]`);
  return { kind, id, tags: norm };
}

// ================= 스토어 (번들 카탈로그 → 모든 도구 적용) =================

// 카탈로그 목록(본문 제외). query가 있으면 점수 랭킹(search.js).
// SKC1: opts.publisher(slug)가 주어지면 병합 목록을 그 퍼블리셔로 필터.
//       tag 필터는 프런트가 처리(그대로).
function storeList(query, opts = {}) {
  let items = store.load().items.map((it) => ({
    id: it.id,
    name: it.name,
    kind: it.kind,
    // 태그는 새 카테고리 어휘로 변환해 노출(구 캐시/번들의 옛 키도 일관되게 표시·필터).
    tags: category.mapLegacyTags(it.tags || []),
    description: it.description || '',
    official: it.official !== false,
    transform_notes: it.transform_notes || [],
    // SKC1: 퍼블리셔/소스repo 노출(레지스트리 항목만 값 존재, 번들은 undefined).
    publisher: it.publisher,
    publisherSlug: it.publisherSlug,
    sourceRepo: it.sourceRepo,
  }));
  if (opts && opts.publisher) {
    items = items.filter((it) => it.publisherSlug === opts.publisher);
  }
  return { items: query ? search.rankItems(items, query) : items };
}

// 퍼블리셔 카드 목록(SKC1) — registry.publishersList()에 위임.
function publishers() {
  return { publishers: registry.publishersList() };
}

// 카탈로그 항목 상세(본문/neutral 포함).
function storeItem(id) {
  return store.get(id);
}

// 한 항목을 3개 도구 모두에 적용/미리보기 — 기존 push 재사용(모드 가드·백업·synclog 상속).
function skillPushAll({ name, apply }) {
  return paths.TOOLS.map((to) => skillPush({ name, to, apply }));
}
function agentPushAll({ id, apply }) {
  return paths.TOOLS.map((to) => agentPush({ id, to, apply }));
}

// 적용 전 미리보기: 카탈로그 항목을 각 도구로 렌더(canonical에 쓰지 않음). 손실 포함.
function storePreview(id) {
  const it = store.get(id);
  if (!it) throw new Error('카탈로그 항목 없음: ' + id);
  if (it.kind === 'skill') {
    const perTool = paths.TOOLS.map((to) => {
      const r = transformSkill.render(it.body || '', it.name, to);
      const deployed = fs.existsSync(r.targetPath) ? fs.readFileSync(r.targetPath, 'utf8') : '';
      const d = diff.lineDiff(deployed, r.content);
      return { to, targetPath: r.targetPath, diff: d, diffText: diff.renderHunked(d), losses: r.losses };
    });
    return { kind: 'skill', name: it.name, body: it.body || '', exists: canonical.skillExists(it.name), perTool };
  }
  if (it.kind === 'agent') {
    const neutral = { ...it.neutral, tags: it.tags || [] };
    const perTool = paths.TOOLS.map((to) => {
      const r = transformAgent.render(neutral, to);
      const target = paths.agentPath(to, neutral.name);
      const deployed = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const d = diff.lineDiff(deployed, r.content);
      return { to, targetPath: target, diff: d, diffText: diff.renderHunked(d), losses: r.losses };
    });
    return { kind: 'agent', id: neutral.id, exists: canonical.agentExists(neutral.id), perTool };
  }
  throw new Error('지원하지 않는 kind: ' + it.kind);
}

// 적용: 카탈로그 항목 → canonical 기록 + 3개 도구 push.
// 동명 canonical이 있고 resolution이 없으면 conflict 반환(#5: overwrite/skip/rename).
function storeApply({ id, resolution, newName }) {
  const it = store.get(id);
  if (!it) throw new Error('카탈로그 항목 없음: ' + id);

  // (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람. 레지스트리 출처 항목도 본문 개인정보
  //  확인 없이 그대로 canonical에 기록한다. 파일 경로 거부목록은 스캔 단계에서 그대로 유효.)

  if (it.kind === 'skill') {
    let name = it.name;
    if (canonical.skillExists(name) && !resolution) {
      const cur = canonical.readSkill(name);
      return { conflict: true, kind: 'skill', name, options: ['overwrite', 'skip', 'rename'],
        diff: diff.lineDiff(cur.body, it.body || '') };
    }
    if (canonical.skillExists(name) && resolution === 'skip') return { applied: false, skipped: true, kind: 'skill', name };
    if (canonical.skillExists(name) && resolution === 'rename') name = newName || name + '-2';
    const tags = category.normalizeTags(it.tags || []);
    canonical.writeSkill(name, it.body || '', { source_id: 'catalog', source_tool: 'bundled', official: it.official !== false, tags });
    if (tags.length) category.registerCustom(tags);
    gitCommit(`store install skill: ${name}`);
    return { applied: true, kind: 'skill', name, results: skillPushAll({ name, apply: true }) };
  }

  if (it.kind === 'agent') {
    const neutral = { ...it.neutral, tags: category.normalizeTags(it.tags || []) };
    if (canonical.agentExists(neutral.id) && !resolution) {
      const cur = canonical.readAgent(neutral.id);
      return { conflict: true, kind: 'agent', id: neutral.id, options: ['overwrite', 'skip', 'rename'],
        diff: diff.lineDiff(JSON.stringify(cur, null, 2), JSON.stringify(neutral, null, 2)) };
    }
    if (canonical.agentExists(neutral.id) && resolution === 'skip') return { applied: false, skipped: true, kind: 'agent', id: neutral.id };
    if (canonical.agentExists(neutral.id) && resolution === 'rename') {
      const nm = newName || neutral.name + '-2';
      neutral.name = nm;
      neutral.id = 'agent-' + nm;
    }
    canonical.writeAgent(neutral);
    if (neutral.tags.length) category.registerCustom(neutral.tags);
    gitCommit(`store install agent: ${neutral.id}`);
    return { applied: true, kind: 'agent', id: neutral.id, results: agentPushAll({ id: neutral.id, apply: true }) };
  }

  throw new Error('지원하지 않는 kind: ' + it.kind);
}

// ================= 원격 레지스트리 (스토어-R1) =================
// 로직은 cli/registry.js 단일 소스 — 여기는 위임 래퍼만 둔다.
// 외부 통신(refresh/updates)은 사용자 트리거 동작에서만 실행된다(자동 폴링 없음, D14·D25).
// add는 등록만 — 통신하지 않는다.

function registryList() {
  return { registries: registry.list() };
}
function registryAdd({ url, name }) {
  if (!url) throw new Error('레지스트리 URL이 필요합니다 (--url)');
  return registry.add(url, { name });
}
function registryRemove({ id }) {
  if (!id) throw new Error('레지스트리 id가 필요합니다 (--id)');
  return registry.remove(id);
}
// refresh/checkUpdates는 비동기(git 통신). Promise를 그대로 돌려준다.
function registryRefresh({ id }) {
  if (!id) throw new Error('레지스트리 id가 필요합니다 (--id)');
  return registry.refresh(id);
}
function registryCheckUpdates() {
  return registry.checkUpdates();
}
// F2-3: 시작 시 증분 수집(비차단 kick은 serve에서). 진행 상태 조회는 동기.
function registryCollectMissing({ concurrency } = {}) {
  return registry.collectMissing({ concurrency });
}
function registryCollectStatus() {
  return registry.collectStatus();
}

// ================= 플레이그라운드 (추천 → 미리보기 → 적용) =================
// 추천/미리보기/조합은 playground 모듈(읽기 전용)에 위임. 적용(쓰기)만 여기서 처리.
function pgCatalog() {
  return playground.loadCatalog();
}
function pgSkillWizard() {
  return playground.skillWizard();
}
function pgAnswersToQuery(answers) {
  return playground.answersToQuery(answers || {});
}
function pgRecommendSkills(query, opts) {
  return playground.recommendSkills(query || {}, opts || {});
}
function pgRecommendForRole(roleText, opts) {
  return playground.recommendSkillsForRole(roleText || '', opts || {});
}
function pgPreviewSkill(id) {
  const it = store.get(id);
  if (!it) throw new Error('카탈로그 항목 없음: ' + id);
  return playground.previewSkill(it);
}
function pgComposeAgent({ roleText, pickedIds, name }) {
  const picked = (pickedIds || []).map((pid) => store.get(pid)).filter(Boolean);
  return playground.composeAgent({ roleText: roleText || '', picked, name });
}
function pgPreviewAgent(neutral) {
  return playground.previewAgent(neutral);
}
// 적용(스킬): 추천 스킬 = 카탈로그 스킬이므로 storeApply 재사용(canonical 기록 + 3도구 push + 충돌 처리).
function pgAdoptSkill({ id, resolution, newName }) {
  return storeApply({ id, resolution, newName });
}
// 적용(에이전트): 조합된 중립 스키마를 canonical 기록 + 3도구 push. 동명 충돌 시 conflict 반환.
function pgAdoptAgent({ neutral, resolution, newName }) {
  if (!neutral || !neutral.id) throw new Error('neutral agent가 필요합니다');
  const n = { ...neutral, tags: category.normalizeTags(neutral.tags || []) };
  if (canonical.agentExists(n.id) && !resolution) {
    const cur = canonical.readAgent(n.id);
    return { conflict: true, kind: 'agent', id: n.id, options: ['overwrite', 'skip', 'rename'],
      diff: diff.lineDiff(JSON.stringify(cur, null, 2), JSON.stringify(n, null, 2)) };
  }
  if (canonical.agentExists(n.id) && resolution === 'skip') return { applied: false, skipped: true, kind: 'agent', id: n.id };
  if (canonical.agentExists(n.id) && resolution === 'rename') {
    const nm = newName || n.name + '-2';
    n.name = nm;
    n.id = 'agent-' + nm;
  }
  canonical.writeAgent(n);
  if (n.tags.length) category.registerCustom(n.tags);
  gitCommit(`playground adopt agent: ${n.id}`);
  return { applied: true, kind: 'agent', id: n.id, results: agentPushAll({ id: n.id, apply: true }) };
}

// ================= 항목 본문 보기 (이슈5) =================
// (과제4) 로컬 폴더 열기 기능은 클립보드 경로 복사(순수 클라이언트)로 대체되어 서버 경로가
//   더 이상 필요 없어졌다 — 관련 백엔드(폴더 열기 함수·화이트리스트 헬퍼)를 함께 제거했다.

// (이슈5) 스킬/에이전트의 (scope,name) 본문을 요청 도구(미지정이면 존재하는 첫 도구)로 읽는다.
//  - scanner.readItemContent 재사용 → 거부목록 자동 상속. (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람.)
//  - 반환: { name, kind, tool, path, body, tools:[존재 모델 목록] }.
function itemContent({ kind, name, scope, tool } = {}) {
  if (kind !== 'skill' && kind !== 'agent') {
    throw new Error("알 수 없는 kind: " + kind + " ('skill'|'agent')");
  }
  if (!name) throw new Error('name이 필요합니다');

  // 해당 (scope,name)의 도구별 파일 경로를 모은다. scope는 'global' 또는 프로젝트 root.
  const isProject = scope && scope !== 'global';
  const projRoot = isProject ? requireRegisteredProject(scope) : null;
  const byTool = {}; // tool -> filePath (존재하는 것만)

  if (kind === 'skill') {
    // 발견된 스킬 중 (scope,name) 일치 항목을 도구 슬롯으로 역매핑(매트릭스와 동일 규칙).
    const GLOBAL_SLOT = { claude: 'claude-user', codex: 'shared-agents' };
    const PROJECT_SLOT = { claude: 'claude-project', codex: 'shared-project' };
    const slotMap = isProject ? PROJECT_SLOT : GLOBAL_SLOT;
    for (const s of scanner.discoverSkills()) {
      if (s.name !== name) continue;
      const sScope = s.scope === 'project' ? s.projectRoot : 'global';
      if (isProject ? sScope !== projRoot : sScope !== 'global') continue;
      const t = paths.TOOLS.find((x) => slotMap[x] === s.source_id);
      if (t && !byTool[t]) byTool[t] = s.path;
    }
  } else {
    for (const a of scanner.discoverAgents().agents) {
      if (a.name !== name) continue;
      const aScope = a.scope === 'project' ? a.projectRoot : 'global';
      if (isProject ? aScope !== projRoot : aScope !== 'global') continue;
      if (!byTool[a.tool]) byTool[a.tool] = a.path;
    }
  }

  const toolsPresent = paths.TOOLS.filter((t) => byTool[t]);
  if (!toolsPresent.length) {
    throw new Error(`${kind} "${name}"의 파일을 찾을 수 없습니다 (scope: ${scope || 'global'})`);
  }
  // 요청 도구(있고 존재하면) 우선, 아니면 존재하는 첫 도구.
  const useTool = (tool && byTool[tool]) ? tool : toolsPresent[0];
  const filePath = byTool[useTool];

  // 존재하는 각 도구 본문을 모두 읽는다(전부 readItemContent 경유 → 거부목록 상속).
  //  - 하위호환: 기존 단일 body/tool은 useTool 기준 값을 그대로 유지한다.
  const readBody = (p) => scanner.readItemContent({ path: p }).text;

  const contents = {}; // { [tool]: {path, body} } — 존재하는 도구만
  for (const t of toolsPresent) {
    contents[t] = { path: byTool[t], body: readBody(byTool[t]) };
  }
  const text = contents[useTool].body; // 하위호환용 단일 body

  // 존재 도구가 정확히 2개이고 두 본문이 다를 때만 좌우 diff(claude=왼쪽, codex=오른쪽).
  let sideBySide = null;
  if (toolsPresent.length === 2) {
    const claudeBody = contents.claude ? contents.claude.body : null;
    const codexBody = contents.codex ? contents.codex.body : null;
    if (claudeBody != null && codexBody != null && claudeBody !== codexBody) {
      sideBySide = diff.sideBySide(claudeBody, codexBody);
    }
  }

  return { name, kind, tool: useTool, path: filePath, body: text, tools: toolsPresent, contents, sideBySide };
}

// ================= 사용량(호출 횟수) — 신호 B (usagelog 배선) =================
// 사용자 요구: "지난 1일/7일 사용"이 실제 스킬 호출 "횟수"를 보여줘야 한다(mtime 1회로는 빈도 불가).
//  ① usagelog.scan() 1회(요청 시 — 자동 폴링 없음. 실패해도 조용히 계속).
//  ② 매트릭스의 skill 이름 전체(skillMatrix rows — 중복 이름은 하나로)에 statsFor 매핑.
//  ③ 반환 { now, source, items:[{name, freq:{day1,day7,total}, lastUsed}] }.
//  로그가 전혀 없거나 스캔 실패면 items의 freq 전부 0 + source:'none'(폴백 사실 표시).
//  출처는 Claude 세션만(Codex 거부목록). 본문은 일절 다루지 않고 이름·횟수·시각만 반환한다.
function usageStats({ now, windowDays } = {}) {
  const nowDate = now ? new Date(now) : new Date();

  // ① 증분 스캔(요청 시 1회). 어떤 이유로든 실패하면 source='none'으로 폴백.
  let scanResult;
  try {
    scanResult = usagelog.scan({ windowDays });
  } catch {
    scanResult = { scanned: 0, events: 0, source: 'none' };
  }

  // ② skill 매트릭스의 이름 전체(중복 제거).
  let names = [];
  try {
    const seen = new Set();
    for (const row of skillMatrix()) {
      if (row && row.name && !seen.has(row.name)) {
        seen.add(row.name);
        names.push(row.name);
      }
    }
  } catch {
    names = []; // 매트릭스 계산 실패해도 usage는 빈 items로 응답(우아한 실패)
  }

  let statsMap = {};
  try {
    statsMap = usagelog.statsFor(names, nowDate);
  } catch {
    statsMap = {};
  }

  const items = names.map((name) => {
    const s = statsMap[name] || { day1: 0, day7: 0, total: 0, lastUsed: null };
    return {
      name,
      freq: { day1: s.day1 || 0, day7: s.day7 || 0, total: s.total || 0 },
      lastUsed: s.lastUsed || null,
    };
  });

  return {
    now: nowDate.toISOString(),
    source: scanResult && scanResult.source === 'claude-sessions' ? 'claude-sessions' : 'none',
    items,
  };
}

module.exports = {
  CANON_ID,
  itemContent,
  usageStats,
  // ===== 원격 레지스트리 (스토어-R1) =====
  registryList,
  registryAdd,
  registryRemove,
  registryRefresh,
  registryCheckUpdates,
  registryCollectMissing,
  registryCollectStatus,
  // ===== 프로젝트 레지스트리 (T2) =====
  projectsList,
  projectsScan,
  projectsAdopt,
  projectsAdd,
  projectsRemove,
  projectsReset,
  projectsPrune,
  projectsEnsureScanned,
  overview,
  diffFor,
  pull,
  push,
  agentOverview,
  agentPull,
  agentDiff,
  agentPush,
  parseReferencedSkills,
  skillOverview,
  skillPull,
  skillDiff,
  skillPush,
  // ===== 한 번에 동기화(Sync) — UX-A =====
  syncPlan,
  syncApply,
  // ===== 동기화 매트릭스 — UX-E1 =====
  syncMatrix,
  // ===== 지시문 매트릭스 / 한 방 동기화 (UX v2 — F2) =====
  instrMatrix,
  instrContent,
  instrSync,
  // ===== 백업 목록 / 복구 (UX-D1) =====
  backupsList,
  backupRestore,
  // ===== 카테고리(태그) =====
  tagSuggestions,
  setItemTags,
  // ===== 스토어 (번들 카탈로그 → 모든 도구 적용) =====
  storeList,
  publishers,
  storeItem,
  storePreview,
  storeApply,
  skillPushAll,
  agentPushAll,
  // ===== 플레이그라운드 =====
  pgCatalog,
  pgSkillWizard,
  pgAnswersToQuery,
  pgRecommendSkills,
  pgRecommendForRole,
  pgPreviewSkill,
  pgComposeAgent,
  pgPreviewAgent,
  pgAdoptSkill,
  pgAdoptAgent,
  // ===== Phase 2: 사용량 추적 + 자기 점검 =====
  usage: maintenance.usage,
  review: maintenance.review,
  pending: maintenance.pending,
  approveProposal: maintenance.approve,
  rejectProposal: maintenance.reject,
  archiveItem: maintenance.archiveItem,
  restoreItem: maintenance.restoreItem,
  pin: telemetry.pin,
  unpin: telemetry.unpin,
  syncLog: synclog.load,
};
