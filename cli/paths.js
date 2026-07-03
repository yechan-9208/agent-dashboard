'use strict';
// 두 도구(claude·codex)의 설정 홈 경로와 동기화 대상 위치를 정의한다.
// (과거 gemini도 지원했으나 사용자 결정으로 전면 제거 — 2모델 체제.)
// 항상 실제 파일 기준으로 동작한다(더미/데모 모드는 D37로 제거).
// 격리 테스트가 필요하면 AAD_CANONICAL/AAD_BACKUPS 환경변수로 저장 위치만 바꾼다.

const os = require('os');
const path = require('path');

const PROJECT = path.join(__dirname, '..');

function home() {
  return os.homedir();
}

// 각 도구의 설정 홈 디렉토리
function toolHomes() {
  return {
    claude: path.join(home(), '.claude'),
    codex: path.join(home(), '.codex'),
  };
}

// 지시문 트랙: 도구별 글로벌 지시문 파일명 (canonical 1벌 → 파일명만 바꿔 배포)
const INSTRUCTION_FILENAME = {
  claude: 'CLAUDE.md',
  codex: 'AGENTS.md',
};

const TOOLS = ['claude', 'codex'];

// 도구의 글로벌 지시문 파일 절대 경로
function instructionPath(tool) {
  return path.join(toolHomes()[tool], INSTRUCTION_FILENAME[tool]);
}

// agent 트랙: 도구별 agent 폴더와 파일 확장자/경로
//  - Claude: .md (frontmatter + 본문) / Codex: .toml (developer_instructions)  ← 0번 검증
function agentDir(tool) {
  return path.join(toolHomes()[tool], 'agents');
}
function agentExt(tool) {
  return tool === 'codex' ? '.toml' : '.md';
}
function agentPath(tool, name) {
  return path.join(agentDir(tool), name + agentExt(tool));
}

// skill 트랙 (D11):
//  - .agents/skills = 여러 도구가 공유하는 cross-tool 표준 위치(에이전트 소속 아님)
//  - ~/.codex/skills = 공식 문서엔 없는 비공식 위치(실재) → official:false로 표시
function agentsHome() {
  return path.join(home(), '.agents');
}

// 스캔할 skill 소스 목록. official=false면 사용자에게 "비공식"으로 알린다.
function skillSources() {
  const h = toolHomes();
  return [
    { id: 'claude-user', tool: 'claude', dir: path.join(h.claude, 'skills'), official: true },
    { id: 'claude-plugins', tool: 'claude', dir: path.join(h.claude, 'plugins'), official: true, plugin: true, recursive: true },
    { id: 'shared-agents', tool: 'shared', dir: path.join(agentsHome(), 'skills'), official: true, shared: true },
    { id: 'codex-native', tool: 'codex', dir: path.join(h.codex, 'skills'), official: false },
  ];
}

// push(쓰기) 대상 디렉토리 — 공식 위치 기준
function skillTargetDir(tool) {
  const h = toolHomes();
  if (tool === 'claude') return path.join(h.claude, 'skills');
  if (tool === 'codex') return path.join(agentsHome(), 'skills'); // 공식 USER 위치
  throw new Error('알 수 없는 도구: ' + tool);
}

// canonical 저장소 위치 (프로젝트 안 — D5). AAD_CANONICAL로 격리 테스트 가능.
function canonicalRoot() {
  return process.env.AAD_CANONICAL || path.join(PROJECT, 'canonical');
}

// 배포본 덮어쓰기 전 백업을 모아둘 폴더. AAD_BACKUPS로 격리 테스트 가능.
function backupRoot() {
  return process.env.AAD_BACKUPS || path.join(PROJECT, 'backups');
}

// 번들 정적 카탈로그(스토어). 모드 무관 — 실제 사용자 데이터가 아니라 프로젝트에 포함된
// 큐레이션 목록이다(외부 통신 없음). 환경변수로 오버라이드 가능.
function catalogPath() {
  return process.env.AAD_CATALOG || path.join(PROJECT, 'catalog', 'catalog.json');
}

// ─── 프로젝트 스코프 (T1) ───
// 저장소(프로젝트) 레벨 skill/agent/지시문 위치.
// 근거: docs/verification/project-scope-verification.md (0번 검증 — 공식 문서 확인 완료).

// 등록된 프로젝트 목록(projects.json) 저장 위치.
// canonicalRoot() 아래에 둔다(AAD_CANONICAL 오버라이드 시 자동 격리).
function projectsFile() {
  return path.join(canonicalRoot(), 'projects.json');
}

// 프로젝트 레벨 skill 소스 목록 — skillSources() 항목과 같은 형태에
// scope:'project' 와 projectRoot 를 더한다.
//  - claude: <root>/.claude/skills  (공식)
//  - shared: <root>/.agents/skills  (cross-tool 표준 — Codex 공식 위치.
//    ※ .codex/skills 는 공식 문서에 없어 만들지 않는다 — 0번 검증)
function projectSkillSources(root) {
  return [
    { id: 'claude-project', tool: 'claude', dir: path.join(root, '.claude', 'skills'), official: true, scope: 'project', projectRoot: root },
    { id: 'shared-project', tool: 'shared', dir: path.join(root, '.agents', 'skills'), official: true, shared: true, scope: 'project', projectRoot: root },
  ];
}

// 프로젝트 레벨 agent 폴더 — 파일 확장자는 글로벌과 동일하게 agentExt(tool) 사용.
//  - claude: <root>/.claude/agents/*.md / codex: <root>/.codex/agents/*.toml
function projectAgentDir(root, tool) {
  if (tool === 'claude') return path.join(root, '.claude', 'agents');
  if (tool === 'codex') return path.join(root, '.codex', 'agents');
  throw new Error('알 수 없는 도구: ' + tool);
}

// 프로젝트 지시문 파일 후보 경로 (도구별 배열 — 존재 확인은 호출자 몫).
//  - Claude는 두 위치 모두 공식("either ./CLAUDE.md or ./.claude/CLAUDE.md").
function projectInstructionPaths(root) {
  return {
    claude: [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')],
    codex: [path.join(root, 'AGENTS.md')],
  };
}

// "최초 1회" 프로젝트 스캔의 기본 루트 = 사용자 홈 디렉토리.
function projectScanDefaultRoot() {
  return home();
}

// ─── 원격 레지스트리 (스토어-R1) ───
// 등록된 레지스트리 목록(registries.json) 저장 위치.
// canonicalRoot() 아래에 둔다(projectsFile과 동일 패턴 — AAD_CANONICAL 오버라이드 시 자동 격리).
function registriesFile() {
  return path.join(canonicalRoot(), 'registries.json');
}

// 레지스트리 clone/파싱 캐시 디렉토리. 번들 원본(catalog.json)은 건드리지 않고
// 여기(catalog/cache)에만 registry-<id>.json 및 임시 clone을 둔다.
function registryCacheDir() {
  return process.env.AAD_REGISTRY_CACHE || path.join(PROJECT, 'catalog', 'cache');
}

module.exports = {
  TOOLS,
  catalogPath,
  INSTRUCTION_FILENAME,
  toolHomes,
  instructionPath,
  agentDir,
  agentExt,
  agentPath,
  agentsHome,
  skillSources,
  skillTargetDir,
  canonicalRoot,
  backupRoot,
  // 프로젝트 스코프 (T1)
  projectsFile,
  projectSkillSources,
  projectAgentDir,
  projectInstructionPaths,
  projectScanDefaultRoot,
  // 원격 레지스트리 (스토어-R1)
  registriesFile,
  registryCacheDir,
};
