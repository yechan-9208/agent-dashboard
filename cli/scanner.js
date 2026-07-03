'use strict';
// 하이브리드 스캐너 (D9):
//  - discover(): 어떤 항목이 있는지(존재/경로)만 본다. 내용은 읽지 않는다.
//  - readItemContent(): 사용자가 고른 항목의 내용만 읽고, PI를 함께 탐지한다.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const security = require('./security');
const projects = require('./projects');

// 지시문 트랙: 세 도구의 글로벌 지시문이 존재하는지만 발견 (내용 안 읽음)
function discoverInstructions() {
  return paths.TOOLS.map((tool) => {
    const filePath = paths.instructionPath(tool);
    return {
      id: 'instr-global',
      type: 'instruction',
      scope: 'global',
      tool,
      name: paths.INSTRUCTION_FILENAME[tool],
      path: filePath,
      exists: fs.existsSync(filePath),
    };
  });
}

// 프로젝트 지시문 발견(T2): 등록된 프로젝트별 지시문 파일의 "존재 여부만" 본다 (내용 안 읽음).
//  - Claude는 후보가 2곳(./CLAUDE.md, ./.claude/CLAUDE.md)이라 후보마다 한 항목씩 낸다.
//  - pull/push는 이번 범위 밖 — 순수 표시용.
function discoverProjectInstructions() {
  const items = [];
  for (const proj of projects.list()) {
    const candidates = paths.projectInstructionPaths(proj.root);
    for (const tool of paths.TOOLS) {
      for (const filePath of candidates[tool] || []) {
        items.push({
          id: 'instr-project',
          type: 'instruction',
          scope: 'project',
          projectRoot: proj.root,
          tool,
          name: path.relative(proj.root, filePath), // 예: 'CLAUDE.md' / '.claude/CLAUDE.md'
          path: filePath,
          exists: fs.existsSync(filePath),
        });
      }
    }
  }
  return items;
}

// agent 트랙 하이브리드 발견: 도구별 agent 폴더에서 "파일명"만 본다 (내용 안 읽음).
//  - Claude = .md, Codex = .toml 만 정식 agent로 인정.
//  - 확장자가 안 맞는 파일(README, Codex 폴더의 .md 등)은 nonStandard로 분리(스킵 대상).
//  - T2: 글로벌(도구 홈) + 등록된 프로젝트의 agent 폴더를 같은 규칙으로 합류.
function discoverAgents() {
  const agents = [];
  const nonStandard = [];

  // 한 agent 폴더를 훑는 공통 루틴 (extra = scope/projectRoot 등 부가 필드)
  function scanDir(tool, dir, extra) {
    const ext = paths.agentExt(tool);
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      const full = path.join(dir, file);
      if (!fs.statSync(full).isFile()) continue;
      if (file.toLowerCase() === 'readme.md') continue;
      if (file.endsWith(ext)) {
        agents.push({ tool, name: file.slice(0, -ext.length), path: full, exists: true, ...extra });
      } else {
        nonStandard.push({ tool, file, path: full, reason: `${tool} agent는 ${ext}만 인정`, ...extra });
      }
    }
  }

  // 글로벌: 기존 그대로 (scope만 명시)
  for (const tool of paths.TOOLS) {
    scanDir(tool, paths.agentDir(tool), { scope: 'global' });
  }
  // 프로젝트: 등록된 프로젝트만 (같은 확장자 규칙 — codex는 .toml)
  for (const proj of projects.list()) {
    for (const tool of paths.TOOLS) {
      scanDir(tool, paths.projectAgentDir(proj.root, tool), { scope: 'project', projectRoot: proj.root });
    }
  }
  return { agents, nonStandard };
}

// skill 하이브리드 발견: 소스 디렉토리에서 "<name>/SKILL.md" 폴더만 찾는다(내용 안 읽음).
//  - 비공식 소스(official:false)의 skill은 official:false로 표시해 사용자에게 알린다(D11).
//  - 플러그인 소스는 재귀 탐색(깊이 제한). 거부목록 경로는 건너뛴다.
//  - T2: 글로벌 소스 뒤에 등록된 프로젝트의 소스(projectSkillSources)를 합류.
//    글로벌이 앞이므로 이름이 겹칠 때 기본 매칭(첫 항목)은 기존과 동일하게 글로벌이다.
function discoverSkills() {
  const skills = [];
  const sources = [
    ...paths.skillSources(), // 글로벌 (scope 미지정 → 'global'로 명시)
    ...projects.list().flatMap((p) => paths.projectSkillSources(p.root)), // scope:'project'+projectRoot 포함
  ];
  for (const src of sources) {
    for (const folder of findSkillFolders(src.dir, src.recursive)) {
      skills.push({
        id: 'skill-' + folder.name,
        type: 'skill',
        name: folder.name,
        tool: src.tool,
        source_id: src.id,
        official: src.official,
        shared: !!src.shared,
        plugin: !!src.plugin,
        scope: src.scope || 'global',
        ...(src.projectRoot ? { projectRoot: src.projectRoot } : {}),
        path: folder.skillMdPath,
        exists: true,
      });
    }
  }
  return skills;
}

// 디렉토리에서 SKILL.md를 가진 폴더를 찾는다. recursive면 깊이 제한 walk.
function findSkillFolders(dir, recursive, depth = 0) {
  if (!fs.existsSync(dir) || depth > 6) return [];
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const folder = path.join(dir, e.name);
    if (security.isDenied(folder) || e.name === 'node_modules' || e.name === '.git') continue;
    const skillMd = path.join(folder, 'SKILL.md');
    if (fs.existsSync(skillMd)) {
      out.push({ name: e.name, skillMdPath: skillMd, folder });
    } else if (recursive) {
      out.push(...findSkillFolders(folder, true, depth + 1));
    }
  }
  return out;
}

// 특정 항목의 내용을 읽는다 (사용자가 클릭/지정한 경우에만 호출).
//  - 거부목록(auth.json/*.sqlite/sessions//.env/*.key 등) 경로는 여전히 읽지 않는다.
//  - PI 게이트는 D33으로 제거 — 로컬 전용·사용자 본인만 열람하므로 본문 탐지 불필요.
function readItemContent(item) {
  if (security.isDenied(item.path)) {
    throw new Error(`거부목록에 해당하는 경로라 읽지 않습니다: ${item.path}`);
  }
  if (!fs.existsSync(item.path)) {
    throw new Error(`파일이 없습니다: ${item.path}`);
  }
  const text = fs.readFileSync(item.path, 'utf8');
  return { text };
}

module.exports = {
  discoverInstructions,
  discoverProjectInstructions,
  discoverAgents,
  discoverSkills,
  readItemContent,
};
