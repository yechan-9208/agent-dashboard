'use strict';
// canonical(중앙 원본) 읽기/쓰기. 지시문 트랙 한정.
//  - 본문:  canonical/instructions/<id>.md
//  - 메타:  canonical/instructions/<id>.meta.json  (id·type·scope·source_tool·시각)
// 외부 의존성을 피하려고 메타는 사이드카 JSON으로 분리해 둔다.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function instrDir() {
  return path.join(paths.canonicalRoot(), 'instructions');
}

function bodyFile(id) {
  return path.join(instrDir(), `${id}.md`);
}

function metaFile(id) {
  return path.join(instrDir(), `${id}.meta.json`);
}

function exists(id) {
  return fs.existsSync(bodyFile(id));
}

function read(id) {
  if (!exists(id)) return null;
  const body = fs.readFileSync(bodyFile(id), 'utf8');
  const meta = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
  return { body, meta };
}

// canonical에 지시문을 기록(생성/갱신)한다.
function write(id, body, { type = 'instruction', scope = 'global', sourceTool, tags } = {}) {
  fs.mkdirSync(instrDir(), { recursive: true });
  const now = new Date().toISOString();
  const prev = exists(id) ? read(id).meta : null;
  const meta = {
    id,
    type,
    scope,
    source_tool: sourceTool || (prev ? prev.source_tool : null),
    // 받은 tags는 그대로 저장만 한다(정규화는 호출부 책임). 미지정 시 이전 값 또는 [].
    tags: tags !== undefined ? tags : (prev ? prev.tags ?? [] : []),
    created_at: prev ? prev.created_at : now,
    updated_at: now,
  };
  fs.writeFileSync(bodyFile(id), body);
  fs.writeFileSync(metaFile(id), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}

// ---------- agent (중립 스키마 JSON) ----------
function agentsDir() {
  return path.join(paths.canonicalRoot(), 'agents');
}
function agentFile(id) {
  return path.join(agentsDir(), `${id}.json`);
}
function agentExists(id) {
  return fs.existsSync(agentFile(id));
}
function readAgent(id) {
  if (!agentExists(id)) return null;
  return JSON.parse(fs.readFileSync(agentFile(id), 'utf8'));
}
function writeAgent(neutral) {
  fs.mkdirSync(agentsDir(), { recursive: true });
  const now = new Date().toISOString();
  const prev = agentExists(neutral.id) ? readAgent(neutral.id) : null;
  const record = {
    ...neutral,
    type: 'agent',
    // 중립 스키마에 tags가 있으면 spread로 자동 보존됨. 없을 때만 []로 보강(가산적).
    tags: neutral.tags || [],
    created_at: prev ? prev.created_at : now,
    updated_at: now,
  };
  fs.writeFileSync(agentFile(neutral.id), JSON.stringify(record, null, 2) + '\n');
  return record;
}
function listAgents() {
  if (!fs.existsSync(agentsDir())) return [];
  return fs
    .readdirSync(agentsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(agentsDir(), f), 'utf8')));
}

// ---------- skill (폴더 + SKILL.md + .meta.json) ----------
function skillsDir() {
  return path.join(paths.canonicalRoot(), 'skills');
}
function skillFolder(name) {
  return path.join(skillsDir(), name);
}
function skillExists(name) {
  return fs.existsSync(path.join(skillFolder(name), 'SKILL.md'));
}
function readSkill(name) {
  if (!skillExists(name)) return null;
  const body = fs.readFileSync(path.join(skillFolder(name), 'SKILL.md'), 'utf8');
  const meta = JSON.parse(fs.readFileSync(path.join(skillFolder(name), '.meta.json'), 'utf8'));
  return { body, meta };
}
function writeSkill(name, body, { source_id, source_tool, official, tags, scope, project_root } = {}) {
  const folder = skillFolder(name);
  fs.mkdirSync(folder, { recursive: true });
  const now = new Date().toISOString();
  const prev = skillExists(name) ? readSkill(name).meta : null;
  // 프로젝트 스코프(T2): 미지정(undefined)이면 이전 값 유지(prev-fallback), null이면 명시적 제거.
  const scopeVal = scope !== undefined ? scope : prev ? prev.scope : undefined;
  const projectRootVal = project_root !== undefined ? project_root : prev ? prev.project_root : undefined;
  const meta = {
    id: 'skill-' + name,
    name,
    type: 'skill',
    source_id: source_id || (prev ? prev.source_id : null),
    source_tool: source_tool || (prev ? prev.source_tool : null),
    official: official !== undefined ? official : prev ? prev.official : true,
    // 받은 tags는 그대로 저장만 한다(정규화는 호출부 책임). 미지정 시 이전 값 또는 [].
    tags: tags !== undefined ? tags : (prev ? prev.tags ?? [] : []),
    // scope/project_root는 값이 있을 때만 기록 — 기존(글로벌) 메타 구조를 깨지 않는다.
    ...(scopeVal != null ? { scope: scopeVal } : {}),
    ...(projectRootVal != null ? { project_root: projectRootVal } : {}),
    created_at: prev ? prev.created_at : now,
    updated_at: now,
  };
  fs.writeFileSync(path.join(folder, 'SKILL.md'), body);
  fs.writeFileSync(path.join(folder, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return meta;
}
function listSkills() {
  if (!fs.existsSync(skillsDir())) return [];
  return fs
    .readdirSync(skillsDir(), { withFileTypes: true })
    .filter((e) => e.isDirectory() && skillExists(e.name))
    .map((e) => readSkill(e.name).meta);
}

module.exports = {
  instrDir,
  exists,
  read,
  write,
  agentsDir,
  agentExists,
  readAgent,
  writeAgent,
  listAgents,
  skillsDir,
  skillExists,
  readSkill,
  writeSkill,
  listSkills,
};
