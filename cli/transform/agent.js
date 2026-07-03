'use strict';
// 트랙 B — agent 변환. 중립 스키마 ↔ 두 도구 포맷.
//  - Claude: .md + YAML frontmatter, 본문 = system_prompt   (gray-matter)
//  - Codex:  .toml, developer_instructions = system_prompt   (@iarna/toml)
//  - tools: Codex는 에이전트별 tools 필드가 없어 "손실(⚠)"로 표시.
//    (과거 gemini 지원 시 Claude↔Gemini 이름 매핑이 있었으나 gemini 제거로 함께 삭제.)
//
// 중립 스키마(JSON):
//   { id, name, description, system_prompt, model, tools:[Claude이름...], source_tool, source_notes }

const matter = require('gray-matter');
const TOML = require('@iarna/toml');

// ---------- 중립 스키마 → 각 도구 포맷 (render) ----------
function render(neutral, tool) {
  const losses = [];
  if (tool === 'claude') {
    const fm = clean({ name: neutral.name, description: neutral.description, model: neutral.model, tools: neutral.tools });
    return { tool, ext: '.md', content: matter.stringify('\n' + (neutral.system_prompt || ''), fm), losses };
  }
  if (tool === 'codex') {
    // Codex는 에이전트별 tools 필드가 없음 → tools 전부 손실
    for (const t of neutral.tools || []) losses.push(`tools: '${t}' → Codex 미지원(에이전트별 tools 없음)`);
    const obj = clean({
      name: neutral.name,
      description: neutral.description,
      model: neutral.model,
      developer_instructions: neutral.system_prompt || '',
    });
    return { tool, ext: '.toml', content: TOML.stringify(obj), losses };
  }
  throw new Error('알 수 없는 도구: ' + tool);
}

// ---------- 각 도구 포맷 → 중립 스키마 (parse, pull용) ----------
function parse(content, tool, name) {
  if (tool === 'claude') {
    const { data, content: body } = matter(content);
    return base(name, data, body.trim(), data.tools || [], 'claude');
  }
  if (tool === 'codex') {
    const data = TOML.parse(content);
    // Codex는 tools가 없음 → 중립 tools는 빈 배열
    const n = base(name, data, (data.developer_instructions || '').trim(), [], 'codex');
    return n;
  }
  throw new Error('알 수 없는 도구: ' + tool);
}

// ---------- 보조 ----------
function base(name, data, systemPrompt, tools, sourceTool) {
  return {
    id: 'agent-' + (data.name || name),
    name: data.name || name,
    description: data.description || '',
    system_prompt: systemPrompt,
    model: data.model || null,
    tools,
    source_tool: sourceTool,
  };
}

// undefined/null/빈배열 필드는 빼서 출력이 깔끔하도록
function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

module.exports = { render, parse };
