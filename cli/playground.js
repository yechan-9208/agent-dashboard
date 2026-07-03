'use strict';
// ③ 플레이그라운드 엔진 — 읽기 전용 로직 (LLM 없음, 디스크 쓰기 없음).
//
// 흐름: 질문/역할 → 카탈로그에서 "휴리스틱" 추천 → 미리보기(transform 렌더) →
//       (역할의 경우) 에이전트 조합.
//
// 보안/구조 원칙 (코드 차원에서 지킨다):
//   - core.js를 절대 require 하지 않는다(순환 의존 금지). 적용(디스크 쓰기)은 core 담당.
//   - 다른 cli 모듈(store/category/search/duplicate/transform/diff/paths/canonical/mode)은
//     "읽기"만 한다(여기서 수정/쓰기 호출 없음).
//   - 네트워크 호출 없음. 실제 CLI 실행 없음(tryRun은 게이트 후 throw하는 자리만).
//   - LLM 호출 없음. opts.useLLM/llmRefine 는 미래 위임 "자리"만 남긴다.
//
// 미리보기에서 읽는 "배포본"은 transform이 알려주는 targetPath이며, 더미 모드에서는
// 프로젝트 안 fixtures/ 아래를 가리킨다(paths/mode가 보장). 실제 사용자 설정(~/.claude 등)
// 경로를 여기서 직접 만들거나 열지 않는다.

const fs = require('fs');

const store = require('./store');
const category = require('./category');
const duplicate = require('./duplicate');
const transformSkill = require('./transform/skill');
const transformAgent = require('./transform/agent');
const diff = require('./diff');
const paths = require('./paths');
const canonical = require('./canonical');
// mode 는 tryRun 게이트에서만 lazy require 한다(상단 미사용도 무방하나 명확성 위해 함수 내 require).

// ---------- 보조 ----------

// frontmatter(^---\n...\n---\n)를 간단 정규식으로 제거한다.
// gray-matter도 의존성에 있지만, 본문 텍스트 신호만 필요하므로 가벼운 정규식으로 충분.
function stripFrontmatter(body) {
  const s = String(body || '');
  // 파일 맨 앞의 --- ... --- 블록만 제거(여러 줄). 없으면 원문 그대로.
  return s.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

// 이름 → 안전한 slug (소문자, [a-z0-9가-힣-]만, 공백/구두점은 하이픈).
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    || 'agent';
}

// 질의 토큰 중 항목 토큰과 "부분 일치"(서로 substring)하는 비율 (0~1).
// 한국어 조사/활용형 대응: '코드'(질의) ↔ '코드를'(항목)처럼 정확 토큰 Jaccard로는 안 잡히는
// 부분 일치를 보완한다. 너무 짧은(1글자) 토큰은 노이즈라 제외.
function partialCoverage(qText, itemText) {
  const q = [...duplicate.tokenSet(qText)].filter((t) => t.length >= 2);
  if (!q.length) return 0;
  const it = [...duplicate.tokenSet(itemText)];
  let hit = 0;
  for (const a of q) {
    if (it.some((b) => b.includes(a) || a.includes(b))) hit++;
  }
  return hit / q.length;
}

// 카탈로그에서 skill 항목만 추린다.
function skillItems(catalog) {
  return (catalog.items || []).filter((it) => it && it.kind === 'skill');
}

// ---------- 카탈로그 로드 (fallback 포함) ----------

// store.load()로 번들 카탈로그를 읽는다. items가 비면 canonical(읽기)에서 합성한다.
//   - canonical.listSkills() → meta[]; 각 meta.name으로 readSkill()해서 body 확보.
//   - canonical.listAgents() → 중립 스키마[]; 카탈로그 agent 항목으로 감싼다.
// canonical도 비어 있으면 빈 카탈로그({version:0, items:[]})를 그대로 돌려준다.
function loadCatalog() {
  const cat = store.load();
  if (Array.isArray(cat.items) && cat.items.length > 0) {
    return { version: cat.version, items: cat.items };
  }

  // ----- fallback: canonical에서 합성 (읽기 전용) -----
  const items = [];
  try {
    for (const meta of canonical.listSkills()) {
      const rec = canonical.readSkill(meta.name);
      if (!rec) continue;
      const body = rec.body || '';
      // 설명: 메타에 없으면 본문 첫 줄(frontmatter 제거 후)에서 추정.
      let description = (meta && meta.description) || '';
      if (!description) {
        const firstLine = stripFrontmatter(body).split('\n').map((l) => l.trim()).find((l) => l.length > 0);
        description = firstLine || '';
      }
      items.push({
        id: 'cat-skill-' + meta.name,
        kind: 'skill',
        name: meta.name,
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        description,
        body,
      });
    }
  } catch (e) {
    // canonical 미존재/깨짐 → 스킬 합성 생략.
  }
  try {
    for (const neutral of canonical.listAgents()) {
      if (!neutral || !neutral.name) continue;
      items.push({
        id: 'cat-agent-' + neutral.name,
        kind: 'agent',
        name: neutral.name,
        tags: Array.isArray(neutral.tags) ? neutral.tags : [],
        description: neutral.description || '',
        neutral,
      });
    }
  } catch (e) {
    // canonical 미존재/깨짐 → 에이전트 합성 생략.
  }

  return { version: cat.version || 0, items };
}

// ---------- 마법사(정적 질문 세트) ----------

// UI가 폼으로 그릴 정적 질문들. options.tags 는 추천 질의로 누적된다.
function skillWizard() {
  return [
    {
      id: 'task',
      label: '어떤 작업인가요?',
      type: 'single',
      options: [
        { value: 'code', label: '코딩', tags: ['code'] },
        { value: 'review', label: '리뷰', tags: ['review'] },
        { value: 'docs', label: '문서', tags: ['docs'] },
        { value: 'infra', label: '인프라', tags: ['infra'] },
      ],
    },
    {
      id: 'extra',
      label: '추가 성격(복수 선택)',
      type: 'multi',
      options: [
        { value: 'review', label: '검토/품질', tags: ['review'] },
        { value: 'docs', label: '문서화', tags: ['docs'] },
        { value: 'infra', label: '운영/인프라', tags: ['infra'] },
        { value: 'etc', label: '기타', tags: ['etc'] },
      ],
    },
    {
      id: 'keywords',
      label: '핵심 키워드(자유 입력)',
      type: 'text',
    },
  ];
}

// 마법사 답 → 추천 질의 { tags:[], text:'' }.
//   - single/multi 옵션의 tags 를 누적(정규화+중복 제거).
//   - text 타입 답과, 선택된 옵션의 label 도 텍스트 신호로 합친다.
function answersToQuery(answers) {
  const a = answers && typeof answers === 'object' ? answers : {};
  const questions = skillWizard();
  const tags = [];
  const seen = new Set();
  const textParts = [];

  function addTags(list) {
    for (const t of category.normalizeTags(list)) {
      if (seen.has(t)) continue;
      seen.add(t);
      tags.push(t);
    }
  }

  for (const q of questions) {
    const ans = a[q.id];
    if (ans == null) continue;

    if (q.type === 'text') {
      const s = String(ans).trim();
      if (s) textParts.push(s);
      continue;
    }

    // single: 단일 값 / multi: 배열. 양쪽을 배열로 정규화.
    const values = Array.isArray(ans) ? ans : [ans];
    const opts = Array.isArray(q.options) ? q.options : [];
    for (const v of values) {
      const opt = opts.find((o) => o.value === v);
      if (!opt) continue;
      if (Array.isArray(opt.tags)) addTags(opt.tags);
      if (opt.label) textParts.push(opt.label);
    }
  }

  return { tags, text: textParts.join(' ').trim() };
}

// ---------- 스킬 추천(휴리스틱) ----------

// query={tags:[],text:''}. 카탈로그 skill만 대상.
//   score = 0.6 * category.tagMatch(query.tags, item.tags)
//         + 0.4 * duplicate.textSimilarity(query.text, item.description + ' ' + 본문(frontmatter 제거))
//   reasons: 태그/텍스트 신호 설명. score>0만, 내림차순, 상위 opts.topN||5.
//   미래 LLM 자리: opts.useLLM && typeof opts.llmRefine==='function' 이면 opts.llmRefine(top, query) 위임.
function recommendSkills(query, opts = {}) {
  const q = query && typeof query === 'object' ? query : {};
  const qTags = Array.isArray(q.tags) ? q.tags : [];
  const qText = typeof q.text === 'string' ? q.text : '';
  const topN = opts.topN != null ? opts.topN : 5;

  const catalog = loadCatalog();
  const skills = skillItems(catalog);

  const scored = [];
  for (const item of skills) {
    const itemTags = Array.isArray(item.tags) ? item.tags : [];
    const tagScore = category.tagMatch(qTags, itemTags); // 0~1
    const bodyText = stripFrontmatter(item.body || '');
    const itemText = (item.description || '') + ' ' + bodyText;
    // 텍스트 신호 = 단어 Jaccard(정확 일치)와 부분 토큰 커버리지(한국어 조사/활용형 대응) 중 큰 값.
    const jac = duplicate.textSimilarity(qText, itemText); // 0~1 (정확 토큰 교집합)
    const cover = partialCoverage(qText, itemText); // 0~1 (부분 일치 비율)
    const textScore = Math.max(jac, cover);
    const score = 0.6 * tagScore + 0.4 * textScore;
    if (score <= 0) continue;

    // 사람이 읽을 reasons: 임계 넘은 신호만.
    const reasons = [];
    if (tagScore > 0) {
      const overlap = category
        .normalizeTags(qTags)
        .filter((t) => category.normalizeTags(itemTags).includes(t));
      reasons.push(
        overlap.length
          ? `태그 일치 (${tagScore.toFixed(2)}): ${overlap.join(', ')}`
          : `태그 유사 (${tagScore.toFixed(2)})`
      );
    }
    if (textScore > 0) {
      reasons.push(`텍스트 유사 (${textScore.toFixed(2)})`);
    }

    scored.push({
      id: item.id,
      name: item.name,
      description: item.description || '',
      tags: itemTags,
      score,
      reasons,
    });
  }

  // 점수 내림차순. 동점이면 이름 오름차순으로 안정화.
  scored.sort((x, y) => (y.score - x.score) || String(x.name).localeCompare(String(y.name)));
  const top = scored.slice(0, topN);

  // --- 미래 LLM 정제 자리 (기본 꺼짐, 미구현) ---
  // 휴리스틱 상위 결과를 더 다듬고 싶을 때만 켠다. 실제 호출은 여기서 구현하지 않고,
  // 사용자 제공 훅 opts.llmRefine(top, query) 에 위임만 한다.
  if (opts.useLLM === true && typeof opts.llmRefine === 'function') {
    return opts.llmRefine(top, { tags: qTags, text: qText });
  }

  return top;
}

// 역할 텍스트 → 스킬 추천. recommendSkills 재사용.
//   (선택) roleText에서 PRESET 단어가 보이면 query.tags에 추가하는 간단 추출 1단계.
function recommendSkillsForRole(roleText, opts = {}) {
  const text = typeof roleText === 'string' ? roleText : '';
  // 간단 추출: 역할 텍스트를 정규화해 토큰화하고, PRESET에 있는 단어만 태그로.
  const tokens = duplicate.tokenSet(text); // Set of words (소문자)
  const tags = [];
  for (const p of category.PRESET) {
    if (tokens.has(p)) tags.push(p);
  }
  return recommendSkills({ tags, text }, opts);
}

// ---------- 에이전트 조합 ----------

// 추천 스킬들(picked: 카탈로그 항목 배열)을 중립 에이전트 스키마 초안으로 조합한다.
//   - model 은 절대 추측해 채우지 않는다(null).
//   - tools 는 [](스킬엔 tool 정보가 없음).
//   - tags 는 picked 의 tags 를 모아 중복 제거.
function composeAgent({ roleText, picked, name } = {}) {
  const role = (typeof roleText === 'string' ? roleText : '').trim();
  const list = Array.isArray(picked) ? picked.filter(Boolean) : [];
  const displayName = (name && String(name).trim()) || (role ? role : 'agent');

  // system_prompt: 역할 + 활용 스킬 목록 + 안전/정직/로컬 원칙.
  const skillLines = list.map((s) => {
    const sName = s.name || (s.neutral && s.neutral.name) || s.id || 'skill';
    const sDesc = s.description || (s.neutral && s.neutral.description) || '';
    return `- ${sName}: ${sDesc}`;
  });
  const skillBlock = skillLines.length ? skillLines.join('\n') : '- (선택된 스킬 없음)';
  const system_prompt =
    `너는 ${role || displayName} 역할의 에이전트다.\n\n` +
    `활용할 스킬:\n${skillBlock}\n\n` +
    `안전·정직(손실 표시)·로컬 전용 원칙을 지킨다.`;

  // tags: picked 각 항목의 tags 누적 → 정규화/중복 제거.
  const allTags = [];
  for (const s of list) {
    if (Array.isArray(s.tags)) allTags.push(...s.tags);
  }
  const tags = category.normalizeTags(allTags);

  const sourceNames = list
    .map((s) => s.name || (s.neutral && s.neutral.name) || s.id)
    .filter(Boolean);

  return {
    id: 'agent-' + slugify(displayName),
    name: displayName,
    description: role ? `${role} 역할의 조합 에이전트` : '조합 에이전트',
    system_prompt,
    model: null, // 절대 추측 금지
    tools: [], // 스킬엔 tool 정보 없음
    tags,
    source_tool: 'playground',
    source_notes: '조합: ' + (sourceNames.length ? sourceNames.join(', ') : '(없음)'),
  };
}

// ---------- 미리보기 (transform 렌더, 쓰기 없음) ----------

// 배포본이 있으면 읽어 diff를 만든다(읽기 전용). 없거나 못 읽으면 null diff.
// targetPath 는 transform이 알려주는 경로(더미 모드면 fixtures 아래).
function diffAgainstDeployed(targetPath, newContent) {
  let oldContent = null;
  try {
    if (targetPath && fs.existsSync(targetPath)) {
      oldContent = fs.readFileSync(targetPath, 'utf8');
    }
  } catch (e) {
    oldContent = null;
  }
  if (oldContent == null) {
    return { diff: null, diffText: '' };
  }
  const d = diff.lineDiff(oldContent, newContent);
  return { diff: d, diffText: diff.renderHunked(d) };
}

// 카탈로그 skill 항목을 3개 도구로 렌더(쓰기 없음). 손실 포함.
//   → { kind:'skill', name, body, perTool:[{ to, targetPath, diff, diffText, losses }] }
function previewSkill(item) {
  const it = item && typeof item === 'object' ? item : {};
  const body = it.body || '';
  const name = it.name || '';

  const perTool = paths.TOOLS.map((tool) => {
    const r = transformSkill.render(body, name, tool); // { tool, name, targetPath, content, losses }
    const { diff: d, diffText } = diffAgainstDeployed(r.targetPath, r.content);
    return {
      to: tool,
      targetPath: r.targetPath,
      diff: d,
      diffText,
      losses: r.losses || [],
    };
  });

  return { kind: 'skill', name, body, perTool };
}

// 중립 에이전트를 3개 도구로 렌더(쓰기 없음). 손실 포함(Codex tools 전손실 등).
//   → { kind:'agent', id, perTool:[{ to, targetPath, content, diff, diffText, losses }] }
function previewAgent(neutral) {
  const n = neutral && typeof neutral === 'object' ? neutral : {};
  const name = n.name || '';

  const perTool = paths.TOOLS.map((tool) => {
    const r = transformAgent.render(n, tool); // { tool, ext, content, losses }  (targetPath 없음)
    const targetPath = paths.agentPath(tool, name);
    const { diff: d, diffText } = diffAgainstDeployed(targetPath, r.content);
    return {
      to: tool,
      targetPath,
      content: r.content,
      diff: d,
      diffText,
      losses: r.losses || [],
    };
  });

  return { kind: 'agent', id: n.id || ('agent-' + slugify(name)), perTool };
}

// ---------- 실제 실행(다음 단계 자리 — 미구현) ----------

function tryRun() {
  throw new Error('NOT_IMPLEMENTED: 헤드리스 실행은 다음 단계');
}

module.exports = {
  loadCatalog,
  skillWizard,
  answersToQuery,
  recommendSkills,
  recommendSkillsForRole,
  composeAgent,
  previewSkill,
  previewAgent,
  tryRun,
};

// ---------- 파일 끝 검증 데모 (부작용 없는 것만 — 디스크 쓰기/실제실행 호출 금지) ----------
if (require.main === module) {
  console.log('wizard Q수:', skillWizard().length);
  const recs = recommendSkills({ tags: ['review'], text: '코드 리뷰' });
  console.log('추천:', recs.map((r) => r.name + '(' + r.score.toFixed(2) + ')'));
  const ag = composeAgent({ roleText: '코드 리뷰 자동화', picked: recs.slice(0, 2), name: '' });
  console.log('compose tools/tags:', ag.tools, ag.tags, '| model:', ag.model);
  console.log('previewAgent losses:', previewAgent(ag).perTool.map((t) => t.to + '=' + t.losses.length));
}
