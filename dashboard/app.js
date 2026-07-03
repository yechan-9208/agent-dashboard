'use strict';
// 대시보드 동작 (SPA). 사이드바 네비 → 7뷰 토글. 버튼 → fetch(서버 엔드포인트).
// 무거운 로직은 서버/CLI(core)에 있다. 동작/엔드포인트/흐름은 기존과 100% 동일하게 유지하고
// 모양만 design-system.css(Apple Design System)로 입힌다.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- 상태 ----
// (PI 게이트 제거 — currentPullTool/currentAgentPull/currentSkillPull/currentStoreApply
//  같은 PI 재시도 컨텍스트 상태는 삭제. 백엔드가 409 PI를 더 이상 내지 않는다.)
// (지시문 동기화 상태 currentInstrSync 제거 — 지시문은 비교 전용.)
// 태그(카테고리) 필터 — F4: 단일 선택 → 다중 선택(Set) + OR 매칭. 빈 Set = [전체].
// 여러 칩이 활성이면 "선택된 태그 중 하나라도 가진" 행을 표시한다. 스킬·에이전트·스토어가 공유한다.
let activeTags = new Set();    // 활성 태그 집합(클라이언트). 비어 있으면 전체.
let conflictCtx = null;       // 충돌 모달: 어떤 적용을 재시도할지 {type, ...}
// SKC2: 스토어 퍼블리셔 드릴다운 상태. storePublisher=null이면 카드 그리드(기본).
let storePublisher = null;    // 선택된 퍼블리셔 {slug, name, actualSkillCount, repos}
let storeCatTag = null;       // 드릴다운 카테고리 필터(skill-tags key). 기존 activeTag와 분리.

// 카테고리 어휘 12종(정규화 키 = cli/category.js PRESET과 일치). 모든 화면의 고정 칩 바 기준.
// 항상 이 12개를 [전체]와 함께 표시하고, 12개 밖 커스텀 태그는 뒤에 자연 나열한다.
const CATEGORY_KEYS = ['ui', '서버', '앱', 'devops', 'ai', 'db', '보안', '테스트', '문서', '디자인', '코드', '리뷰'];
// 표시 라벨 맵: ascii 4종만 표기 변환, 한글은 그대로. 칩·태그 컬럼·상세 공용.
const CATEGORY_LABEL = { ui: 'UI', devops: 'devOps', ai: 'AI', db: 'DB' };
function catLabel(key) { return CATEGORY_LABEL[key] || key; }
// SKC2 하위호환: 스토어 드릴다운 카테고리 칩도 같은 12종을 사용한다.
const CATEGORY_TAGS = CATEGORY_KEYS.map((k) => ({ key: k, ko: catLabel(k) }));

// 도구 표시색(인라인 dot/칩에 사용). CSS 토큰과 동일. (2모델 체제 — claude/codex.)
const TOOL_COLOR = { claude: 'var(--tool-claude)', codex: 'var(--tool-codex)' };
const TOOL_SOFT = { claude: 'var(--tool-claude-soft)', codex: 'var(--tool-codex-soft)' };
const TOOLS = ['claude', 'codex'];

// skill source_id → 기준 도구(baseTool). server SKILL_TOOL_SOURCE의 역방향.
// (claude-user→claude, shared-agents→codex) 매핑 밖이면 접두사로 추정.
const SKILL_SOURCE_TOOL = { 'claude-user': 'claude', 'shared-agents': 'codex' };
function skillSourceTool(sourceId) {
  if (SKILL_SOURCE_TOOL[sourceId]) return SKILL_SOURCE_TOOL[sourceId];
  const s = String(sourceId || '');
  return TOOLS.find((t) => s.startsWith(t)) || 'claude';
}
// 단건 동기화 모달의 직전 기준 도구(같은 세션 내 다음 모달 기본 선택값) — #8.
let lastSyncBase = null;

const VIEW_META = {
  overview: { title: '개요', sub: '두 모델(Claude · Codex)의 설정을 한눈에' },
  instructions: { title: '지시문', sub: '글로벌 지시문(CLAUDE.md · AGENTS.md)을 좌우로 비교' },
  skills: { title: '스킬', sub: '경로별 스킬이 두 모델 간 동기화됐는지' },
  usage: { title: '사용량', sub: '스킬을 얼마나 자주 쓰는지 · Claude 세션 기록 기준' },
  // 에이전트·플레이그라운드·스토어 뷰는 숨김(D32 패턴) — showView가 미등록 뷰를 overview로
  // 폴백하므로 이 목록에서 빼는 것만으로 해시 접근까지 차단된다. 스토어는 완료 기준상 숨김
  // 대상(store 관련 마크업/함수는 도달 불가 dead code로 남겨도 무해). 복원: docs/plan/todo.md.
};

// 뷰별 1회 로드 여부(처음 열릴 때/새로고침 시 로드, 자동 호출 최소화)
const loaded = {};

function toast(msg) {
  $('#toast-msg').textContent = msg;
  $('#toast').classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => $('#toast').classList.remove('show'), 2600);
}

// ---- 우아한 실패: 공통 fetch 래퍼 (#6) ----
// fetch 후 응답이 정상이 아니면(!res.ok) 서버의 {error} 또는 상태코드로 throw.
// 던져진 에러에 .status를 실어 호출부가 필요 시 분기할 수 있게 한다(일반 오류 토스트로 소비).
async function api(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    let body = {};
    try { body = await res.json(); } catch { }
    const err = new Error(body.error || `요청 실패 (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.json();
}

// 조회(load*) 실패 시 컨테이너에 "다시 시도" 인라인 안내를 그린다(다른 위젯은 계속 동작).
// target: CSS 선택자 또는 엘리먼트. rowCols가 있으면 <table> tbody 용 <tr><td colspan>로.
function showLoadError(target, retryFn, rowCols) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  const btnId = 'retry-' + Math.random().toString(36).slice(2, 8);
  const inner = `<span class="load-error"><span class="le-ic">⚠</span> 불러오지 못했습니다 <button class="btn btn-ghost btn-sm" id="${btnId}">다시 시도</button></span>`;
  el.innerHTML = rowCols ? `<tr><td colspan="${rowCols}" class="skel">${inner}</td></tr>` : `<div class="empty-state">${inner}</div>`;
  const btn = $('#' + btnId);
  if (btn) btn.addEventListener('click', () => { try { retryFn(); } catch { } });
}

// 로딩 표시: 컨테이너에 "불러오는 중…" 스켈레톤을 먼저 그린다(완료 시 교체).
function showLoading(target, rowCols, msg) {
  const el = typeof target === 'string' ? $(target) : target;
  if (!el) return;
  const text = esc(msg || '불러오는 중…');
  el.innerHTML = rowCols ? `<tr><td colspan="${rowCols}" class="skel">${text}</td></tr>` : `<div class="skel">${text}</div>`;
}

// 과제1: "미정" 특수 태그 키. 12 카테고리 밖의 예약어(커스텀 태그와 충돌하지 않게 접두사 사용).
// 정의: tags(매핑된 카테고리)와 autoTags가 "모두 비어 있는" 행 = 미정. (커스텀 태그만 있는 항목은
// 그 커스텀 칩으로 분류되므로 미정이 아니다 — tags에는 12종 밖 커스텀도 들어올 수 있으나,
// 매트릭스 rows의 tags는 category.mapLegacyTags로 12종 어휘만 남으므로 사실상 카테고리 판정과 일치.)
const UNTAGGED_KEY = '__untagged__';
// 항목이 미정인지: 매핑된 tags·autoTags가 모두 비었으면 true.
function isUntagged(item) {
  return !((item.tags || []).length) && !((item.autoTags || []).length);
}

// 태그 칩 렌더: tags(변환된 카테고리 — 라벨 맵 적용) + autoTags(이름으로 자동 분류 — 은은한 스타일).
// autoTags는 tags가 비었을 때만 서버가 채운다(둘이 겹치지 않음). 툴팁으로 자동 분류임을 알린다.
// 과제1: 둘 다 비어 있으면(미정) 빈칸 대신 은은한 "미정" 칩을 표시한다.
function tagChipsHtml(tags, autoTags) {
  const main = (tags || []).map((t) => `<span class="tok-chip">${esc(catLabel(t))}</span>`).join('');
  const auto = (autoTags || []).map((t) => `<span class="tok-chip auto" title="이름으로 자동 분류됨">${esc(catLabel(t))}</span>`).join('');
  if (!main && !auto) return `<span class="tok-chip untagged" title="분류되지 않은 항목입니다">미정</span>`;
  return main + auto;
}
// OR 매칭: 활성 태그가 없으면 통과, 있으면 항목의 tags 또는 autoTags 중 하나라도 활성 집합에 있으면 통과.
// 과제1: 특수 키 UNTAGGED_KEY가 활성 집합에 있으면 미정 행도 통과(다중 OR에 자연 결합).
function tagMatch(item) {
  if (activeTags.size === 0) return true;
  if (activeTags.has(UNTAGGED_KEY) && isUntagged(item)) return true;
  const tags = item.tags || [];
  for (const t of tags) if (activeTags.has(t)) return true;
  const auto = item.autoTags || [];
  for (const t of auto) if (activeTags.has(t)) return true;
  return false;
}
// 카테고리별 항목 수 집계(tags + autoTags 합집합 기준, 항목당 카테고리 중복은 1회만). 칩 개수 배지용.
// 과제1: 미정(둘 다 빈) 항목은 UNTAGGED_KEY 개수로 함께 집계한다("미정" 칩 배지용).
function categoryCounts(items) {
  const counts = {};
  for (const it of items || []) {
    if (isUntagged(it)) { counts[UNTAGGED_KEY] = (counts[UNTAGGED_KEY] || 0) + 1; continue; }
    const seen = new Set();
    for (const t of (it.tags || []).concat(it.autoTags || [])) {
      if (seen.has(t)) continue;
      seen.add(t);
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}

function formatDateHuman(value) {
  if (!value) return '–';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const suffix = diff >= 0 ? '전' : '후';
  if (mins < 1) return '방금';
  if (mins < 60) return `${mins}분 ${suffix}`;
  if (hrs < 24) return `${hrs}시간 ${suffix}`;
  if (days < 7) return `${days}일 ${suffix}`;
  return d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' });
}

function scoreInfo(score) {
  const n = Number(score) || 0;
  if (n >= 0.75) return { cls: 'high', label: '높음', detail: n.toFixed(2) };
  if (n >= 0.30) return { cls: 'mid', label: '보통', detail: n.toFixed(2) };
  return { cls: 'low', label: '낮음', detail: n.toFixed(2) };
}

function reasonsHuman(reasons) {
  const txt = (reasons || []).join('; ');
  if (!txt) return '선택한 조건과 부분적으로 맞습니다.';
  return txt.replace(/태그 일치 \(([^)]+)\):/g, '맞는 태그:').replace(/;/g, ' · ');
}

// 마지막 경로 조각(프로젝트 폴더명) 추출 — 스코프 배지 라벨용.
function baseName(p) {
  if (!p) return '';
  const parts = String(p).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}
// T3: 스코프 배지. project는 폴더명 칩, global은 은은한 표시(없음에 가깝게).
function scopeBadge(scope, projectRoot) {
  if (scope === 'project') {
    const folder = baseName(projectRoot);
    return `<span class="scope-badge">project${folder ? ` <span class="sb-folder">${esc(folder)}</span>` : ''}</span>`;
  }
  return '<span class="scope-badge global">global</span>';
}

// diff 라인을 design-system .diff/.diff-add/.diff-del 로 렌더
function renderDiff(lines) {
  if (!lines || !lines.length) return '<div class="muted" style="padding:10px">(차이 없음)</div>';
  const html = lines.map((l) => {
    const cls = l.type === '+' ? 'diff-add' : l.type === '-' ? 'diff-del' : '';
    return `<div class="diff-line ${cls}"><span class="sign">${l.type === ' ' ? '' : esc(l.type)}</span>${esc(l.line)}</div>`;
  }).join('');
  return `<div class="diff">${html}</div>`;
}
function lossBanner(losses) {
  if (!losses || !losses.length) {
    return `<div class="loss-banner ok"><span class="lb-ic">✓</span><div class="lb-txt">이 변환에서 손실되는 항목이 없습니다.</div></div>`;
  }
  return `<div class="loss-banner"><span class="lb-ic">⚠</span><div class="lb-txt"><b>변환 시 손실되는 항목</b><br>${losses.map(esc).join('<br>')}</div></div>`;
}

// ---- 좌우(side-by-side) diff 컴포넌트 (공용: 지시문·스킬 공유) ----
// 문자 단위 하이라이트: 두 문자열의 공통 접두/접미를 제거해 "가운데 바뀐 구간"만 골라낸다.
// 간단하고 결정적이며(순수 함수) LCS보다 가벼움 — 한 줄 안에서 바뀐 토큰만 진한 빨강으로 감싼다.
// 반환: {left, right} = 하이라이트 <mark>가 삽입된 esc된 HTML 문자열.
function charHighlight(a, b) {
  a = String(a == null ? '' : a);
  b = String(b == null ? '' : b);
  const la = a.length, lb = b.length;
  // 공통 접두 길이.
  let p = 0;
  while (p < la && p < lb && a[p] === b[p]) p++;
  // 공통 접미 길이(접두 구간을 침범하지 않게 제한).
  let s = 0;
  while (s < (la - p) && s < (lb - p) && a[la - 1 - s] === b[lb - 1 - s]) s++;
  const wrap = (full, midStart, midEnd) => {
    const pre = esc(full.slice(0, midStart));
    const mid = full.slice(midStart, midEnd);
    const post = esc(full.slice(midEnd));
    const midHtml = mid ? `<mark class="sxs-ch">${esc(mid)}</mark>` : '';
    return pre + midHtml + post;
  };
  return { left: wrap(a, p, la - s), right: wrap(b, p, lb - s) };
}

// renderSideBySide(sb, opts): sb=sideBySide rows(서버 계약), opts={leftLabel,rightLabel,leftPath,rightPath,onPickBase?}.
//  · 2열 그리드. same=양쪽 평범 / change=양쪽 붉은 배경+문자 하이라이트 / left=왼쪽 줄+오른쪽 빗금 / right=반대.
//  · onPickBase가 있으면 상단에 "◀ <left> 기준 / <right> 기준 ▶" 버튼(data-sxs-base=tool). tool은 leftTool/rightTool.
//  줄번호(n) 표시, filler(n=null)는 빈 빗금칸. 반환: HTML 문자열(호출부가 삽입).
function renderSideBySide(sb, opts) {
  opts = opts || {};
  const leftLabel = opts.leftLabel || 'claude';
  const rightLabel = opts.rightLabel || 'codex';
  const leftTool = opts.leftTool || 'claude';
  const rightTool = opts.rightTool || 'codex';
  const rows = Array.isArray(sb) ? sb : [];
  const cellNum = (n) => `<span class="sxs-num">${n == null ? '' : n}</span>`;
  const rowsHtml = rows.map((r) => {
    const type = r.type;
    const L = r.left || { n: null, line: null };
    const R = r.right || { n: null, line: null };
    if (type === 'change') {
      const hl = charHighlight(L.line, R.line);
      return `<div class="sxs-line">
        <div class="sxs-cell chg">${cellNum(L.n)}<code class="sxs-code">${hl.left}</code></div>
        <div class="sxs-cell chg">${cellNum(R.n)}<code class="sxs-code">${hl.right}</code></div>
      </div>`;
    }
    if (type === 'left') {
      return `<div class="sxs-line">
        <div class="sxs-cell only">${cellNum(L.n)}<code class="sxs-code">${esc(L.line || '')}</code></div>
        <div class="sxs-cell filler">${cellNum(null)}<code class="sxs-code"></code></div>
      </div>`;
    }
    if (type === 'right') {
      return `<div class="sxs-line">
        <div class="sxs-cell filler">${cellNum(null)}<code class="sxs-code"></code></div>
        <div class="sxs-cell only">${cellNum(R.n)}<code class="sxs-code">${esc(R.line || '')}</code></div>
      </div>`;
    }
    // same
    return `<div class="sxs-line">
      <div class="sxs-cell">${cellNum(L.n)}<code class="sxs-code">${esc(L.line || '')}</code></div>
      <div class="sxs-cell">${cellNum(R.n)}<code class="sxs-code">${esc(R.line || '')}</code></div>
    </div>`;
  }).join('');

  // 기준 선택 바(이미지의 방향 화살표 역할). onPickBase 있을 때만.
  const baseBar = opts.onPickBase
    ? `<div class="sxs-basebar">
        <button class="btn btn-secondary btn-sm" data-sxs-base="${esc(leftTool)}">◀ ${esc(leftLabel)} 기준</button>
        <span class="sxs-base-hint">기준으로 고른 쪽 내용을 반대쪽에 맞춥니다</span>
        <button class="btn btn-secondary btn-sm" data-sxs-base="${esc(rightTool)}">${esc(rightLabel)} 기준 ▶</button>
      </div>`
    : '';

  // (v2) 헤더 = 모델색 톤(tool-claude 보라 / tool-codex 청록) + 모델 dot.
  return `${baseBar}<div class="sxs">
    <div class="sxs-headrow">
      <div class="sxs-head tool-${esc(leftTool)}">
        <span class="tool-dot-lg"></span>
        <span class="sxs-head-name">${esc(leftLabel)}</span>
        ${opts.leftPath ? `<span class="sxs-head-path" title="${esc(opts.leftPath)}">${esc(opts.leftPath)}</span>` : ''}
      </div>
      <div class="sxs-head tool-${esc(rightTool)}">
        <span class="tool-dot-lg"></span>
        <span class="sxs-head-name">${esc(rightLabel)}</span>
        ${opts.rightPath ? `<span class="sxs-head-path" title="${esc(opts.rightPath)}">${esc(opts.rightPath)}</span>` : ''}
      </div>
    </div>
    <div class="sxs-body">${rowsHtml || '<div class="muted" style="padding:14px">(내용 없음)</div>'}</div>
  </div>`;
}

// ---- 슬라이드오버(공용) ----
function openPanel({ title, meta, bodyHtml, footHtml }) {
  $('#panel-title').textContent = title || '';
  $('#panel-meta').innerHTML = meta || '';
  $('#panel-body').innerHTML = bodyHtml || '';
  $('#panel-foot').innerHTML = footHtml || '';
  $('#scrim').classList.add('open');
  $('#panel').classList.add('open');
}
function closePanel() {
  $('#scrim').classList.remove('open');
  $('#panel').classList.remove('open');
}

// ===================== 라우팅(SPA) =====================
function showView(view) {
  if (!VIEW_META[view]) view = 'overview';
  // 사이드바 + 상단 가로 메뉴 둘 다 활성 상태를 맞춘다(같은 뷰 목록 공유).
  $$('.nav-item, .topnav-tab').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  $$('section[data-panel]').forEach((s) => (s.hidden = s.dataset.panel !== view));
  $('#topbar-title').textContent = VIEW_META[view].title;
  $('#topbar-sub').textContent = VIEW_META[view].sub;
  // 상단 검색은 스토어 전용이었으나 스토어 뷰가 숨겨져(D32) 어느 뷰에서도 쓰지 않는다.
  const gs = $('#global-search'); if (gs) gs.hidden = true;
  if (location.hash.slice(1) !== view) location.hash = view;
  ensureLoaded(view);
}

// 뷰가 처음 열릴 때(또는 강제) 데이터 로드
function ensureLoaded(view, force) {
  if (loaded[view] && !force) return;
  loaded[view] = true;
  if (view === 'overview') loadOverview();
  else if (view === 'instructions') loadInstructions();
  else if (view === 'skills') { loadTags(); loadSkillOverview(force); }
  else if (view === 'agents') { loadTags(); loadAgentOverview(force); }
  else if (view === 'store') { loadTags(); loadStore(); }
  else if (view === 'playground') loadPgWizard();
  else if (view === 'usage') { loadUsage(); }
}

// ===================== 개요(overview, 첫 화면) — 스킬 상태 요약 =====================
// 4 stat = 스킬 개수 · 지난 1일 수정 · 지난 7일 수정 · 동기화 필요.
// "수정"은 매트릭스 rows[].lastModified(ISO|null) 기준(사용/호출 데이터 없음 — 부제에 명시).
// 분포는 categoryCounts로 뽑은 상위 5 카테고리 순위 목록으로 교체.
async function loadOverview() {
  showLoading('#ov-stats');
  // 스킬 매트릭스만 fetch(에이전트·스토어 뷰 숨김, D32). 프로젝트 수는 액션 가이드용.
  // (이슈1) fetchMatrix로 받아 mxState 캐시에 저장 — 시작 배지·스킬 뷰와 in-flight/캐시 공유.
  // allSettled: 하나가 실패해도 나머지는 렌더된다(우아한 실패, D26-②).
  // 사용량(/usage)은 Claude 세션 기록의 실제 호출 횟수(B 신호) — 사용량 뷰와 같은 기준.
  const settled = await Promise.allSettled([
    fetchMatrix('skill'), api('/projects'), api('/usage'),
  ]);
  if (settled.every((s) => s.status === 'rejected')) {
    showLoadError('#ov-stats', loadOverview);
    return;
  }
  const val = (i, dflt) => (settled[i].status === 'fulfilled' ? settled[i].value : dflt);
  const mSkill = val(0, { counts: {}, rows: [] }), proj = val(1, { projects: [] }), usage = val(2, { items: [] });

  const rows = mSkill.rows || [];
  const skillCount = rows.length;
  // "사용" 집계: 세션 기록에서 그 기간에 1번이라도 호출된 스킬 수(사용량 뷰의 freq와 동일 소스).
  const uItems = usage.items || [];
  const mod1 = uItems.filter((x) => ((x.freq && x.freq.day1) || 0) > 0).length;
  const mod7 = uItems.filter((x) => ((x.freq && x.freq.day7) || 0) > 0).length;
  // 동기화 필요 = syncState !== 'synced'(불일치·일부없음·단독 모두 포함).
  const needSync = rows.filter((r) => r.syncState !== 'synced').length;
  const sc = stateCounts(rows); // {synced, drift, partial, single}

  setCount('skills', skillCount);

  // (v2) 실행형 배너: 동기화 필요 N개 + [스킬 상태 보기](주의 필터로 이동).
  const guide = $('#ov-guide');
  if (guide) {
    const warnIc = `<span class="wb-ic"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 6.2v3.6M9 12.1v.05"/><path d="M9 2.5 1.8 15h14.4z"/></svg></span>`;
    const okIc = `<span class="wb-ic"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 9.5 7.5 13.5 14.5 5"/></svg></span>`;
    guide.innerHTML = needSync
      ? `<div class="warn-banner">${warnIc}
          <div class="wb-main">
            <div class="wb-title">동기화가 필요한 스킬 ${needSync}개</div>
            <div class="wb-sub">두 모델의 내용이 아직 다릅니다 · 모든 적용은 미리보기(diff) 확인 후 진행됩니다</div>
          </div>
          <button class="btn btn-secondary btn-sm" data-goto-skills-filter="attention">스킬 상태 보기</button>
        </div>`
      : `<div class="warn-banner ok">${okIc}
          <div class="wb-main">
            <div class="wb-title">모든 스킬이 맞춰져 있어요</div>
            <div class="wb-sub">두 모델의 스킬 내용이 동일합니다</div>
          </div>
          <button class="btn btn-secondary btn-sm" data-goto="skills">스킬 보기</button>
        </div>`;
  }

  // 온보딩 카드: 스킬이 하나도 없을 때(스토어 링크 제거 — 뷰 숨김).
  const onboard = $('#ov-onboard');
  if (onboard) {
    if (skillCount === 0) {
      onboard.hidden = false;
      onboard.innerHTML = `<div class="onboard-card">
        <div class="onboard-ic">👋</div>
        <div class="onboard-body">
          <div class="onboard-title">아직 스킬이 하나도 없어요.</div>
          <div class="onboard-steps">프로젝트를 추가하면 그 안의 스킬도 자동으로 보입니다.</div>
          <div class="inline-acts" style="margin-top:12px">
            <button class="btn btn-secondary btn-sm" data-open-projects="1">프로젝트 관리</button>
          </div>
        </div>
      </div>`;
    } else {
      onboard.hidden = true;
      onboard.innerHTML = '';
    }
  }

  // (v2) 4 스탯 카드 — 전부 흰 카드, 카드 전체 클릭 이동, 우측 코너는 화살표(주의 카드는 배지).
  const cornerArrow = `<span class="stat-corner"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 8h8M8.5 4.5 12 8l-3.5 3.5"/></svg></span>`;
  const stats = [
    { label: '전체 스킬', num: skillCount, trend: '모델 간 동기화 대상', view: 'skills', corner: cornerArrow },
    { label: '지난 1일 사용', num: mod1, trend: '24시간 안에 쓴 스킬', view: 'usage', corner: cornerArrow },
    { label: '지난 7일 사용', num: mod7, trend: '7일 안에 쓴 스킬', view: 'usage', corner: cornerArrow },
    { label: '동기화 필요', num: needSync, trend: '두 모델이 아직 다름', view: 'skills', corner: needSync ? '<span class="badge warn" style="font-size:11px;padding:2px 9px">주의</span>' : cornerArrow, filter: 'attention' },
  ];
  $('#ov-stats').innerHTML = stats.map((s) => `
    <button class="stat" ${s.filter ? `data-goto-skills-filter="${s.filter}"` : `data-goto="${s.view}"`}>
      <div class="stat-head"><span class="stat-label">${esc(s.label)}</span>${s.corner}</div>
      <div class="stat-num">${esc(String(s.num))}</div>
      <div class="stat-trend">${esc(s.trend)}</div>
    </button>`).join('');

  // (v2) 동기화 상태 카드: 3색 분해 막대 + 상태 행(클릭 → 스킬 뷰 해당 필터).
  const syncW = $('#ov-sync-widget');
  if (syncW) {
    const attention = (sc.drift || 0) + (sc.partial || 0); // "불일치" 행 = 양쪽 존재·내용 다름(일부없음 포함)
    const pct = (n) => skillCount ? Math.max(n > 0 ? 1.5 : 0, (n / skillCount) * 100) : 0;
    syncW.innerHTML = `
      <div class="widget-head"><div class="widget-title">동기화 상태</div><span class="widget-sub">전체 ${skillCount}개 기준</span></div>
      <div class="sync-stack">
        <span class="ss-ok" style="width:${pct(sc.synced || 0)}%"></span>
        <span class="ss-warn" style="width:${pct(attention)}%"></span>
        <span class="ss-solo" style="width:${pct(sc.single || 0)}%"></span>
      </div>
      <div class="sync-rows">
        <button class="sync-row" data-goto-skills-filter="synced">
          <span class="sr-dot" style="background:var(--st-ok-dot)"></span>
          <span class="sr-label">동기화됨</span><span class="sr-desc">양쪽 동일</span><span class="sr-num">${sc.synced || 0}</span>
        </button>
        <button class="sync-row" data-goto-skills-filter="attention">
          <span class="sr-dot" style="background:var(--st-warn-dot)"></span>
          <span class="sr-label">불일치</span><span class="sr-desc">양쪽 존재 · 내용 다름</span><span class="sr-num">${attention}</span>
        </button>
        <button class="sync-row" data-goto-skills-filter="single">
          <span class="sr-dot" style="background:var(--st-solo-dot)"></span>
          <span class="sr-label">단독</span><span class="sr-desc">한쪽에만 있음</span><span class="sr-num">${sc.single || 0}</span>
        </button>
      </div>`;
  }

  // 카테고리 TOP 5 순위(가장 스킬 수 많은 카테고리, 순위 막대 포함).
  // "미정"(분류 없음)은 순위에서 제외 — 실제 카테고리만 보여준다. 동점은 라벨순, 5개 미만/0개도 우아하게.
  const counts = categoryCounts(rows);
  const ranked = Object.entries(counts)
    .filter(([key]) => key !== UNTAGGED_KEY)
    .map(([key, n]) => ({ key, n, label: catLabel(key) }))
    .sort((a, b) => (b.n - a.n) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
    .slice(0, 5);
  const maxRank = ranked.length ? ranked[0].n : 1;
  const dist = $('#ov-dist');
  if (dist) {
    dist.innerHTML = ranked.length
      ? ranked.map((r, i) => `
        <div class="dist-row rank-row">
          <span class="dist-rank">${i + 1}</span>
          <span class="dist-label">${esc(r.label)}</span>
          <span class="dist-bar"><div style="width:${Math.round((r.n / maxRank) * 100)}%"></div></span>
          <span class="dist-num">${r.n}</span>
        </div>`).join('')
      : '<div class="empty-state" style="padding:16px">아직 분류된 스킬이 없습니다.</div>';
  }

  // (v2) 최근 사용 카드: lastUsed 최신순 상위 4개 + "사용량 보기 ›".
  const recentW = $('#ov-recent-widget');
  if (recentW) {
    const recent = uItems
      .filter((x) => x.lastUsed)
      .sort((a, b) => new Date(b.lastUsed) - new Date(a.lastUsed))
      .slice(0, 4);
    const rowsHtml = recent.map((x) => {
      const wk = (x.freq && x.freq.day7) || 0;
      const cnt = wk > 0 ? `<span class="ru-cnt">7일 ${wk}회</span>` : `<span class="ru-cnt none">—</span>`;
      return `<div class="ru-row"><span class="ru-name">${esc(x.name)}</span><span class="ru-when">${esc(formatDateHuman(x.lastUsed))}</span>${cnt}</div>`;
    }).join('');
    recentW.innerHTML = `
      <div class="widget-head"><div class="widget-title">최근 사용</div><button class="widget-link" data-goto="usage">사용량 보기 ›</button></div>
      <div class="recent-use">${rowsHtml || '<div class="empty-state" style="padding:16px">아직 사용 기록이 없습니다.</div>'}</div>`;
  }

  // (v2) 모델 커버리지 카드: Claude 보유 / Codex 보유 / 양쪽 공통(매트릭스 rows 집계).
  const covW = $('#ov-cov-widget');
  if (covW) {
    const has = (r, t) => r.tools && r.tools[t] && r.tools[t].exists;
    const clHave = rows.filter((r) => has(r, 'claude')).length;
    const cxHave = rows.filter((r) => has(r, 'codex')).length;
    const both = rows.filter((r) => has(r, 'claude') && has(r, 'codex')).length;
    covW.innerHTML = `
      <div class="widget-head"><div class="widget-title">모델 커버리지</div></div>
      <div class="cov2">
        <div class="cv-row"><span class="cv-sw" style="background:var(--tool-claude)"></span><span class="cv-label">Claude 보유</span><span class="cv-num">${clHave}</span></div>
        <div class="cv-row"><span class="cv-sw" style="background:var(--tool-codex)"></span><span class="cv-label">Codex 보유</span><span class="cv-num">${cxHave}</span></div>
        <div class="cv-row"><span class="cv-sw" style="background:var(--color-ink)"></span><span class="cv-label">양쪽 공통</span><span class="cv-num">${both}</span></div>
      </div>
      <div class="cov2-note">${skillCount}개 중 <b>${both}개${both < skillCount ? '만' : ''}</b> 양쪽에 존재합니다.</div>`;
  }
}

// (v2) 스킬 뷰로 이동하면서 상태 필터를 함께 지정(개요 배너·상태 행·스탯 카드에서 사용).
function gotoSkillsFilter(key) {
  mxState.skill.filter = key || 'all';
  mxState.skill.page = 1;
  // 이미 로드돼 있으면 필터만 갈아끼우고 다시 그린다. 미로드면 showView→ensureLoaded가 렌더.
  showView('skills');
  if (mxState.skill.data) { renderMxFilters('skill'); renderMatrix('skill'); }
}

function setCount(view, n) {
  const el = document.querySelector(`.nav-count[data-count="${view}"]`);
  if (!el) return;
  el.classList.remove('loading'); // 로딩("…") 상태 해제 — 실제 숫자로 확정.
  el.textContent = n;
  el.hidden = !(n > 0);
}

// (이슈1) 시작 시 배지 로딩 표시: "…" + 은은한 로딩 스타일(.loading). 숫자 도착 전 로딩 느낌.
function setCountLoading(view) {
  const el = document.querySelector(`.nav-count[data-count="${view}"]`);
  if (!el) return;
  el.hidden = false;
  el.classList.add('loading');
  el.textContent = '…';
}
// 실패한 배지는 조용히 숨긴다(크래시·에러 문구 없음, D26). 이후 뷰 방문 시 지연 로드가 채운다.
function setCountFailed(view) {
  const el = document.querySelector(`.nav-count[data-count="${view}"]`);
  if (!el) return;
  el.classList.remove('loading');
  el.hidden = true;
  el.textContent = '';
}

// (이슈1) 앱 초기화 시: 스킬/지시문/스토어 배지를 즉시 "…"로 띄운 뒤,
// 소스를 병렬 호출해 도착 순서대로 숫자로 교체한다. matrix 응답은 mxState 캐시로 공유돼
// 나중에 그 뷰에 들어가도 재fetch하지 않는다(fetchMatrix). /usage 배지는 기존 지연 로드 유지.
// (에이전트 배지는 뷰 숨김(D32)으로 제외.)
function initNavCounts() {
  ['skills', 'instructions'].forEach(setCountLoading);
  // 스킬: fetchMatrix(캐시/in-flight 공유). 도착하는 대로 rows 길이로 배지 교체.
  fetchMatrix('skill').then((m) => setCount('skills', (m.rows || []).length)).catch(() => setCountFailed('skills'));
  // 지시문: 존재하는 파일 수(renderInstrContent와 동일한 기준 — models[t].exists).
  api('/instr/matrix')
    .then((m) => setCount('instructions', TOOLS.filter((t) => m.models && m.models[t] && m.models[t].exists).length))
    .catch(() => setCountFailed('instructions'));
  // 스토어 배지는 스토어 뷰 숨김(D32)으로 제거 — /store 호출도 하지 않는다.
}

// ===================== 지시문(instructions) — 모델별 세로 카드 2개 (F3·D31) =====================
// 데이터: GET /instr/matrix → { canonId, models:{claude|codex:{exists,group|null,readError?}}, groups, syncState }.
// "중앙 저장소"는 내부 백업일 뿐 — 화면에서 완전히 숨긴다(언급 금지).
// 상태별 카드 UI:
//   · synced(셋 다 동일)   → 모든 카드 "모두 동기화됨" 배지, 기준 버튼 비활성.
//   · drift/partial + 존재 → 상태 + [이 모델을 기준으로 동기화] 버튼.
//   · exists:false         → "파일 없음 — 기준 동기화 시 생성됩니다", 기준 버튼 비활성.
//   · readError            → "읽기 실패" + [다시 시도](재로드).

// 지시문 각 모델 파일명(간단 경로 표시용). 서버 render 대상 파일명과 동일.
const INSTR_FILE = { claude: 'CLAUDE.md', codex: 'AGENTS.md' };
// 종합 상태 → 상단 요약 배너 문구(단순 용어, D26-①). 지시문은 "비교 전용"이라 중립 표현만 쓴다(쓰기 유발 문구 금지).
const INSTR_STATE = {
  synced: { ko: '동일합니다', badge: 'ok', desc: '두 모델의 전역 지시문 내용이 같습니다.' },
  drift: { ko: '서로 다릅니다', badge: 'warn', desc: '두 모델의 전역 지시문 내용이 다릅니다' },
  partial: { ko: '일부만 있음', badge: 'warn', desc: '일부 모델에만 지시문이 있습니다.' },
  none: { ko: '없음', badge: 'muted', desc: '아직 어느 모델에도 지시문이 없습니다.' },
};
// 콘텐츠 그룹 번호 → 사람이 읽는 라벨("내용 A/B/…"). 같은 그룹 = 같은 내용.
function instrGroupLabel(group) {
  if (group == null) return '';
  return '내용 ' + String.fromCharCode(64 + (((group - 1) % 26) + 1)); // 1→A, 2→B …
}

// 지시문 뷰 = 비교 전용 큰 화면. GET /instr/content 소비. (쓰기 유발 UI 없음 — 사용자 결정 "지시문은 손대지 않는다".)
//  · synced(sideBySide=null): 단일 본문 + "동일합니다" 안내(동기화 버튼 없음).
//  · drift(sideBySide 있음): renderSideBySide 좌우 diff — 기준 선택 버튼 미노출(onPickBase 없이).
//  · partial/none: 있는 쪽 본문 + 없는 쪽 "파일 없음" 안내(기준 버튼 없음).
//  · readError: 안내+재시도. 크래시 금지. (PI 게이트 제거 — 409 PI 경로 없음.)
let instrContentData = null; // 마지막 /instr/content(기준 선택 시 라벨/경로 참조).

async function loadInstructions() {
  showLoading('#instr-cards');
  $('#instr-summary').innerHTML = '';
  const res = await fetch('/instr/content');
  if (!res.ok) { showLoadError('#instr-cards', () => loadInstructions()); return; }
  let m;
  try { m = await res.json(); }
  catch { showLoadError('#instr-cards', () => loadInstructions()); return; }
  renderInstrContent(m);
}

function renderInstrContent(m) {
  instrContentData = m;
  const models = m.models || {};
  const present = TOOLS.filter((t) => models[t] && models[t].exists);
  setCount('instructions', present.length);
  const state = INSTR_STATE[m.syncState] || INSTR_STATE.none;

  // 읽기 실패가 하나라도 있으면 안내 + 다시 시도(전체 재로드).
  const readErr = TOOLS.find((t) => models[t] && models[t].readError);

  // (v2) 상단 배너: 상태 제목 + "다른 줄 N" 요약(sideBySide에서 type!=='same' 행 수).
  const diffCount = Array.isArray(m.sideBySide) ? m.sideBySide.filter((r) => r.type !== 'same').length : 0;
  const warnIc = `<span class="wb-ic"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 6.2v3.6M9 12.1v.05"/><path d="M9 2.5 1.8 15h14.4z"/></svg></span>`;
  const okIc = `<span class="wb-ic"><svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3.5 9.5 7.5 13.5 14.5 5"/></svg></span>`;
  const sub = m.syncState === 'drift' && diffCount
    ? `${state.desc} · 다른 줄 <b>${diffCount}</b> · 아래에서 좌우로 비교하세요`
    : esc(state.desc);
  $('#instr-summary').innerHTML =
    `<div class="warn-banner ${state.badge === 'ok' ? 'ok' : ''}" style="margin-bottom:18px">
      ${state.badge === 'ok' ? okIc : warnIc}
      <div class="wb-main">
        <div class="wb-title">${esc(state.ko)}</div>
        <div class="wb-sub">${sub}</div>
      </div>
    </div>`;

  const box = $('#instr-cards');
  if (readErr) {
    box.innerHTML = `<div class="empty-state">지시문 파일을 읽지 못했습니다.
      <span class="inline-acts" style="justify-content:center;margin-top:10px">
        <button class="btn btn-secondary btn-sm" data-instr-retry="1">다시 시도</button>
      </span></div>`;
    return;
  }

  const claude = models.claude || { exists: false, path: '', body: null };
  const codex = models.codex || { exists: false, path: '', body: null };

  // drift: 좌우 diff(비교 전용) — 기준 선택 버튼 미노출(onPickBase 없이). 넓은 화면에서 중앙 정렬 컨테이너.
  // (v2) 하단에 diff 범례(다른 줄=앰버 · 한쪽만=빗금) + 로컬 전용 문구.
  if (m.sideBySide) {
    box.innerHTML = `<div class="instr-content instr-content-wide">${renderSideBySide(m.sideBySide, {
      leftLabel: 'claude', rightLabel: 'codex',
      leftTool: 'claude', rightTool: 'codex',
      leftPath: claude.path || INSTR_FILE.claude,
      rightPath: codex.path || INSTR_FILE.codex,
      // onPickBase 없음 — 지시문은 비교만 제공(쓰기 유발 UI 제거).
    })}
    <div class="diff-legend">
      <span><span class="dl-sw chg"></span>내용이 다른 줄</span>
      <span><span class="dl-sw gap"></span>한쪽에만 있는 줄</span>
      <span class="ctx-divider" style="display:inline-block;width:1px;height:12px;background:var(--line-1);vertical-align:-1px"></span>
      <span>지시문은 비교 전용입니다 — 파일에 쓰지 않습니다.</span>
    </div></div>`;
    return;
  }

  // synced: 두 본문 동일 → 단일 본문(상단 배너가 이미 "동일합니다"를 안내하므로 중복 배너 없음).
  if (m.syncState === 'synced' && present.length === 2) {
    const body = claude.exists ? claude.body : codex.body;
    box.innerHTML =
      `<div class="instr-content"><div class="instr-single">
        <div class="instr-single-path" title="${esc(claude.path || codex.path || '')}">${esc(claude.path || codex.path || '')}</div>
        <pre class="viewer-pre">${esc(body || '')}</pre>
      </div></div>`;
    return;
  }

  // partial/none: 있는 쪽 본문 + 없는 쪽 "파일 없음" 안내(기준 버튼 없음 — 비교 전용). 중앙 정렬 컨테이너.
  // (v2) 헤더 = 모델색 톤(tool-claude 보라 / tool-codex 청록).
  const paneHtml = (tool, slot) => {
    const file = slot.path || INSTR_FILE[tool] || '';
    const head = `<div class="instr-pane-head tool-${esc(tool)}">
        <span class="tool-dot-lg"></span>
        <span class="instr-pane-name">${esc(tool)}</span>
        <span class="instr-pane-path" title="${esc(file)}">${esc(file)}</span>
      </div>`;
    if (slot.exists) {
      return `<div class="instr-pane">${head}<pre class="viewer-pre">${esc(slot.body || '')}</pre></div>`;
    }
    return `<div class="instr-pane absent">${head}<div class="empty-state">파일 없음</div></div>`;
  };
  box.innerHTML = `<div class="instr-content instr-content-wide"><div class="instr-panes">${paneHtml('claude', claude)}${paneHtml('codex', codex)}</div></div>`;
}

// 쓰기 실패 응답(res)에서 서버 {error} 또는 상태코드를 읽어 이유 문자열로.
async function errMsg(res) {
  try { const b = await res.json(); return b.error || `오류 ${res.status}`; }
  catch { return `오류 ${res.status}`; }
}

// (PI 게이트 제거 — showPiModal 삭제. 백엔드가 409 PI를 더 이상 내지 않으므로 PI 모달이 없다.)

// (지시문은 비교 전용 — 동기화 흐름 openInstrSync/renderInstrSyncPreview/runInstrSync/closeInstrSyncModal는
//  사용자 결정 "지시문은 손대지 않는다"에 따라 UI에서 제거됨. 백엔드 /instr/sync·CLI는 존치.)

// ===================== 동기화 매트릭스 (D27, UX-E2) =====================
// 스킬·에이전트 뷰의 주인공. GET /matrix?kind=skill|agent 를 표로 렌더한다.
// 컬럼: 경로 | 이름 | 태그 | claude | codex | 동기화.
// 상태 필터(기본 '주의 필요') + 이름 검색 + 더보기 페이지네이션 + 배치 동기화.

const MX_PAGE = 50; // 더보기 단위(702행 한 번에 렌더 금지, UX-E2 ②)
// 동기화 상태(syncState) → 간단 한글 라벨/배지. drift=불일치, partial=일부 없음.
const MX_SYNC = {
  synced: { ko: '동기화됨', badge: 'ok', ic: '✅' },
  drift: { ko: '불일치', badge: 'warn', ic: '⚠' },
  partial: { ko: '일부 없음', badge: 'warn', ic: '⚠' },
  single: { ko: '단독', badge: 'muted', ic: '—' },
};
// 상태 필터 칩 정의. '주의 필요'는 drift+partial 합산.
const MX_FILTERS = [
  { key: 'attention', ko: '주의 필요', states: ['drift', 'partial'] },
  { key: 'all', ko: '전체', states: null },
  { key: 'synced', ko: '동기화됨', states: ['synced'] },
  { key: 'single', ko: '단독', states: ['single'] },
];

// F4: 미동기화 상단 정렬 순서 — 불일치(drift) → 일부 없음(partial) → 단독(single) → 동기화됨(synced).
const MX_STATE_ORDER = { drift: 0, partial: 1, single: 2, synced: 3 };

// kind별 매트릭스 상태(필터·검색·페이지·원본 데이터).
// F4(skill)·F5(agent) 모두 folder(선택된 scope, null=[전체])·folderQ(폴더 리스트 검색어)를 갖는다.
const mxState = {
  skill: { filter: 'all', q: '', page: 1, data: null, folder: null, folderQ: '' },
  agent: { filter: 'all', q: '', page: 1, data: null, folder: null, folderQ: '' },
};

// 스킬 뷰 진입점(ensureLoaded 배선 유지). force=true(새로고침)면 캐시 무시하고 새로 받는다.
function loadSkillOverview(force) { return loadMatrix('skill', force); }
function loadAgentOverview(force) { return loadMatrix('agent', force); }

// (이슈1) 매트릭스 fetch 단일 진입점 — in-flight 요청 공유로 중복 fetch 방지.
//  · 진행 중인 같은 kind 요청이 있으면 그 promise를 재사용(초기 배지 로드·개요·뷰 진입이 겹쳐도 fetch 1회).
//  · 항상 새 데이터를 받아 mxState[kind].data에 저장한다(쓰기 후 재로드도 최신값 보장).
//  · st.fresh=true 로 표시 → 뒤이은 첫 loadMatrix가 재fetch 없이 이 데이터를 그대로 렌더한다.
// initNavCounts·loadOverview·loadMatrix가 모두 이 함수를 거쳐 같은 in-flight 응답을 공유한다.
function fetchMatrix(kind) {
  const st = mxState[kind];
  if (st.inflight) return st.inflight;
  const p = api('/matrix?kind=' + encodeURIComponent(kind))
    .then((m) => { st.data = m; st.fresh = true; st.inflight = null; return m; })
    .catch((e) => { st.inflight = null; throw e; });
  st.inflight = p;
  return p;
}

async function loadMatrix(kind, force) {
  const st = mxState[kind];
  st.page = 1;
  // 이미 새로 받아둔 데이터가 있으면(배지 초기 로드·개요·in-flight 공유) 재fetch 없이 즉시 렌더한다.
  // 단 새로고침(force)이나 쓰기 후 재로드는 fresh를 안 쓰고 실제로 다시 받아 최신값을 반영한다.
  if (!force && st.data && st.fresh) return renderLoadedMatrix(kind, st.data);
  // /matrix는 첫 로드 시 디스크에서 파일을 찾고 해시를 계산해 다소 느림 — 안내 메시지 필수(D26)
  showLoading('#' + kind + '-mx-rows', mxColspan(kind), '파일을 찾고 있습니다 — 조금만 기다려주세요…');
  st.fresh = false; // 이 시점부터의 fetch 결과만 fresh로 인정(경합 방지).
  let m;
  try { m = await fetchMatrix(kind); }
  catch { showLoadError('#' + kind + '-mx-rows', () => loadMatrix(kind, true), mxColspan(kind)); return; }
  renderLoadedMatrix(kind, m);
}

// 매트릭스 데이터(m)로 뷰 전체를 렌더(칩·배지·폴더·필터·표). loadMatrix 성공 후 공용 진입점.
function renderLoadedMatrix(kind, m) {
  const st = mxState[kind];
  st.data = m;
  st.fresh = false; // 화면에 반영했으므로 "재fetch 생략" 특권을 소진 — 이후 재로드는 실제 fetch.
  // 카테고리 칩 개수 배지는 이 뷰의 행 집계에서 나온다 — 데이터 도착 후 칩 바를 다시 그린다.
  loadTags();
  setCount(kind === 'skill' ? 'skills' : 'agents', (m.rows || []).length);
  // 상태 필터 기본값: 전체(all). (이슈3) 사용자가 모든 항목을 먼저 보고 필요 시 좁힌다.
  // 자동 발견 배너(첫 로드에 프로젝트를 새로 등록했을 때만).
  const scan = $('#' + kind + '-mx-scan');
  if (scan) {
    if (m.autoScan && m.autoScan.adopted > 0) {
      scan.hidden = false;
      scan.innerHTML = `<span>프로젝트 ${m.autoScan.adopted}개를 자동으로 찾았습니다.</span>`;
    } else { scan.hidden = true; scan.innerHTML = ''; }
  }
  // F4(skill)·F5(agent): 선택된 폴더가 더 이상 존재하지 않으면(스캔·해제 등) [전체]로 되돌린다.
  if (st.folder && !(m.rows || []).some((r) => r.scope === st.folder)) st.folder = null;
  renderFolderList(kind);
  renderMxFilters(kind);
  renderMatrix(kind);
}

// 표 컬럼 수(스켈레톤/빈행 colspan). [전체]에서만 경로 컬럼을 노출하므로 7, 폴더 선택 시 6.
// (F4 skill·F5 agent 공용 — 둘 다 폴더 선택 시 경로 컬럼을 숨긴다.)
function mxColspan(kind) {
  if (mxState[kind].folder) return 6;
  return 7;
}

// ── F4/F5: 좌측 폴더 리스트 (scope 기준 클라이언트 그룹핑) — skill·agent 공용(kind 파라미터화) ──
// rows를 scope로 묶어 폴더 목록을 만든다. scope는 서버에서 'global' 또는 프로젝트 루트 절대경로.
// 반환: [{scope, label, folder, count, unsynced}] — 전역 먼저, 그다음 폴더명(경로)순.
// (rows는 이미 서버가 전역→프로젝트 경로순으로 정렬해 내려주지만, 여기서 명시적으로 재정렬한다.)
function folderGroups(kind) {
  const rows = (mxState[kind].data && mxState[kind].data.rows) || [];
  const map = new Map(); // scope → {scope, label, folder, count, unsynced}
  for (const r of rows) {
    let g = map.get(r.scope);
    if (!g) {
      g = {
        scope: r.scope,
        label: r.scope === 'global' ? '전역(~)' : baseName(r.scope),
        folder: r.scope === 'global' ? '전역(~)' : r.scope, // 검색 대상 문자열
        count: 0,
        unsynced: 0,
      };
      map.set(r.scope, g);
    }
    g.count += 1;
    if (r.syncState !== 'synced') g.unsynced += 1;
  }
  const groups = [...map.values()];
  groups.sort((a, b) => {
    if (a.scope === 'global') return -1;
    if (b.scope === 'global') return 1;
    return a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0;
  });
  return groups;
}

// 폴더 리스트 렌더: [전체] + 폴더 항목(미동기화 배지). folderQ(이름 부분일치)로 거른다. (kind 공용)
function renderFolderList(kind) {
  const box = $('#' + kind + '-folder-list');
  if (!box) return;
  const st = mxState[kind];
  const groups = folderGroups(kind);
  const q = (st.folderQ || '').trim().toLowerCase();
  const filtered = q
    ? groups.filter((g) => g.label.toLowerCase().includes(q) || g.folder.toLowerCase().includes(q))
    : groups;
  const totalUnsynced = groups.reduce((a, g) => a + g.unsynced, 0);
  const totalCount = groups.reduce((a, g) => a + g.count, 0);

  // [전체] 항목은 검색어와 무관하게 항상 맨 위에 둔다(전체 항목으로 되돌아가는 진입점).
  const allItem = folderItemHtml(kind, {
    scope: null, label: '전체', count: totalCount, unsynced: totalUnsynced,
  }, st.folder === null);
  const items = filtered.map((g) => folderItemHtml(kind, g, st.folder === g.scope)).join('');
  const emptyHint = (!filtered.length && q)
    ? '<div class="mdf-empty">일치하는 폴더가 없습니다</div>'
    : '';
  box.innerHTML = allItem + items + emptyHint;
}

// (v2) 폴더 리스트 아이콘 — 홈(전역·전체)/폴더/복사 SVG(이모지 대체, 목업 톤).
const FOLDER_IC = {
  home: '<svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="#86868b" stroke-width="1.6"><path d="M3 9.5 10 3.5l7 6"/><path d="M4.8 8.5V16h10.4V8.5"/></svg>',
  folder: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="#a1a1a6" stroke-width="1.5"><path d="M2 4.2c0-.5.4-1 1-1h2.6l1.1 1.3h5.3c.6 0 1 .5 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>',
};
function folderItemHtml(kind, g, active) {
  // (과제4) 폴더 배지 = 그 폴더의 항목 수(=상태 필터 "전체 N"과 동일). [전체] 배지 = 전체 행 수.
  //  미동기화 강조는 행의 앰버 배경·동기화 열이 담당하므로 배지는 순수 개수로 통일한다.
  const badge = `<span class="mdf-badge">${g.count}</span>`;
  const scopeAttr = g.scope == null ? '' : ` title="${esc(g.scope === 'global' ? '전역 홈(~)' : g.scope)}"`;
  const ic = (g.scope == null || g.scope === 'global') ? FOLDER_IC.home : FOLDER_IC.folder;
  // (과제4) 경로 복사 버튼: [전체]는 실제 폴더가 아니라 제외. 전역·프로젝트만.
  //   - 전역: data-folder-copy="global" → 해당 kind의 대표 폴더 경로 안내(스킬은 ~/.claude/skills 고정).
  //   - 프로젝트: data-folder-copy="<root>"(scope가 곧 절대경로). data-copy-kind로 skill/agent 구분.
  const openBtn = g.scope == null ? '' :
    `<button class="mdf-open" data-folder-copy="${esc(g.scope)}" data-copy-kind="${kind}" title="폴더 경로 복사" aria-label="폴더 경로 복사">${FOLDER_IC.copy}</button>`;
  // data-folder-kind로 skill/agent 폴더 클릭을 구분(이벤트 위임). 버튼-in-버튼 회피를 위해 div+role=button.
  return `<div class="mdf-item ${active ? 'active' : ''}" role="button" tabindex="0" data-folder-kind="${kind}" data-folder="${g.scope == null ? '' : esc(g.scope)}"${scopeAttr}>
    <span class="mdf-ic">${ic}</span>
    <span class="mdf-label">${esc(g.label)}</span>
    ${badge}
    ${openBtn}
  </div>`;
}

// (과제4) 폴더의 절대 경로를 클립보드에 복사한다(순수 클라이언트 — 서버 불필요).
//   - 프로젝트: scope가 곧 프로젝트 루트 절대경로.
//   - 전역: 실제 홈 경로를 클라이언트가 알 수 없으므로 해당 kind의 대표 폴더를 안내한다
//     (스킬 ~/.claude/skills · 에이전트 ~/.claude/agents — 단순 고정 안내, 지침 허용).
function folderCopyPath(scope, kind) {
  if (scope !== 'global') return scope; // 프로젝트 루트 = 절대경로
  return kind === 'agent' ? '~/.claude/agents' : '~/.claude/skills';
}

// 클립보드 복사(navigator.clipboard 우선, 실패 시 textarea 폴백). 성공/실패 모두 토스트로 안내.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 폴백으로 넘어감 */ }
  // 폴백: 화면 밖 textarea + execCommand('copy').
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

async function copyFolderPath(scope, kind) {
  const p = folderCopyPath(scope, kind);
  const ok = await copyToClipboard(p);
  toast(ok ? `경로를 복사했습니다: ${p}` : `복사하지 못했습니다 — 경로: ${p}`);
}

// 폴더 선택 → 우측 표를 그 폴더의 항목만 표시. null(빈 문자열)이면 [전체]. (kind 공용)
function selectFolder(kind, scope) {
  const st = mxState[kind];
  st.folder = scope || null;
  st.page = 1;
  renderFolderList(kind);
  applyScopeColumn(kind);
  // (과제2) 폴더가 바뀌면 상태 필터 개수도 그 폴더 기준으로 다시 집계 → 칩 배지 즉시 갱신.
  renderMxFilters(kind);
  renderMatrix(kind);
  // (이슈2) 폴더가 바뀌면 카테고리 칩 개수도 그 폴더 범위로 다시 집계해야 하므로 칩 바를 갱신한다.
  loadTags();
}

// F4/F5: [전체] 선택 시에만 경로 컬럼을 보여준다(폴더 선택 시 숨김 — 좌측이 대체). (kind 공용)
function applyScopeColumn(kind) {
  const tbl = $('#' + kind + '-mx-table');
  if (!tbl) return;
  tbl.classList.toggle('mx-hide-scope', mxState[kind].folder != null);
}

// 폴더 리스트 검색 입력. (kind 공용)
function applyFolderSearch(kind, q) {
  mxState[kind].folderQ = q;
  renderFolderList(kind);
}

// 상태(syncState)별 개수를 집계한다. rows 배열을 받아 {synced,drift,partial,single} 개수를 센다.
// (과제2) 서버가 준 전체 counts 대신 이 함수로 "선택된 폴더 기준" rows를 집계한다.
function stateCounts(rows) {
  const c = { synced: 0, drift: 0, partial: 0, single: 0 };
  for (const r of rows || []) c[r.syncState] = (c[r.syncState] || 0) + 1;
  return c;
}

// 상태 필터 칩 렌더(개수 배지). (과제2) 개수는 선택된 폴더 기준(mxScopedRows)으로 계산한다 —
// 폴더 클릭(selectFolder) 시 renderMxFilters가 다시 불려 즉시 갱신된다. 폴더 미선택 시 전체 집계.
function renderMxFilters(kind) {
  const box = $('#' + kind + '-mx-state');
  if (!box) return;
  const st = mxState[kind];
  const c = stateCounts(mxScopedRows(kind));
  box.innerHTML = MX_FILTERS.map((f) => {
    const n = f.states ? f.states.reduce((a, s) => a + (c[s] || 0), 0) : ((c.synced || 0) + (c.drift || 0) + (c.partial || 0) + (c.single || 0));
    return `<button class="filter-pill ${st.filter === f.key ? 'active' : ''}" data-mx-filter="${kind}:${f.key}">${esc(f.ko)}<span class="fp-count">${n}</span></button>`;
  }).join('');
}

// (v2) 컨텍스트 + 범례 줄: "현재 N / M개 표시 중 · ✓ 있음 · – 없음 · ■Claude ■Codex"
function renderMxContext(kind, visibleCount) {
  const box = $('#' + kind + '-mx-context');
  if (!box) return;
  const st = mxState[kind];
  // 분모(total): skill이 폴더를 선택한 상태면 그 폴더의 스킬 수, 아니면 전체.
  const total = mxScopedRows(kind).length;
  const filter = MX_FILTERS.find((x) => x.key === st.filter) || MX_FILTERS[1];
  // 폴더 선택·태그·검색 등 현재 조건 표시(범례 앞에 은은하게).
  const cond = [];
  if (st.filter !== 'all') cond.push(filter.ko);
  if (st.folder) cond.push(`폴더 ${st.folder === 'global' ? '전역(~)' : baseName(st.folder)}`);
  if (activeTags.size) cond.push(`태그 ${[...activeTags].map((t) => t === UNTAGGED_KEY ? '미정' : catLabel(t)).join(', ')}`);
  if (st.q) cond.push(`검색 "${st.q}"`);
  const condTxt = cond.length ? ` (${cond.join(' · ')})` : '';
  box.innerHTML = `<span>현재 <b>${visibleCount}</b> / ${total}개 표시 중${esc(condTxt)}</span>
    <span class="ctx-divider"></span>
    <span class="mx-legend">
      <span class="mx-legend-item"><span class="lg-yes">✓</span> 있음</span>
      <span class="mx-legend-item"><span class="lg-no">–</span> 없음</span>
      <span class="mx-legend-item"><span class="legend-sq claude"></span> Claude</span>
      <span class="mx-legend-item"><span class="legend-sq codex"></span> Codex</span>
    </span>`;
}

// 폴더(scope)만 적용한 행 — 컨텍스트 분모/폴더 범위 계산용. folder가 null이면 전체. (kind 공용)
function mxScopedRows(kind) {
  const st = mxState[kind];
  const rows = (st.data && st.data.rows) || [];
  if (st.folder) return rows.filter((r) => r.scope === st.folder);
  return rows;
}

// 현재 폴더·상태 필터·검색·태그로 걸러진 뒤, 미동기화 상단 정렬한 행.
function mxVisibleRows(kind) {
  const st = mxState[kind];
  const f = MX_FILTERS.find((x) => x.key === st.filter) || MX_FILTERS[1];
  const q = (st.q || '').trim().toLowerCase();
  const filtered = mxScopedRows(kind).filter((r) => {
    if (f.states && !f.states.includes(r.syncState)) return false;
    if (q && !String(r.name).toLowerCase().includes(q)) return false;
    if (!tagMatch(r)) return false; // 다중 태그(OR) 필터 연동
    return true;
  });
  // F4: 미동기화 상단 정렬(drift→partial→single→synced). 동률이면 이름순(안정적 표시).
  return filtered.slice().sort((a, b) => {
    const oa = MX_STATE_ORDER[a.syncState] ?? 9, ob = MX_STATE_ORDER[b.syncState] ?? 9;
    if (oa !== ob) return oa - ob;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

// (v2) 도구 열 셀 = 중립 ✓ / – 마크. 색점 제거(모델색은 헤더·범례에만 — 상태색과 분리 원칙).
// F5(agent): nonstandard(도구가 읽지 않는 위치의 파일) → "⚠ 비표준" 배지(툴팁)로 은은히 구분.
function mxToolCell(slot) {
  if (slot && slot.exists) {
    return `<span class="mx-cell-yes">✓</span>`;
  }
  if (slot && slot.nonstandard) {
    return `<span class="mx-cell-nonstd" title="이 도구가 읽지 않는 위치입니다(비표준)">⚠ 비표준</span>`;
  }
  return '<span class="mx-cell-no">–</span>';
}

// 경로 셀: 폴더명(전역이면 "전역(~)")만 표시, title에 전체 경로.
const MX_FOLDER_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#c0c0c5" stroke-width="1.5" style="flex:none;vertical-align:-2px"><path d="M2 4.2c0-.5.4-1 1-1h2.6l1.1 1.3h5.3c.6 0 1 .5 1 1v6c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1z"/></svg>';
function mxScopeCell(r) {
  if (r.scope === 'global') return `<span class="mx-scope global" title="전역 홈(~)">전역(~)</span>`;
  const folder = baseName(r.scope);
  return `<span class="mx-scope" title="${esc(r.scope)}">${MX_FOLDER_SVG} <span class="mxs-folder">${esc(folder)}</span></span>`;
}

// (v2) 동기화 열: 상태 배지(pill + dot) + (동기화됨이 아니면) [동기화] 버튼.
function mxSyncCell(kind, r) {
  const s = MX_SYNC[r.syncState] || MX_SYNC.single;
  const badge = `<span class="badge ${s.badge}"><span class="bdot"></span>${esc(s.ko)}</span>`;
  // 동기화됨은 이미 일치 → 버튼 없이 상태만. 나머지(불일치/일부없음/단독)는 [동기화] 노출.
  // data-sync-source는 생략: skill의 sourceId는 서버가 baseTool→공식 소스로 정확히 유도한다
  //   (임의 도구명을 sourceId로 넘기면 skillPull이 소스를 못 찾음). 기준 도구 자동선택은
  //   sync 모달이 lastSyncBase/baseCandidates로 처리한다.
  const btn = r.syncState === 'synced' ? ''
    : `<button class="btn btn-secondary btn-sm" data-sync-open="${kind}" data-sync-name="${esc(r.name)}" data-sync-scope="${esc(r.scope)}">동기화</button>`;
  return `<div class="mx-sync">${badge}${btn}</div>`;
}

// 행에서 존재하는 첫 도구 = 배치/단건 동기화 기본 기준(base).
function mxRowBase(r) {
  return TOOLS.find((t) => r.tools[t] && r.tools[t].exists) || 'claude';
}

function renderMatrix(kind) {
  const st = mxState[kind];
  const body = $('#' + kind + '-mx-rows');
  if (!body) return;
  applyScopeColumn(kind); // 경로 컬럼 노출은 [전체] 선택 시에만 (skill·agent 공용)
  const all = mxVisibleRows(kind);
  renderMxContext(kind, all.length);
  const shown = all.slice(0, st.page * MX_PAGE);
  if (!all.length) {
    const empty = (st.data && (st.data.rows || []).length)
      ? '조건에 맞는 항목이 없습니다 — 필터/검색을 바꿔보세요'
      : `아직 ${kind === 'skill' ? '스킬' : '에이전트'}이 하나도 없어요 — 프로젝트를 추가하면 그 안의 스킬이 자동으로 보입니다
        <span class="inline-acts" style="justify-content:center;margin-top:10px">
          <button class="btn btn-secondary btn-sm" data-open-projects="1">프로젝트 관리</button>
        </span>`;
    body.innerHTML = `<tr><td colspan="${mxColspan(kind)}" class="skel">${empty}</td></tr>`;
    if ($('#' + kind + '-mx-more')) $('#' + kind + '-mx-more').innerHTML = '';
    const allc = $('#' + kind + '-mx-all'); if (allc) allc.checked = false;
    return;
  }
  body.innerHTML = shown.map((r) => {
    const rowErr = r.error ? ` <span class="badge warn" title="${esc(r.error)}">⚠ 이슈</span>` : '';
    return `<tr class="mx-row-${esc(r.syncState)}" data-mx-row="${kind}" data-mx-name="${esc(r.name)}" data-mx-scope="${esc(r.scope)}">
      <td class="cell"><input type="checkbox" class="mx-pick" data-mx-kind="${kind}" data-mx-name="${esc(r.name)}" data-mx-base="${esc(mxRowBase(r))}" data-mx-scope="${esc(r.scope)}" /></td>
      <td class="mx-scope-cell">${mxScopeCell(r)}</td>
      <td><span class="item-name item-name-link" data-view-content="${kind}" data-view-name="${esc(r.name)}" data-view-scope="${esc(r.scope)}" title="내용 보기">${esc(r.name)}</span>${rowErr}</td>
      <td>${tagChipsHtml(r.tags, r.autoTags)}</td>
      <td class="mx-tool">${mxToolCell(r.tools.claude)}</td>
      <td class="mx-tool">${mxToolCell(r.tools.codex)}</td>
      <td>${mxSyncCell(kind, r)}</td>
    </tr>`;
  }).join('');
  // 더보기(50행 단위).
  const more = $('#' + kind + '-mx-more');
  if (more) {
    more.innerHTML = shown.length < all.length
      ? `<span class="muted">${shown.length} / ${all.length}개 표시 중</span><button class="btn btn-ghost btn-sm" data-mx-more="${kind}">더보기 (+${Math.min(MX_PAGE, all.length - shown.length)})</button>`
      : (all.length > MX_PAGE ? `<span class="muted">${all.length}개 모두 표시됨</span>` : '');
  }
  const allc = $('#' + kind + '-mx-all'); if (allc) allc.checked = false;
  if ($('#' + kind + '-mx-progress')) $('#' + kind + '-mx-progress').textContent = '';
}

// 상태 필터 칩 클릭.
function applyMxFilter(kind, key) {
  mxState[kind].filter = key;
  mxState[kind].page = 1;
  renderMxFilters(kind);
  renderMatrix(kind);
}
// 이름 검색 입력.
function applyMxSearch(kind, q) {
  mxState[kind].q = q;
  mxState[kind].page = 1;
  renderMatrix(kind);
}
// 더보기.
function mxMore(kind) { mxState[kind].page += 1; renderMatrix(kind); }

async function doSkillPull(name, sourceId) {
  const res = await fetch('/skills/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, source_id: sourceId }) });
  if (!res.ok) { toast('적용하지 못했습니다: ' + (await errMsg(res))); return; }
  await res.json();
  toast('스킬 가져오기 완료');
  loadSkillOverview();
}

// (과제3) 스킬 슬라이드오버(openSkillDetail) 제거 — 행 클릭·이름 클릭 모두 중앙 본문 뷰어(openContentViewer)를
// 연다. 스킬 diff/apply/태그수정은 뷰어의 좌우 diff + 동기화 모달 흐름으로 대체된다.
// (doSkillDiff/doSkillApply/doSkillApplyAll 핸들러는 동기화 모달의 [차이 보기] 등에서 계속 쓰인다.)

async function doSkillDiff(name, to) {
  let d;
  try { d = await api('/skills/diff?name=' + encodeURIComponent(name) + '&to=' + encodeURIComponent(to)); }
  catch (e) { toast('미리보기를 불러오지 못했습니다: ' + e.message); return; }
  let body;
  if (!d.canonicalExists) body = '<div class="empty-state">중앙 저장소에 해당 skill이 없습니다.</div>';
  else if (!d.hasChanges) body = '<div class="empty-state">차이 없음 — 이미 동일</div>';
  else body = renderDiff(d.diff);
  $('#skill-inline-diff').innerHTML = `<div class="divider-strong"></div><div class="sub-label">${esc(name)} → ${esc(to)}</div>${lossBanner(d.losses)}${body}`;
  $('#skill-inline-diff').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function doSkillApply(name, to) {
  // #2: 미리보기 패널(openSkillDetail)을 거친 적용 — native confirm() 제거.
  try {
    const r = await api('/skills/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, to, apply: true }) });
    toast(`${to} 적용 완료 · 백업: ` + (r.backupPath || '(신규)'));
    loadSkillOverview();
  } catch (e) {
    toast('적용하지 못했습니다: ' + e.message);
  }
}

// #1: 세 도구에 한 번에 적용(skill). TOOLS 순회로 기존 /skills/push(apply:true)를 호출·합산.
// 부분 실패는 도구별로 표시하고 중단하지 않는다(D26-②).
async function doSkillApplyAll(name) {
  await applyAll({
    outSel: '#skill-apply-all-result',
    endpoint: '/skills/push',
    payload: (to) => ({ name, to }),
    reload: () => loadSkillOverview(),
  });
}

// ===================== 에이전트(agents) — 상세/pull 핸들러(매트릭스는 loadMatrix가 렌더) =====================
async function doAgentPull(from, name) {
  const res = await fetch('/agents/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from, name }) });
  if (!res.ok) { toast('적용하지 못했습니다: ' + (await errMsg(res))); return; }
  await res.json();
  toast('에이전트 가져오기 완료');
  loadAgentOverview();
}

// 슬라이드오버: 도구별 tstat + tools 칩 + loss-banner + diff + push
async function openAgentDetail(id) {
  let ag, d;
  try {
    ag = await api('/agents/overview');
    d = await Promise.all(TOOLS.map((to) =>
      api('/agents/diff?id=' + encodeURIComponent(id) + '&to=' + encodeURIComponent(to)).then((x) => ({ to, ...x }))
    ));
  } catch (e) { toast('상세를 불러오지 못했습니다: ' + e.message); return; }
  const meta = (ag.canonicalAgents || []).find((a) => a.id === id) || { name: id, tools: [], tags: [] };
  const allLosses = [];
  const rows = d.map((x) => {
    (x.losses || []).forEach((l) => allLosses.push(`[${x.to}] ${l}`));
    const state = !x.canonicalExists ? '없음' : (x.hasChanges ? '변경 있음' : '동일');
    const reason = (x.losses || []).length ? `<div class="tstat-reason">손실: ${x.losses.map(esc).join(', ')}</div>` : '';
    return `<div class="tstat-row">
        <span class="tool-dot" style="background:${TOOL_COLOR[x.to]}"></span>
        <span class="tool-name">${x.to}</span>
        <span class="muted" style="margin-left:auto">${state}</span>
        <button class="btn btn-secondary btn-sm" data-agent-diff-id="${esc(id)}" data-agent-diff-to="${x.to}">diff</button>
        <button class="btn btn-secondary btn-sm" data-agent-apply="${esc(id)}" data-agent-apply-to="${x.to}" ${x.canonicalExists ? '' : 'disabled'}>적용</button>
      </div>${reason}`;
  }).join('');
  const toolChips = (meta.tools || []).map((t) => `<span class="tool-chip" style="color:${TOOL_COLOR[t] || 'var(--st-muted)'};background:${TOOL_SOFT[t] || 'var(--st-muted-soft)'}">${esc(t)}</span>`).join(' ');
  const anyCanon = d.some((x) => x.canonicalExists);
  openPanel({
    title: meta.name,
    meta: `<span class="kv"><b>출처</b> ${esc(meta.source_tool || '—')}</span>`,
    bodyHtml: lossBanner(allLosses)
      + (toolChips ? `<div class="sub-label">대상 모델</div><div class="chip-list">${toolChips}</div><div style="height:14px"></div>` : '')
      + refSkillsSection(meta.name)
      + '<div class="sub-label">모델별 상태</div><div class="tstat">' + rows + '</div><div id="agent-apply-all-result"></div><div id="agent-inline-diff"></div>',
    footHtml: `<button class="btn btn-primary" data-sync-open="agent" data-sync-name="${esc(meta.name)}">동기화</button><button class="btn btn-secondary" data-agent-apply-all="${esc(id)}" ${anyCanon ? '' : 'disabled'}>중앙 저장소 → 세 모델</button><button class="btn btn-ghost" data-view-open="agent" data-view-name="${esc(meta.name)}" data-view-scope="${esc(mxScopeOf('agent', meta.name))}">내용 보기</button><button class="btn btn-ghost" data-tag-kind="agent" data-tag-id="${esc(id)}">태그 수정</button><button class="btn btn-ghost" id="panel-cancel">닫기</button>`,
  });
}

// F5: 에이전트 상세의 "참조 스킬" 섹션. 매트릭스 행(referencedSkills)에서 이름을 읽어
// 스킬 뷰로 이동하는 링크 목록으로 렌더한다(공식 메커니즘: Claude frontmatter skills / Codex skills.config).
// 참조가 없으면 "없음"만 간단히 표기.
function agentRefSkills(name) {
  const rows = (mxState.agent.data && mxState.agent.data.rows) || [];
  const row = rows.find((r) => r.name === name);
  return (row && row.referencedSkills) || [];
}
function refSkillsSection(name) {
  const skills = agentRefSkills(name);
  const inner = skills.length
    ? `<div class="chip-list ref-skill-list">${skills.map((s) =>
      `<button class="ref-skill-chip" data-ref-skill="${esc(s)}" title="스킬 뷰에서 '${esc(s)}' 보기">🧩 ${esc(s)}</button>`).join('')}</div>`
    : `<div class="muted" style="font-size:13px;padding:2px 0">없음</div>`;
  return `<div class="sub-label">참조 스킬</div>${inner}<div style="height:14px"></div>`;
}

// 참조 스킬 링크 클릭 → 스킬 뷰로 이동하고 이름 검색을 채운 상태로 보여준다(기존 showView + 검색 재사용).
function gotoSkillSearch(name) {
  closePanel();
  // 폴더는 [전체]로, 상태 필터는 전체로, 이름 검색만 채워 어느 폴더의 동명 스킬도 보이게 한다.
  mxState.skill.folder = null;
  mxState.skill.filter = 'all';
  mxState.skill.q = name;
  mxState.skill.page = 1;
  const input = $('#skill-mx-search');
  if (input) input.value = name;
  showView('skills'); // 미로드면 ensureLoaded→loadMatrix가 위 st.q를 반영해 렌더한다.
  // 이미 로드돼 있으면 즉시 재렌더(loadMatrix를 다시 부르지 않고 클라이언트 필터만 반영).
  if (loaded.skills && mxState.skill.data) {
    renderFolderList('skill');
    renderMxFilters('skill');
    renderMatrix('skill');
  }
}

async function doAgentDiff(id, to) {
  let d;
  try { d = await api('/agents/diff?id=' + encodeURIComponent(id) + '&to=' + encodeURIComponent(to)); }
  catch (e) { toast('미리보기를 불러오지 못했습니다: ' + e.message); return; }
  let body;
  if (!d.canonicalExists) body = '<div class="empty-state">중앙 저장소에 해당 agent가 없습니다.</div>';
  else if (!d.hasChanges) body = '<div class="empty-state">차이 없음 — 이미 동일</div>';
  else body = renderDiff(d.diff);
  $('#agent-inline-diff').innerHTML = `<div class="divider-strong"></div><div class="sub-label">${esc(id)} → ${esc(to)}</div>${lossBanner(d.losses)}${body}`;
  $('#agent-inline-diff').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function doAgentApply(id, to) {
  // #2: 미리보기 패널(openAgentDetail)을 거친 적용 — native confirm() 제거.
  try {
    const r = await api('/agents/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, to, apply: true }) });
    toast(`${to} 적용 완료 · 백업: ` + (r.backupPath || '(신규)'));
    loadAgentOverview();
  } catch (e) {
    toast('적용하지 못했습니다: ' + e.message);
  }
}

// #1: 세 도구에 한 번에 적용(agent). TOOLS 순회로 기존 /agents/push(apply:true)를 호출·합산.
async function doAgentApplyAll(id) {
  await applyAll({
    outSel: '#agent-apply-all-result',
    endpoint: '/agents/push',
    payload: (to) => ({ id, to }),
    reload: () => loadAgentOverview(),
  });
}

// #1 공용: TOOLS를 순차로 (미리보기 → 변경 있으면 적용)하고 "적용/이미 동일/실패 + 백업 수"를 합산.
// 미리보기(apply 없이)로 hasChanges를 먼저 보고, 동일하면 쓰지 않는다(정확한 "이미 동일" 집계).
// 도구 하나가 실패해도 나머지 도구는 계속한다(D26-②). native confirm 없음(미리보기 패널 경유).
async function applyAll({ outSel, endpoint, payload, reload }) {
  const out = $(outSel);
  const rows = [];
  let applied = 0, same = 0, fail = 0, backups = 0;
  const post = (body) => api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const to of TOOLS) {
    if (out) out.innerHTML = `<div class="skel" style="padding:10px">${esc(to)} 적용 중…</div>`;
    try {
      const preview = await post({ ...payload(to), apply: false });
      if (preview && preview.hasChanges === false) { same++; rows.push({ to, status: 'same', msg: '이미 동일' }); continue; }
      const r = await post({ ...payload(to), apply: true });
      applied++;
      if (r && r.backupPath) backups++;
      rows.push({ to, status: 'ok', msg: '적용됨' + (r && r.backupPath ? ' · 백업' : ' · 신규') });
    } catch (e) {
      fail++;
      rows.push({ to, status: 'error', msg: e.message });
    }
  }
  if (out) {
    const b = (s) => s === 'ok' ? '<span class="badge ok">적용</span>' : s === 'same' ? '<span class="badge muted">동일</span>' : '<span class="badge error">실패</span>';
    out.innerHTML = `<div class="batch-result">
      <div class="sub-label" style="margin-top:12px">적용 ${applied} · 이미 동일 ${same} · 실패 ${fail}${backups ? ` · 백업 ${backups}건` : ''}</div>
      ${rows.map((r) => `<div class="sync-result-row"><span class="tool-dot" style="background:${TOOL_COLOR[r.to]}"></span><span class="tool-name">${esc(r.to)}</span>${b(r.status)}<span class="srr-detail">${esc(r.msg)}</span></div>`).join('')}
    </div>`;
  }
  toast(`세 모델 적용 — 적용 ${applied} · 동일 ${same} · 실패 ${fail}`);
  if (reload) reload();
}

// ===================== 태그 + 필터 =====================
// 각 뷰(스킬·에이전트·스토어)의 현재 항목에서 카테고리 개수를 집계해 칩 배지에 쓴다.
// 데이터가 아직 없으면 개수 배지는 생략된다(칩 자체는 항상 12개 표시).
// (이슈2) 스킬·에이전트 칩 개수는 "현재 폴더에 뭐가 몇 개"가 목적이므로
// 전체 rows 대신 mxScopedRows(폴더 필터만 적용 — 상태/검색/태그 제외)를 집계한다.
// 스토어 바는 기존대로 전체 항목(lastStoreItems)을 쓴다.
function tagBarItems(barId) {
  if (barId === 'skills-filters') return mxState.skill.data ? mxScopedRows('skill') : [];
  if (barId === 'agents-filters') return mxState.agent.data ? mxScopedRows('agent') : [];
  if (barId === 'store-filters') return lastStoreItems || [];
  return [];
}

// 고정 12 카테고리 칩 바 렌더. [전체] + 12 카테고리(항상 표시, 개수 배지) + 실제 존재하는 커스텀 태그.
// 다중 OR 선택(activeTags Set)은 그대로. 개별 칩 토글(다시 클릭 → 해제).
async function loadTags() {
  // 커스텀 태그(12종 밖) 후보: /tags의 all에서 12 카테고리를 뺀 나머지.
  let custom = [];
  try {
    const t = await api('/tags');
    custom = (t.all || []).filter((tag) => !CATEGORY_KEYS.includes(tag));
  } catch { /* 태그 목록 실패 시 커스텀 없이 12 카테고리만 표시(우아한 실패) */ }

  ['skills-filters', 'agents-filters', 'store-filters'].forEach((id) => {
    const el = $('#' + id);
    if (!el) return;
    const items = tagBarItems(id);
    const counts = categoryCounts(items);
    const hasData = items.length > 0;
    // 활성 태그가 하나 이상이면 "모두 해제" 칩을 상단에.
    const clearChip = activeTags.size
      ? `<button class="active-tag-chip" data-tag-filter="" title="선택한 태그를 모두 해제합니다">태그 ${activeTags.size}개 ✕</button>`
      : '';
    const allPill = `<button class="filter-pill ${activeTags.size === 0 ? 'active' : ''}" data-tag-filter="">전체</button>`;
    // 12 카테고리 칩(항상 표시). 개수 배지는 데이터가 있을 때만.
    const catPills = CATEGORY_KEYS.map((key) => {
      const n = counts[key] || 0;
      const badge = hasData ? `<span class="fp-count">${n}</span>` : '';
      return `<button class="filter-pill ${activeTags.has(key) ? 'active' : ''}" data-tag-filter="${esc(key)}">${esc(catLabel(key))}${badge}</button>`;
    }).join('');
    // 과제1: 12종 뒤에 "미정" 칩을 항상 표시(개수 배지 포함). 클릭 시 미정 행만 필터(다중 OR 결합).
    const untaggedN = counts[UNTAGGED_KEY] || 0;
    const untaggedBadge = hasData ? `<span class="fp-count">${untaggedN}</span>` : '';
    const untaggedPill = `<button class="filter-pill untagged-pill ${activeTags.has(UNTAGGED_KEY) ? 'active' : ''}" data-tag-filter="${UNTAGGED_KEY}" title="분류되지 않은 항목">미정${untaggedBadge}</button>`;
    // 12종 밖 커스텀 태그: 실제로 존재하면 뒤에 자연 나열(과설계 없이 그대로).
    const customPills = custom.map((tag) => {
      const n = counts[tag] || 0;
      const badge = hasData && n ? `<span class="fp-count">${n}</span>` : '';
      return `<button class="filter-pill ${activeTags.has(tag) ? 'active' : ''}" data-tag-filter="${esc(tag)}">${esc(tag)}${badge}</button>`;
    }).join('');
    el.innerHTML = clearChip + allPill + catPills + untaggedPill + customPills;
  });
}

async function setTagsFor(kind, id) {
  const input = prompt(`${kind} "${id}" 의 태그를 입력 (쉼표/공백 구분):`);
  if (input == null) return;
  try { await api('/tags/set', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id, tags: input }) }); }
  catch (e) { toast('저장하지 못했습니다: ' + e.message); return; }
  toast('태그 저장됨');
  loadTags();
  if (loaded.skills) loadSkillOverview();
  if (loaded.agents) loadAgentOverview();
  if (loaded.store) loadStore($('#global-search-input').value);
}

// F4: 다중 선택 토글. tag===''(=[전체])이면 집합 초기화. 그 외엔 있으면 제거, 없으면 추가(OR).
function applyTagFilter(tag) {
  if (tag === '') activeTags.clear();
  else if (activeTags.has(tag)) activeTags.delete(tag);
  else activeTags.add(tag);
  loadTags();
  // 매트릭스는 태그 필터를 클라이언트에서 적용 — 데이터가 있으면 재렌더(재fetch 불필요).
  if (loaded.skills) { mxState.skill.page = 1; if (mxState.skill.data) renderMatrix('skill'); else loadMatrix('skill'); }
  if (loaded.agents) { mxState.agent.page = 1; if (mxState.agent.data) renderMatrix('agent'); else loadMatrix('agent'); }
  if (loaded.store) loadStore($('#global-search-input').value);
}

// ===================== 스토어(store) =====================
// 레지스트리 목록 캐시(스토어 카드 출처 칩용) + [업데이트 확인] 결과.
let lastRegistries = [];
let regUpdates = {}; // registry id → {update_available, remote_revision, error}
let storePublishers = []; // SKC2: /publishers 결과 캐시(드릴다운 진입 시 조회)
let lastStoreItems = []; // 현재 스토어 항목 캐시(카테고리 칩 개수 배지 집계용 — 필터 전 전체).
// F6: 시작 시 백그라운드 증분 수집 상태({running,total,done,failed,errors:[{name,message}]}).
// 스토어 로드 때 함께 조회한다(자동 폴링 없음 — 새로고침/재진입으로만 갱신).
let lastCollectStatus = { running: false, total: 0, done: 0, failed: 0, errors: [] };

// item.id('reg-<registry_id>-<name>')로 출처 레지스트리를 찾는다.
// storeList는 목록 경량화로 source_* 필드를 내려주지 않아, registry.js가 부여한
// id 네임스페이스 + /registries 목록으로 출처를 복원한다(표시 전용).
function findRegistryFor(itemId) {
  if (!/^reg-/.test(String(itemId))) return null;
  const cands = [...lastRegistries].sort((a, b) => (b.id || '').length - (a.id || '').length);
  return cands.find((r) => String(itemId).startsWith('reg-' + r.id + '-')) || null;
}
// registry.js ownerRepoOf와 동일 표기(표시 전용): URL → owner/repo.
function ownerRepo(url) {
  let s = String(url || '').trim().replace(/\.git$/i, '');
  s = s.replace(/^https?:\/\/[^/]+\//i, '').replace(/^git@[^:]+:/i, '').replace(/^ssh:\/\/[^/]+\//i, '');
  const parts = s.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : (parts.join('/') || '');
}
// 스토어 카드 출처 칩: registry 출처면 source_ref + revision 앞 7자, 번들이면 은은한 표시.
function storeSourceChip(itemId) {
  const reg = findRegistryFor(itemId);
  if (reg) {
    const ref = ownerRepo(reg.url) || reg.name || reg.id;
    const rev = reg.revision ? ` <span class="src-rev">@${esc(reg.revision.slice(0, 7))}</span>` : '';
    return `<span class="src-chip registry">📚 ${esc(ref)}${rev}</span>`;
  }
  return '<span class="src-chip bundled">번들</span>';
}

// 스토어 카드 1개 마크업(번들 목록·드릴다운 공용).
function storeCardHtml(it) {
  const warn = it.transform_notes && it.transform_notes.length
    ? `<div class="loss-banner" style="margin:12px 0 0"><span class="lb-ic">⚠</span><div class="lb-txt">${it.transform_notes.map(esc).join(' / ')}</div></div>` : '';
  return `<div class="card">
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
      <span class="item-name" style="font-size:16px">${esc(it.name)}</span>
      <span class="badge muted">${esc(it.kind)}</span>
      ${it.official ? '<span class="badge ok">공식</span>' : ''}
      ${storeSourceChip(it.id)}
    </div>
    <div class="chip-list" style="margin-top:8px">${tagChipsHtml(it.tags)}</div>
    <div class="muted" style="margin-top:8px;font-size:13px">${esc(it.description || '')}</div>
    ${warn}
    <div class="store-card-foot">
      <button class="btn btn-secondary btn-sm" data-store-item="${esc(it.id)}">상세 / 미리보기</button>
      <button class="btn btn-primary btn-sm" data-store-preview="${esc(it.id)}">미리보기 · 적용</button>
    </div>
  </div>`;
}

async function loadStore(q) {
  // 드릴다운 진행 중이면 그 퍼블리셔의 목록만 다시 그린다(카드 그리드는 갱신만).
  // 새로고침 후 actualSkillCount가 바뀔 수 있으므로 storePublisher 참조도 최신화한다.
  if (storePublisher) {
    const slug = storePublisher.slug;
    await loadPublishers();
    const fresh = (storePublishers || []).find((p) => p.slug === slug);
    if (fresh) {
      storePublisher = fresh;
      const f = fresh.actualSkillCount != null;
      $('#store-drill-sub').textContent = f
        ? `${fresh.actualSkillCount} skills · ${fresh.repoCount || 0} repos`
        : `~${fresh.totalSkillsCurated || 0} skills 예상 · ${fresh.repoCount || 0} repos`;
    }
    await loadPublisherSkills();
    return;
  }

  showLoading('#store-list');
  let d, regs, cs;
  try {
    // F6: 수집 상태(collect-status)를 함께 조회. 실패해도 스토어는 계속(우아한 실패, D26-②).
    [d, regs, cs] = await Promise.all([
      api('/store' + (q ? '?q=' + encodeURIComponent(q) : '')),
      api('/registries').catch(() => ({ registries: [] })),
      api('/registries/collect-status').catch(() => null),
    ]);
  } catch { showLoadError('#store-list', () => loadStore(q)); return; }
  lastRegistries = regs.registries || [];
  if (cs) lastCollectStatus = cs;
  renderCollectStatus();
  setCount('store', (d.items || []).length);
  await loadPublishers();

  // 카테고리 칩 개수 배지 집계용으로 필터 전 전체 항목을 캐시하고, 칩 바를 다시 그린다.
  lastStoreItems = d.items || [];
  loadTags();
  // 번들·검색 결과(기존 카드) — 카테고리(태그) 다중 OR 필터 적용, 흐름 불변.
  const items = lastStoreItems.filter(tagMatch);
  const list = $('#store-list');
  // #5: 스토어 빈 상태 분기 — 필터/검색이 있으면 [필터 해제], 없으면 [레지스트리]에서 새로고침 안내.
  const hasFilter = activeTags.size > 0 || !!(q && q.trim());
  const emptyHtml = hasFilter
    ? `<div class="empty-state">검색/필터 결과 없음<span class="inline-acts" style="justify-content:center;margin-top:10px"><button class="btn btn-secondary btn-sm" data-store-clear-filter="1">필터 해제</button></span></div>`
    : `<div class="empty-state">번들/등록된 항목이 없습니다<span class="inline-acts" style="justify-content:center;margin-top:10px"><button class="btn btn-secondary btn-sm" data-reg-open="1">📚 레지스트리에서 새로고침</button></span></div>`;
  list.innerHTML = items.length ? items.map(storeCardHtml).join('') : emptyHtml;
}

// F6: 수집 진행 배너. running:true면 "완료 N / 전체 M" + "이따가 와서 확인" 안내.
// 자동 폴링은 하지 않는다(D28) — 새로고침(↻)이나 스토어 재진입으로만 갱신된다.
function renderCollectStatus() {
  const box = $('#store-collect-status');
  if (!box) return;
  const cs = lastCollectStatus || {};
  if (cs.running) {
    box.hidden = false;
    box.innerHTML = `<div class="collect-banner running">
      <span class="cb-spin">↻</span>
      <div class="cb-txt"><b>스킬 목록을 수집하고 있습니다</b> (완료 ${Number(cs.done) || 0} / 전체 ${Number(cs.total) || 0}) — 이따가 와서 확인해주세요.</div>
      <button class="btn btn-ghost btn-sm" data-collect-refresh="1" title="지금 다시 확인">↻ 새로고침</button>
    </div>`;
    return;
  }
  // 완료 후: 실패가 있으면 은은히 요약(크래시 없이 "이슈" 표면화, D26-②). 없으면 배너 숨김.
  if ((cs.failed || 0) > 0) {
    box.hidden = false;
    box.innerHTML = `<div class="collect-banner done-fail">
      <span class="cb-ic">⚠</span>
      <div class="cb-txt">수집 완료 — 일부 저장소(${cs.failed}개)를 가져오지 못했습니다. 해당 카드의 <b>[수집]</b>으로 다시 시도할 수 있습니다.</div>
    </div>`;
    return;
  }
  box.hidden = true;
  box.innerHTML = '';
}

// F6: 이 퍼블리셔의 repo 중 수집 실패한 것이 있는지(collect-status errors[].name 매칭).
// errors[].name = reg.name || reg.id 이므로 repo.name/id 둘 다로 대조한다.
function publisherCollectFailed(pub) {
  const errs = (lastCollectStatus && lastCollectStatus.errors) || [];
  if (!errs.length) return false;
  const names = new Set(errs.map((e) => e.name));
  return (pub.repos || []).some((r) => names.has(r.name) || names.has(r.id));
}

// ── SKC2: 퍼블리셔 카드 그리드 ────────────────────────────────────────
async function loadPublishers() {
  const grid = $('#store-pub-grid');
  if (!grid) return;
  let d;
  try { d = await api('/publishers'); }
  catch { showLoadError('#store-pub-grid', loadPublishers); return; }
  storePublishers = d.publishers || [];
  // 'user'(사용자 추가) 그룹은 항목(repo)이 있을 때만 노출.
  const shown = storePublishers.filter((p) => p.slug !== 'user' || (p.repoCount || 0) > 0);
  grid.innerHTML = shown.length ? shown.map(publisherCardHtml).join('') : '<div class="empty-state">퍼블리셔 없음.</div>';
}

// 퍼블리셔 카드 1개(+ F6 수집 상태). 카드 자체는 <button>이라, 수집 액션은 별도 요소로 분리한다.
function publisherCardHtml(p) {
  const fetched = p.actualSkillCount != null;
  const failed = !fetched && publisherCollectFailed(p);
  const collecting = !fetched && !failed && (lastCollectStatus && lastCollectStatus.running);
  // N = 실제값(fetched) 또는 예상(totalSkillsCurated, 은은한 톤).
  const n = fetched ? p.actualSkillCount : (p.totalSkillsCurated || 0);
  const skillsChip = fetched
    ? `<span class="pub-num">${n}</span> skills`
    : `<span class="pub-num est">~${n}</span> <span class="pub-est-note">skills 예상</span>`;
  // 상태 줄: 수집됨 / 수집 실패 / 수집 중 / 미수집.
  let state;
  if (fetched) state = `<span class="pub-state ready">✓ 목록 가져옴 · 클릭해서 적용</span>`;
  else if (failed) state = `<span class="pub-state fail">⚠ 수집 실패 · [수집]으로 다시 시도</span>`;
  else if (collecting) state = `<span class="pub-state collecting">↻ 수집 중… 이따가 확인</span>`;
  else state = `<span class="pub-state needs-fetch"><span class="badge muted">미수집</span> 아직 목록이 없습니다</span>`;
  const card = `<button class="pub-card" data-pub-open="${esc(p.slug)}">
      <span class="pub-ic">🏪</span>
      <span class="pub-body">
        <span class="pub-name">${esc(p.name)}${p.official ? '' : ' <span class="badge muted">사용자</span>'}</span>
        <span class="pub-meta">${skillsChip} · <span class="pub-num">${p.repoCount || 0}</span> repos</span>
        ${state}
      </span>
    </button>`;
  // 미수집(수집 중 아님) 퍼블리셔: [수집] 버튼(기존 registry refresh 재사용). repo가 여럿이면 각각.
  let collectAct = '';
  if (!fetched && !collecting) {
    const btns = (p.repos || []).map((r) =>
      `<button class="btn btn-secondary btn-sm" data-pub-collect="${esc(r.id)}">${failed ? '↻ 다시 수집' : '수집'}${(p.repos || []).length > 1 ? ` · ${esc(r.name || r.id)}` : ''}</button>`
    ).join('');
    if (btns) collectAct = `<div class="pub-collect-acts">${btns}</div>`;
  }
  return `<div class="pub-card-wrap">${card}${collectAct}</div>`;
}

// 카드 클릭 → 드릴다운 진입.
function openPublisherDrilldown(slug) {
  const pub = (storePublishers || []).find((p) => p.slug === slug);
  if (!pub) return;
  storePublisher = pub;
  storeCatTag = null;
  $('#store-default').hidden = true;
  $('#store-drilldown').hidden = false;
  $('#store-drill-title').textContent = pub.name;
  const fetched = pub.actualSkillCount != null;
  $('#store-drill-sub').textContent = fetched
    ? `${pub.actualSkillCount} skills · ${pub.repoCount || 0} repos`
    : `~${pub.totalSkillsCurated || 0} skills 예상 · ${pub.repoCount || 0} repos`;
  renderCategoryChips();
  loadPublisherSkills();
}

// [← 전체] — 카드 그리드로 복귀.
function closePublisherDrilldown() {
  storePublisher = null;
  storeCatTag = null;
  $('#store-drilldown').hidden = true;
  $('#store-default').hidden = false;
  loadStore($('#global-search-input') ? $('#global-search-input').value : '');
}

// F6: 퍼블리셔 카드의 [수집] — 기존 레지스트리 새로고침 API(/registries/refresh)를 재사용해
// 해당 repo 목록을 로컬 캐시에 가져온다. 즉시 "수집 중" 토스트만 띄우고(사용자가 기다리지 않게),
// 완료되면 스토어를 다시 그려 카드 상태(미수집→수집됨)를 반영한다.
async function collectRepo(id) {
  toast('수집 중입니다 — 이따가 와서 확인해주세요');
  try {
    const res = await fetch('/registries/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const r = await res.json().catch(() => ({}));
    if (!res.ok || r.error) { toast('수집 실패: ' + (r.error || res.status)); return; }
    toast(`✓ 수집 완료 — 스킬 ${r.count}개`);
  } catch (e) {
    toast('수집 실패: ' + e.message);
    return;
  }
  // 카드 상태 갱신(수집 상태·퍼블리셔 목록 재조회). 드릴다운 중이 아니면 그리드 새로고침.
  if (loaded.store) loadStore($('#global-search-input') ? $('#global-search-input').value : '');
}

// 카테고리 필터 칩(skill-tags 10종) — 기존 filter-pill 패턴 재사용, data-pub-cat 분기.
function renderCategoryChips() {
  const box = $('#store-cat-filters');
  if (!box) return;
  box.innerHTML =
    `<button class="filter-pill ${storeCatTag === null ? 'active' : ''}" data-pub-cat="">전체</button>` +
    CATEGORY_TAGS.map((t) => `<button class="filter-pill ${storeCatTag === t.key ? 'active' : ''}" data-pub-cat="${esc(t.key)}">${esc(t.ko)}</button>`).join('');
}

function applyCategoryFilter(key) {
  storeCatTag = (key === '' || key === storeCatTag) ? null : key;
  renderCategoryChips();
  loadPublisherSkills();
}

// 드릴다운 스킬 목록: GET /store?publisher=<slug> + 클라이언트 카테고리 필터.
async function loadPublisherSkills() {
  if (!storePublisher) return;
  const list = $('#store-drill-list');
  const pub = storePublisher;
  const fetched = pub.actualSkillCount != null;

  // 미fetch 상태: 아직 가져오지 않음 — 해당 퍼블리셔 repo들의 [새로고침] 유도.
  if (!fetched) {
    const refreshBtns = (pub.repos || []).map((r) =>
      `<button class="btn btn-secondary btn-sm" data-reg-refresh="${esc(r.id)}">↻ ${esc(r.name || r.id)}</button>`
    ).join('');
    list.innerHTML = `<div class="pub-empty-fetch">
      <div class="pef-title">아직 로컬에 가져온 목록이 없습니다</div>
      <div class="pef-sub">아래 저장소를 새로고침하면 스킬 목록을 로컬 캐시에 불러옵니다. 실제 적용은 다음 단계에서 다시 미리보기합니다. (예상 ~${pub.totalSkillsCurated || 0}개)</div>
      <div class="pef-acts">${refreshBtns || '<span class="muted">저장소 없음</span>'}</div>
    </div>`;
    return;
  }

  showLoading('#store-drill-list');
  let d;
  try { d = await api('/store?publisher=' + encodeURIComponent(pub.slug)); }
  catch { showLoadError('#store-drill-list', loadPublisherSkills); return; }
  let items = d.items || [];
  if (storeCatTag) items = items.filter((it) => (it.tags || []).includes(storeCatTag));
  list.innerHTML = items.length
    ? items.map(storeCardHtml).join('')
    : `<div class="empty-state">${storeCatTag ? '이 카테고리에 해당하는 스킬이 없습니다.' : '스킬 없음.'}</div>`;
}

async function openStoreDetail(id) {
  let item, prev;
  try {
    [item, prev] = await Promise.all([
      api('/store/item?id=' + encodeURIComponent(id)),
      api('/store/preview?id=' + encodeURIComponent(id)),
    ]);
  } catch (e) { toast('미리보기를 불러오지 못했습니다: ' + e.message); return; }
  const allLosses = [];
  let bodyHead = '';
  if (item && item.kind === 'skill' && item.body) bodyHead = `<div class="sub-label">본문</div><div class="code-block">${esc(item.body)}</div>`;
  else if (item && item.kind === 'agent' && item.neutral) bodyHead = `<div class="sub-label">중립 스키마</div><div class="code-block">${esc(JSON.stringify(item.neutral, null, 2))}</div>`;

  const perTool = (prev.perTool || []).map((pt) => {
    (pt.losses || []).forEach((l) => allLosses.push(`[${pt.to}] ${l}`));
    return `<div class="ov-card">
      <div class="ov-head"><span class="tool-dot" style="background:${TOOL_COLOR[pt.to]}"></span>${esc(pt.to)}</div>
      <div class="ov-kv"><b>대상</b> <code>${esc((pt.targetPath || '').split('/').slice(-2).join('/'))}</code></div>
      <div class="code-block" style="max-height:150px;font-size:11.5px">${esc(pt.diffText || '(차이 없음)')}</div>
    </div>`;
  }).join('');

  openPanel({
    title: (item && item.name) || id,
    meta: `<span class="kv"><b>종류</b> ${esc(prev.kind)}</span>`,
    bodyHtml: bodyHead + lossBanner(allLosses) + '<div class="sub-label">모델별 미리보기</div><div class="overlay-grid">' + perTool + '</div>',
    footHtml: `<button class="btn btn-primary" data-store-apply="${esc(id)}">세 모델에 적용</button><button class="btn btn-ghost" id="panel-cancel">닫기</button>`,
  });
}

async function doStoreApply(id, resolution, newName) {
  const res = await fetch('/store/apply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, resolution, newName }) });
  if (!res.ok) { toast('적용하지 못했습니다: ' + (await errMsg(res))); return; }
  const r = await res.json();
  if (r.conflict) { openConflict({ type: 'store', id, kind: r.kind, name: r.name || r.id, diff: r.diff }); return; }
  if (r.skipped) { toast(`건너뜀: ${r.kind} "${r.name || r.id}"`); }
  else if (r.reason === 'excluded') { toast('제외됨 — 적용하지 않았습니다'); }
  else if (r.applied) {
    const lossN = (r.results || []).reduce((a, x) => a + ((x.losses || []).length), 0);
    toast(`✓ 적용 완료 (3모델)${lossN ? ' · 손실 ' + lossN + '건' : ''}`);
  }
  if (loaded.skills) loadSkillOverview();
  if (loaded.agents) loadAgentOverview();
  if (loaded.store) loadStore($('#global-search-input').value);
}

// ===================== 레지스트리 관리(스토어-R2) =====================
async function openRegistriesModal() {
  $('#registries-modal').hidden = false;
  $('#registries-hint').textContent = '';
  await renderRegistriesList();
}

async function renderRegistriesList() {
  $('#registries-body').innerHTML = '<div class="skel">불러오는 중…</div>';
  let d;
  try { d = await api('/registries'); }
  catch { showLoadError('#registries-body', renderRegistriesList); return; }
  lastRegistries = d.registries || [];
  const rows = lastRegistries.map((r) => {
    const upd = regUpdates[r.id];
    const updBadge = upd
      ? (upd.update_available
        ? ' <span class="badge warn">업데이트 있음</span>'
        : (upd.error ? ' <span class="badge muted">확인 불가</span>' : ' <span class="badge ok">최신</span>'))
      : '';
    // 기본(번들) 레지스트리: "기본" 배지 + 제거 버튼 숨김(사용자 것만 제거 가능). 새로고침은 노출.
    const defBadge = r.official ? ' <span class="badge muted">기본</span>' : '';
    const removeBtn = r.official ? '' : `<button class="btn btn-ghost btn-sm" data-reg-remove="${esc(r.id)}">제거</button>`;
    return `<div class="proj-row">
      <div class="proj-main">
        <div class="proj-path">${esc(r.name || r.id)}${defBadge}${updBadge}</div>
        <div class="proj-markers">${esc(r.url)} · rev ${esc(r.revision ? r.revision.slice(0, 7) : '–')} · 갱신 ${esc(r.last_refreshed || '–')}</div>
      </div>
      <span class="inline-acts">
        <button class="btn btn-secondary btn-sm" data-reg-refresh="${esc(r.id)}">새로고침</button>
        ${removeBtn}
      </span>
    </div>`;
  }).join('') || '<div class="empty-state" style="padding:24px">등록된 레지스트리 없음.</div>';

  $('#registries-body').innerHTML =
    `<div class="proj-section">
       <div class="sub-label">등록된 레지스트리</div>
       ${rows}
     </div>
     <div class="proj-section">
       <div class="sub-label">레지스트리 추가</div>
       <div class="proj-add-row">
         <input id="reg-add-url" class="pg-input" placeholder="git 저장소 URL (예: https://github.com/<owner>/<repo>)" />
         <button class="btn btn-primary btn-sm" data-reg-add="1">추가</button>
       </div>
       <div class="muted" style="margin-top:8px;font-size:12px">추가는 등록만 합니다(통신 없음). 목록을 받아오려면 항목의 [새로고침]을 누르세요.</div>
     </div>`;
}

async function regAdd() {
  const url = ($('#reg-add-url') && $('#reg-add-url').value || '').trim();
  if (!url) { $('#registries-hint').textContent = 'URL을 입력하세요.'; return; }
  let r;
  try { r = await api('/registries/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }); }
  catch (e) { $('#registries-hint').textContent = e.message; return; }
  if (r.error) { $('#registries-hint').textContent = r.error; return; }
  $('#registries-hint').textContent = '';
  if (r.added === false) toast(`이미 등록됨: ${r.id || ''}`);
  else toast('레지스트리 등록됨 — [새로고침]으로 목록을 받아오세요');
  await renderRegistriesList();
}

async function regRemove(id) {
  let r;
  try { r = await api('/registries/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }
  catch (e) { toast('제거하지 못했습니다: ' + e.message); return; }
  if (r && r.removed === false) {
    // 기본(번들) 레지스트리는 제거 불가 — 명확히 안내만.
    toast(r.reason === 'default' ? '기본 레지스트리는 제거할 수 없습니다' : '제거할 항목이 없습니다');
    return;
  }
  delete regUpdates[id];
  toast('레지스트리 제거됨');
  await renderRegistriesList();
  if (loaded.store) loadStore($('#global-search-input').value); // 캐시 항목 제거 반영
}

async function regRefresh(id) {
  $('#registries-hint').textContent = '새로고침 중…';
  const res = await fetch('/registries/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const r = await res.json().catch(() => ({}));
  $('#registries-hint').textContent = '';
  // 새로고침 실패(네트워크 불가·repo 없음 등)는 일반 에러 토스트로 표시.
  if (!res.ok || r.error) { toast('새로고침 실패: ' + (r.error || res.status)); return; }
  toast(`✓ 레지스트리 갱신 — 스킬 ${r.count}개 (rev ${String(r.revision || '').slice(0, 7)})`);
  await renderRegistriesList();
  if (loaded.store) loadStore($('#global-search-input').value); // 병합 목록 재로드
}

async function regCheckUpdates() {
  let results;
  try { results = await api('/registries/updates'); }
  catch (e) { toast('업데이트 확인 실패: ' + e.message); return; }
  regUpdates = {};
  let avail = 0, errs = 0;
  for (const r of (Array.isArray(results) ? results : [])) {
    regUpdates[r.id] = r;
    if (r.error) errs++;
    if (r.update_available) avail++;
  }
  // 결과(배지)는 레지스트리 모달 목록에 표시 — 닫혀 있으면 열어서 보여준다.
  // 항목별 error는 목록의 "확인 불가" 배지로 표면화된다(기존 유지).
  if ($('#registries-modal').hidden) await openRegistriesModal();
  else await renderRegistriesList();
  toast(avail ? `업데이트 ${avail}건 발견` : (errs ? `확인 실패 ${errs}건` : '모든 레지스트리가 최신입니다'));
}

// ===================== 충돌 모달(overwrite/skip/rename) =====================
function openConflict(ctx) {
  conflictCtx = ctx;
  $('#conflict-msg').textContent = `${ctx.kind} "${ctx.name}" 가 이미 있습니다. 어떻게 할까요?`;
  // #3: 기존 vs 새 내용 diff를 라디오 위에 렌더(차이가 확실히 보이게). diff가 없으면 우아하게 안내(#6).
  const diffBox = $('#conflict-diff');
  if (diffBox) {
    if (ctx.diff && ctx.diff.length) {
      diffBox.innerHTML = `<div class="sub-label">기존 내용 → 새 내용 (변경점)</div><div class="conflict-diff-scroll">${renderDiff(ctx.diff)}</div>`;
    } else {
      diffBox.innerHTML = '<div class="empty-state" style="padding:12px">차이를 불러올 수 없습니다.</div>';
    }
  }
  // 라디오 초기화 → overwrite
  $$('#conflict-options .radio-row').forEach((r, i) => r.classList.toggle('sel', i === 0));
  $$('input[name=conflict-res]').forEach((r, i) => (r.checked = i === 0));
  $('#conflict-newname').hidden = true;
  $('#conflict-newname').value = '';
  $('#conflict-modal').hidden = false;
}
function confirmConflict() {
  const res = ($$('input[name=conflict-res]').find((r) => r.checked) || {}).value || 'overwrite';
  const newName = res === 'rename' ? ($('#conflict-newname').value || undefined) : undefined;
  $('#conflict-modal').hidden = true;
  const ctx = conflictCtx;
  if (!ctx) return;
  if (ctx.type === 'store') doStoreApply(ctx.id, res, newName);
  else if (ctx.type === 'pg-skill') pgAdoptSkill(ctx.id, res, newName);
  else if (ctx.type === 'pg-agent') pgAdoptAgent(res, newName);
}

// ===================== 플레이그라운드(playground) =====================
let pgAdoptTarget = null;
let pgComposed = null;

async function loadPgWizard() {
  let qs;
  try { qs = await api('/playground/skill/wizard'); }
  catch { showLoadError('#pg-skill-wizard', loadPgWizard); return; }
  const form = $('#pg-skill-wizard');
  form.innerHTML = qs.map((q) => {
    let control = '';
    if (q.type === 'text') control = `<input class="pg-input" data-pg-q="${esc(q.id)}" data-pg-type="text" />`;
    else if (q.type === 'multi') control = (q.options || []).map((o) => `<label class="pg-opt"><input type="checkbox" data-pg-q="${esc(q.id)}" data-pg-type="multi" value="${esc(o.value)}" /> ${esc(o.label)}</label>`).join('');
    else control = `<select class="pg-input" data-pg-q="${esc(q.id)}" data-pg-type="single">${(q.options || []).map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>`;
    return `<div class="pg-block"><label class="pg-q-label">${esc(q.label)}</label>${control}</div>`;
  }).join('');
  $('#pg-skill-recs').innerHTML = '<tr><td colspan="4" class="skel">조건을 고르고 “추천 받기”를 누르면 여기에서 후보를 보여줍니다.</td></tr>';
  $('#pg-agent-recs').innerHTML = '<tr><td colspan="4" class="skel">역할을 적고 “스킬 추천”을 누르면 에이전트 조합 후보를 보여줍니다.</td></tr>';
}

// #5: 플레이그라운드 추천 0건 처리 — 후보(중앙 저장소 스킬) 유무로 문구 분기.
// 후보 0이면 "먼저 스킬을 가져오세요"+[스킬 보기], 아니면 조건을 바꾸라는 기존 안내.
async function renderPgEmpty(sel, changeMsg, colspan = 4) {
  let hasCandidates = true; // 조회 실패 시엔 기존(조건 변경) 안내로 우아하게 폴백.
  try { const ov = await api('/skills/overview'); hasCandidates = (ov.canonicalSkills || []).length > 0; }
  catch { }
  const el = $(sel);
  if (!el) return;
  el.innerHTML = hasCandidates
    ? `<tr><td colspan="${colspan}" class="skel">${esc(changeMsg)}</td></tr>`
    : `<tr><td colspan="${colspan}" class="skel">먼저 스킬을 가져오세요 — 중앙 저장소에 스킬이 있어야 추천할 수 있습니다
        <span class="inline-acts" style="justify-content:center;margin-top:10px"><button class="btn btn-secondary btn-sm" data-goto="skills">스킬 보기</button></span></td></tr>`;
}

function pgSkillRecRow(s) {
  const si = scoreInfo(s.score);
  return `<tr>
    <td><span class="item-name">${esc(s.name)}</span></td>
    <td><span class="score-pill ${si.cls}" title="원점수 ${esc(si.detail)}">${esc(si.label)}</span></td>
    <td class="muted">${esc(reasonsHuman(s.reasons))}</td>
    <td class="cell"><span class="inline-acts">
      <button class="btn btn-primary btn-sm" data-pg-skill-preview="${esc(s.id)}">미리보기 · 적용</button>
    </span></td>
  </tr>`;
}

function pgAgentRecRow(s) {
  const si = scoreInfo(s.score);
  return `<tr>
    <td class="cell"><input type="checkbox" data-pg-pick="${esc(s.id)}" /></td>
    <td><span class="item-name">${esc(s.name)}</span></td>
    <td><span class="score-pill ${si.cls}" title="원점수 ${esc(si.detail)}">${esc(si.label)}</span></td>
    <td class="muted">${esc(reasonsHuman(s.reasons))}</td>
  </tr>`;
}

function pgCollectAnswers() {
  const answers = {};
  for (const el of $$('#pg-skill-wizard [data-pg-q]')) {
    const id = el.dataset.pgQ;
    if (el.dataset.pgType === 'multi') { if (el.checked) (answers[id] = answers[id] || []).push(el.value); }
    else answers[id] = el.value;
  }
  return answers;
}

async function pgRecommendSkills() {
  const answers = pgCollectAnswers();
  let recs;
  try { recs = await api('/playground/skill/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answers }) }); }
  catch { showLoadError('#pg-skill-recs', pgRecommendSkills, 4); return; }
  if (recs.length) {
    $('#pg-skill-recs').innerHTML = recs.map(pgSkillRecRow).join('');
  } else {
    // #5: 추천 0건 — 후보(중앙 저장소 스킬) 자체가 없으면 "먼저 스킬을 가져오세요"로 분기.
    await renderPgEmpty('#pg-skill-recs', '추천 결과 없음 — 조건을 바꿔보세요');
  }
}

function pgRenderPreview(prev) {
  const allLosses = [];
  const perTool = (prev.perTool || []).map((pt) => {
    (pt.losses || []).forEach((l) => allLosses.push(`[${pt.to}] ${l}`));
    return `<div class="ov-card">
      <div class="ov-head"><span class="tool-dot" style="background:${TOOL_COLOR[pt.to]}"></span>${esc(pt.to)}</div>
      <div class="ov-kv"><b>대상</b> <code>${esc((pt.targetPath || '').split('/').slice(-2).join('/'))}</code></div>
      <div class="code-block" style="max-height:150px;font-size:11.5px">${esc(pt.diffText || '(차이 없음)')}</div>
    </div>`;
  }).join('');
  openPanel({
    title: `${prev.kind} ${prev.name || prev.id || ''}`,
    meta: prev.exists ? '<span class="kv"><b>이미 존재</b></span>' : '',
    bodyHtml: lossBanner(allLosses) + '<div class="sub-label">모델별 미리보기</div><div class="overlay-grid">' + perTool + '</div>',
    footHtml: `<button class="btn btn-primary" id="pg-adopt-btn">적용 (중앙 저장소 저장 + 3모델 push)</button>`
      + `<button class="btn btn-ghost" disabled title="다음 단계(실제 모드 필요)">실제 실행(준비 중)</button>`
      + `<button class="btn btn-ghost" id="panel-cancel">닫기</button>`,
  });
}

async function pgPreviewSkill(id) {
  let prev;
  try { prev = await api('/playground/skill/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }); }
  catch (e) { toast('미리보기를 불러오지 못했습니다: ' + e.message); return; }
  pgAdoptTarget = { kind: 'skill', id };
  pgRenderPreview(prev);
}

function pgRenderAdopt(r) {
  if (r.conflict) {
    const type = (pgAdoptTarget && pgAdoptTarget.kind === 'skill') ? 'pg-skill' : 'pg-agent';
    openConflict({ type, id: r.id || (pgAdoptTarget && pgAdoptTarget.id), kind: r.kind, name: r.name || r.id, diff: r.diff });
    return;
  }
  if (r.skipped) toast(`건너뜀: ${r.kind} "${r.name || r.id}"`);
  else if (r.applied) {
    const lossN = (r.results || []).reduce((a, x) => a + ((x.losses || []).length), 0);
    toast(`✓ 적용 완료 (3모델)${lossN ? ' · 손실 ' + lossN + '건' : ''}`);
    closePanel();
  }
  if (loaded.skills) loadSkillOverview();
  if (loaded.agents) loadAgentOverview();
  if (loaded.store) loadStore($('#global-search-input').value);
}

async function pgAdoptSkill(id, resolution, newName) {
  try {
    const r = await api('/playground/skill/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, resolution, newName }) });
    pgRenderAdopt(r);
  } catch (e) { toast('적용하지 못했습니다: ' + e.message); }
}

async function pgRecommendForRole() {
  const role = $('#pg-role').value;
  let recs;
  try { recs = await api('/playground/agent/recommend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) }); }
  catch { showLoadError('#pg-agent-recs', pgRecommendForRole, 4); return; }
  if (recs.length) {
    $('#pg-agent-recs').innerHTML = recs.map(pgAgentRecRow).join('');
  } else {
    // #5: 추천 0건 — 후보 스킬이 아예 없으면 "먼저 스킬을 가져오세요"로 분기.
    await renderPgEmpty('#pg-agent-recs', '추천 결과 없음 — 역할 설명을 바꿔보세요', 4);
  }
}

async function pgCompose() {
  const pickedIds = $$('#pg-agent-recs [data-pg-pick]:checked').map((c) => c.dataset.pgPick);
  const role = $('#pg-role').value;
  const name = $('#pg-agent-name').value || undefined;
  let neutral;
  try { neutral = await api('/playground/agent/compose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role, pickedIds, name }) }); }
  catch (e) { toast('조합하지 못했습니다: ' + e.message); return; }
  pgComposed = neutral;
  $('#pg-compose-out').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">
      <span class="item-name" style="font-size:15px">${esc(neutral.name)}</span>
      <span class="badge muted">agent</span>
    </div>
    <div class="chip-list" style="margin-top:8px">${tagChipsHtml(neutral.tags)}</div>
    <div class="muted" style="margin-top:6px;font-size:13px">${esc(neutral.source_notes || '')}</div>
    <div class="inline-acts" style="margin-top:12px"><button class="btn btn-secondary btn-sm" id="pg-agent-preview-btn">미리보기</button></div>`;
}

async function pgPreviewAgent() {
  if (!pgComposed) return;
  let prev;
  try { prev = await api('/playground/agent/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ neutral: pgComposed }) }); }
  catch (e) { toast('미리보기를 불러오지 못했습니다: ' + e.message); return; }
  pgAdoptTarget = { kind: 'agent' };
  pgRenderPreview(prev);
}

async function pgAdoptAgent(resolution, newName) {
  if (!pgComposed) return;
  try {
    const r = await api('/playground/agent/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ neutral: pgComposed, resolution, newName }) });
    pgRenderAdopt(r);
  } catch (e) { toast('적용하지 못했습니다: ' + e.message); }
}

function pgAdoptCurrent() {
  if (!pgAdoptTarget) return;
  if (pgAdoptTarget.kind === 'skill') pgAdoptSkill(pgAdoptTarget.id);
  else pgAdoptAgent();
}

// ===================== 사용량(usage) =====================
// 사용빈도 전용 표. GET /usage → items[]{ id, kind, freq:{day1,day7,total}, lastUsed }.
// 컬럼: 이름 · 최근 사용(lastUsed) · 일주일 사용빈도(freq.day7). (하루·전체 컬럼 제거.)
// 백엔드 계약: 각 item에 freq가 붙는다. 구 응답에서는 freq가 없을 수 있으므로 항상 `|| 0`으로 안전 소비.
// 정렬: 최근 사용(lastUsed) 최신순. lastUsed가 없는 항목은 아래로. 0인 항목도 표시한다.
// (v2) 사용량 뷰: 3지표 카드(1일/7일/이력) + 정렬 토글(최근/사용량) + 5컬럼 표(전체=막대).
let usageSort = 'recent';   // 'recent' | 'total'
let usageData = null;       // 마지막 /usage 응답(정렬 토글 시 재fetch 없이 재렌더).

async function loadUsage() {
  showLoading('#usage-rows', 5, '사용 기록을 세고 있습니다 — 조금만 기다려주세요…');
  let u;
  // /usage = Claude 세션 기록에서 스킬 호출 "횟수"만 집계(B 신호, 본문은 읽지 않음).
  // 개요의 "지난 1일/7일 사용"과 같은 소스 → 두 화면 숫자가 일치한다.
  try { u = await api('/usage'); }
  catch { showLoadError('#usage-rows', loadUsage, 5); return; }
  usageData = u;
  const note = $('#usage-note');
  if (note && u.source === 'none') {
    note.textContent = '아직 집계된 사용 기록이 없습니다 — Claude로 스킬을 쓰면 여기에 횟수가 쌓입니다.';
  }
  renderUsage();
}

function renderUsage() {
  const u = usageData || { items: [] };
  const items0 = u.items || [];
  const f = (x) => x.freq || {};

  // 3지표 카드: 지난 1일 / 지난 7일 / 사용 이력 있음.
  const statsBox = $('#usage-stats');
  if (statsBox) {
    const day1 = items0.filter((x) => (f(x).day1 || 0) > 0).length;
    const day7 = items0.filter((x) => (f(x).day7 || 0) > 0).length;
    const ever = items0.filter((x) => (f(x).total || 0) > 0).length;
    const cards = [
      { label: '지난 1일', num: day1, trend: '24시간 내 사용한 스킬' },
      { label: '지난 7일', num: day7, trend: '7일 내 사용한 스킬' },
      { label: '사용 이력 있음', num: ever, trend: '한 번이라도 쓴 스킬' },
    ];
    statsBox.innerHTML = cards.map((c) => `
      <div class="stat" style="cursor:default">
        <div class="stat-head"><span class="stat-label">${esc(c.label)}</span></div>
        <div class="stat-num" style="font-size:30px;letter-spacing:-0.8px">${c.num}</div>
        <div class="stat-trend">${esc(c.trend)}</div>
      </div>`).join('');
  }

  // 정렬 토글(최근 사용 순 / 사용량 순).
  const sortBox = $('#usage-sort');
  if (sortBox) {
    sortBox.innerHTML = `<span class="usage-sort-label">정렬</span>
      <button class="filter-pill ${usageSort === 'recent' ? 'active' : ''}" data-usage-sort="recent">최근 사용 순</button>
      <button class="filter-pill ${usageSort === 'total' ? 'active' : ''}" data-usage-sort="total">사용량 순</button>`;
  }

  const items = items0.slice().sort((a, b) => {
    if (usageSort === 'total') {
      const d = (f(b).total || 0) - (f(a).total || 0);
      if (d) return d;
    } else {
      const la = a.lastUsed ? new Date(a.lastUsed).getTime() : 0;
      const lb = b.lastUsed ? new Date(b.lastUsed).getTime() : 0;
      if (lb !== la) return lb - la;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const maxTotal = items.reduce((m, x) => Math.max(m, f(x).total || 0), 0) || 1;
  const num = (n) => n > 0 ? `<span>${n}</span>` : `<span class="usage-zero">0</span>`;
  $('#usage-rows').innerHTML = items.length ? items.map((x) => {
    const fq = f(x);
    const total = fq.total || 0;
    return `<tr style="cursor:default">
      <td><span class="item-name">${esc(x.name)}</span></td>
      <td class="num-cell">${x.lastUsed ? esc(formatDateHuman(x.lastUsed)) : '<span class="usage-zero">—</span>'}</td>
      <td class="num-cell">${num(fq.day1 || 0)}</td>
      <td class="num-cell">${num(fq.day7 || 0)}</td>
      <td><span class="usage-bar-wrap">
        <span class="usage-bar"><span style="width:${Math.round((total / maxTotal) * 100)}%"></span></span>
        <span class="usage-num ${total ? '' : 'usage-zero'}">${total}</span>
      </span></td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="skel">스킬이 없습니다
    <span class="inline-acts" style="justify-content:center;margin-top:10px"><button class="btn btn-secondary btn-sm" data-goto="skills">스킬 보기</button></span></td></tr>`;
}

// (백업/복구 UI 제거 — loadBackups/renderBackups/복구 확인 모달·핸들러 삭제.
//  백엔드 /backups·복구 API·자동 백업 엔진은 존치. UI 진입점만 없앴다.)

// ===================== 동기화(Sync) — 미등록 소스 → 중앙 저장소 + 3도구 =====================
// 현재 진행 중인 sync 컨텍스트 {kind, name, sourceId?, baseTool?, scope?}.
let currentSync = null;

// 콘텐츠 그룹 번호 → 색 클래스(같은 그룹 = 같은 색 = 내용 동일).
function syncGroupClass(group) {
  if (group == null) return 'sg-none';
  return 'sg-' + (((group - 1) % 4) + 1);
}

function syncPlanSummaryHtml(baseTool) {
  const plan = currentSync && currentSync.plan;
  if (!plan || !baseTool) return '<div class="sync-summary" id="sync-change-summary">기준 모델을 선택하면 실제 변경 요약을 보여줍니다.</div>';
  const base = (plan.tools || []).find((x) => x.tool === baseTool);
  const baseGroup = base && base.group;
  const changes = [`${baseTool} 내용을 중앙 원본에 저장`];
  for (const t of (plan.tools || [])) {
    if (t.tool === baseTool) continue;
    if (!t.exists) changes.push(`${t.tool}에 새로 내보내기`);
    else if (t.group !== baseGroup) changes.push(`${t.tool} 내용을 기준과 같게 갱신`);
    else changes.push(`${t.tool}는 이미 같아서 건너뜀`);
  }
  return `<div class="sync-summary" id="sync-change-summary"><b>실행하면</b><ul>${changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><div class="muted" style="margin-top:6px">덮어쓰기 전 백업을 만들고, 실행 뒤 결과를 모델별로 보여줍니다.</div></div>`;
}

async function openSyncModal(kind, name, source, scope) {
  // source = 이 행의 소스(skill이면 source_id, agent면 도구명). skill은 sourceId로 전달.
  const sourceId = kind === 'skill' ? (source || undefined) : undefined;
  // 이 행의 기준 도구 추정: skill은 source_id→도구, agent는 source가 곧 도구.
  const rowBase = kind === 'skill' ? (source ? skillSourceTool(source) : null) : (source || null);
  // (과제4) scope = 'global' 또는 프로젝트 루트 절대경로. 인자 미전달 시 매트릭스 행에서 유도(없으면 global).
  //  이 폴더 안에서만 동기화하도록 /sync/plan·/sync/apply에 그대로 실어 보낸다(백엔드 계약).
  const rowScope = scope || mxScopeOf(kind, name);
  currentSync = { kind, name, sourceId, baseTool: null, rowBase, scope: rowScope };
  $('#sync-title').textContent = `동기화 — ${kind === 'skill' ? '스킬' : '에이전트'} "${name}"`;
  $('#sync-body').innerHTML = '<div class="skel">계획을 불러오는 중…</div>';
  $('#sync-run').disabled = true;
  $('#sync-modal').hidden = false;
  const qs = '/sync/plan?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name)
    + '&scope=' + encodeURIComponent(rowScope);
  let plan;
  try { plan = await fetch(qs).then((r) => r.json()); }
  catch { $('#sync-body').innerHTML = '<div class="empty-state">계획을 불러오지 못했습니다.</div>'; return; }
  if (plan.error) { $('#sync-body').innerHTML = `<div class="empty-state">${esc(plan.error)}</div>`; return; }
  renderSyncPlan(plan);
}

// (과제4) 동기화 대상 위치 한 줄 안내 — 모달에 삽입한다. global이면 "전역(~)", 아니면 폴더명(전체 경로 title).
function syncScopeLineHtml(scope) {
  if (!scope || scope === 'global') return `<div class="sync-scope-line muted">전역(~) 위치에서 맞춥니다</div>`;
  const folder = baseName(scope);
  return `<div class="sync-scope-line muted" title="${esc(scope)}">이 폴더 안에서 맞춥니다: <b>${esc(folder)}</b></div>`;
}

// (v2) 기준 모델 세그먼트 컨트롤 — 목업 diff 모달의 "Claude 기준 / Codex 기준".
//  선택 가능한 후보(cands)만 활성. data-sync-base로 selectSyncBase와 배선(공용).
function syncBaseSegHtml(cands) {
  const btn = (tool, label) => {
    const enabled = cands.includes(tool);
    return `<button class="seg-btn" data-sync-base="${esc(tool)}" ${enabled ? '' : 'disabled'}>${esc(label)} 기준</button>`;
  };
  return `<div style="display:flex;align-items:center;gap:12px;margin:14px 0 4px">
    <span style="font-size:13px;color:#6e6e73;flex:none">기준 모델</span>
    <div class="seg" style="flex:1;max-width:280px">${btn('claude', 'Claude')}${btn('codex', 'Codex')}</div>
  </div>
  <div id="sync-direction" style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:#515158"></div>`;
}

// 세그먼트 선택 후 방향 라벨("Claude → Codex") 갱신.
function syncDirectionUpdate(baseTool) {
  const el = $('#sync-direction');
  if (!el) return;
  if (!baseTool) { el.innerHTML = '<span class="muted">기준 모델을 선택하세요</span>'; return; }
  const target = TOOLS.find((t) => t !== baseTool);
  const cap = (t) => t === 'claude' ? 'Claude' : 'Codex';
  el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;background:var(--line-4);border-radius:8px;padding:4px 10px;font-weight:600">${cap(baseTool)} → ${cap(target)}</span>
    <span style="color:#a1a1a6">${cap(baseTool)} 내용을 ${cap(target)}에 맞춥니다</span>`;
}

// plan에서 2모델 동기화 상태를 계산한다(매트릭스 syncStateOf와 동일 의미).
//  - single : 존재하는 모델이 1개(baseCandidates.length===1)
//  - synced : 둘 다 존재 + 같은 그룹(내용 동일)
//  - drift  : 둘 다 존재 + 다른 그룹(내용 다름)
//  - none   : 둘 다 없음(방어 — 정상 흐름에선 안 옴)
function planSyncState(plan) {
  const present = (plan.tools || []).filter((t) => t.exists);
  if (present.length === 0) return 'none';
  if (present.length === 1) return 'single';
  const groups = new Set(present.map((t) => t.group));
  return groups.size === 1 ? 'synced' : 'drift';
}

// (과제3) 동기화 모달 라우터. skill은 상태별 단순화 UI로, agent는 기존 전체 UI(기준 선택)로.
//  skill single → "있는 모델 → 없는 모델 복사" 바로 제안 · drift → 양자택일 · synced → 비활성.
//  에이전트는 codex가 tools를 지원하지 않아 손실 안내가 필요하므로 기존 기준 선택 흐름을 유지한다.
function renderSyncPlan(plan) {
  currentSync.plan = plan;
  if (currentSync.kind === 'skill') {
    const state = planSyncState(plan);
    if (state === 'single') return renderSyncPlanSingle(plan);
    if (state === 'drift') return renderSyncPlanDrift(plan);
    if (state === 'synced') return renderSyncPlanSynced(plan);
    // none 등 예외 상황은 기존 전체 UI로 폴백(안전).
  }
  return renderSyncPlanFull(plan);
}

// (과제3-single) 한 모델에만 있는 스킬: 기준 선택을 건너뛰고 "있는 모델 → 없는 모델 복사"를 바로 제안.
//  확인 1회 → 기존 runSync(baseTool=있는 모델). 미리보기·백업 흐름은 그대로 이어진다.
function renderSyncPlanSingle(plan) {
  const from = (plan.baseCandidates || [])[0] || (plan.tools.find((t) => t.exists) || {}).tool;
  const to = TOOLS.find((t) => t !== from);
  $('#sync-title').textContent = `동기화 — 스킬 "${plan.name}"`;
  $('#sync-body').innerHTML =
    `<div class="sync-lead"><b>${esc(from)}</b>에만 있습니다 → <b>${esc(to)}</b>로 복사할까요?</div>
     ${syncScopeLineHtml(currentSync.scope)}
     <div class="sync-copy-flow">
       <span class="sync-copy-node"><span class="tool-dot" style="background:${TOOL_COLOR[from]}"></span>${esc(from)}<span class="scn-note">있음</span></span>
       <span class="sync-copy-arrow">→</span>
       <span class="sync-copy-node absent"><span class="tool-dot" style="background:${TOOL_COLOR[to]}"></span>${esc(to)}<span class="scn-note">없음 → 새로 만듦</span></span>
     </div>
     <div class="muted" style="margin-top:10px">스킬은 복사 방식이라 변환 손실이 없습니다. 덮어쓰기 전 자동 백업합니다.</div>`;
  // 기준(base)을 "있는 모델"로 확정 → 확인 버튼 1회로 실행. selectSyncBase가 currentSync.baseTool을 세팅한다.
  selectSyncBase(from);
  $('#sync-run').textContent = `${to}로 복사`;
  $('#sync-run').disabled = false;
}

// (과제3-drift) 둘 다 있는데 내용이 다른 스킬: (v2) 세그먼트로 기준을 고르고 방향("A → B")을 확인한다.
//  기존 충돌 diff(차이 보기)를 재사용(doSkillDiff). 선택 → 확인 → runSync(baseTool=선택).
function renderSyncPlanDrift(plan) {
  const cands = plan.baseCandidates || [];
  $('#sync-title').textContent = `스킬 동기화 미리보기 — "${plan.name}"`;
  $('#sync-body').innerHTML =
    `<div class="sync-lead">두 모델의 <b>내용이 서로 다릅니다</b>. 어느 쪽을 기준으로 맞출지 고르세요.</div>
     ${syncScopeLineHtml(currentSync.scope)}
     ${syncBaseSegHtml(cands)}
     <div class="inline-acts" style="margin-top:12px">
       <button class="btn btn-ghost btn-sm" data-skill-diff-name="${esc(plan.name)}" data-skill-diff-to="${esc(cands[1] || cands[0])}">차이 보기</button>
     </div>
     <div id="skill-inline-diff"></div>
     ${syncPlanSummaryHtml(null)}`;
  $('#sync-run').disabled = true;
  currentSync.baseTool = null;
  syncDirectionUpdate(null);
  // 직전 기준/행 소스 도구가 후보면 자동 선택(기존 #8 규칙 재사용).
  const prefer = [lastSyncBase, currentSync.rowBase].find((t) => t && cands.includes(t));
  if (prefer) selectSyncBase(prefer);
}

// (과제3-synced) 이미 동일: 실행 버튼 비활성 + "이미 같음" 안내.
function renderSyncPlanSynced(plan) {
  $('#sync-title').textContent = `동기화 — 스킬 "${plan.name}"`;
  $('#sync-body').innerHTML =
    `<div class="loss-banner ok"><span class="lb-ic">✓</span><div class="lb-txt">두 모델이 <b>이미 같습니다</b> — 동기화할 것이 없습니다.</div></div>
     ${syncScopeLineHtml(currentSync.scope)}
     <div class="inline-acts" style="margin-top:10px">
       <button class="btn btn-ghost btn-sm" data-skill-diff-name="${esc(plan.name)}" data-skill-diff-to="codex">차이 보기</button>
     </div>
     <div id="skill-inline-diff"></div>`;
  currentSync.baseTool = null;
  $('#sync-run').disabled = true;
  $('#sync-run').textContent = '이미 같음';
}

function renderSyncPlanFull(plan) {
  // (currentSync.plan은 라우터 renderSyncPlan에서 이미 설정됨)
  // (1) 도구별 카드: 존재/그룹(내용 동일)/스코프/notes
  const cards = TOOLS.map((tool) => {
    const t = (plan.tools || []).find((x) => x.tool === tool) || { tool, exists: false, group: null, notes: [] };
    const gCls = t.exists ? syncGroupClass(t.group) : 'sg-none';
    const gLabel = t.exists ? `그룹 ${t.group}` : '없음';
    const notes = (t.notes || []).map((n) => `<span class="sn-item">· ${esc(n)}</span>`).join('');
    return `<div class="sync-card ${t.exists ? '' : 'absent'}">
      <div class="sync-card-head">
        <span class="tool-dot" style="background:${TOOL_COLOR[tool]}"></span>${tool}
        <span class="sync-group-tag ${gCls}">${esc(gLabel)}</span>
      </div>
      <div class="sync-card-state">${t.exists ? (t.scope === 'project' ? '있음 · project' : '있음') : '이 모델엔 없음'}</div>
      ${notes ? `<div class="sync-notes">${notes}</div>` : ''}
    </div>`;
  }).join('');

  // (2) 기준 도구 선택 — baseCandidates만 선택 가능. agent는 perBaseLosses로 손실 안내.
  const base = plan.baseCandidates || [];
  const rows = TOOLS.map((tool) => {
    const selectable = base.includes(tool);
    let lossHtml = '';
    if (selectable && plan.kind === 'agent') {
      const per = (plan.perBaseLosses || {})[tool] || {};
      const parts = [];
      for (const target of TOOLS) {
        if (target === tool) continue;
        const l = per[target] || [];
        if (l.length) parts.push(`${target}: ${l.map(esc).join(' / ')}`);
      }
      lossHtml = parts.length
        ? `<div class="sync-base-loss">이 기준으로 내보내면 → ${parts.join(' · ')}</div>`
        : `<div class="sync-base-loss none">이 기준으로 내보낼 때 손실 없음</div>`;
    } else if (selectable && plan.kind === 'skill') {
      lossHtml = `<div class="sync-base-loss none">스킬은 복사 방식 — 변환 손실 없음</div>`;
    }
    return `<div class="sync-base-row ${selectable ? '' : 'disabled'}" ${selectable ? `data-sync-base="${esc(tool)}"` : ''}>
      <span class="radio-dot"></span>
      <div class="sync-base-main">
        <div class="sync-base-name"><span class="tool-dot" style="background:${TOOL_COLOR[tool]}"></span>${tool}${selectable ? '' : ' <span class="muted" style="font-weight:400;font-size:12px">(내용 없음 — 기준 불가)</span>'}</div>
        ${lossHtml}
      </div>
    </div>`;
  }).join('');

  $('#sync-body').innerHTML =
    `<div class="sync-lead">모델별 현재 상태입니다. 같은 <b>그룹</b> 번호(같은 색)면 내용이 동일합니다.</div>
     ${syncScopeLineHtml(currentSync.scope)}
     <div class="sync-tool-grid">${cards}</div>
     <div class="sync-base-block">
       <div class="sync-base-label">기준 모델 선택</div>
       <div class="sync-lead" style="margin-bottom:6px">기준 모델의 내용을 중앙 저장소로 가져오고, 일치하지 않는 모델에 내보냅니다(백업 후).</div>
       ${rows}
       ${syncPlanSummaryHtml(null)}
     </div>`;
  $('#sync-run').disabled = true;
  currentSync.baseTool = null;
  // #8: 직전 기준 도구(lastSyncBase)를 기본 선택값으로. 없으면 이 행의 소스 도구.
  // 둘 다 후보(baseCandidates)일 때만 자동 선택한다(우아한 실패 — 없으면 사용자가 고른다).
  const prefer = [lastSyncBase, currentSync.rowBase].find((t) => t && base.includes(t));
  if (prefer) selectSyncBase(prefer);
}

function selectSyncBase(tool) {
  if (!currentSync) return;
  currentSync.baseTool = tool;
  lastSyncBase = tool; // #8: 다음 단건 동기화 모달의 기본 선택값으로 기억(세션 내).
  // (v2) 라디오 행(.sel)과 세그먼트 버튼(.active) 두 UI를 모두 지원(스킬=seg, 에이전트=radio).
  $$('#sync-body .sync-base-row').forEach((r) => r.classList.toggle('sel', r.dataset.syncBase === tool));
  $$('#sync-body .seg-btn[data-sync-base]').forEach((b) => b.classList.toggle('active', b.dataset.syncBase === tool));
  syncDirectionUpdate(tool);
  const summary = $('#sync-change-summary');
  if (summary) summary.outerHTML = syncPlanSummaryHtml(tool);
  $('#sync-run').disabled = false;
}

async function runSync() {
  if (!currentSync || !currentSync.baseTool) return;
  const { kind, name, sourceId, baseTool, scope } = currentSync;
  $('#sync-run').disabled = true;
  let res;
  try {
    res = await fetch('/sync/apply', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // (과제4) scope를 그대로 실어 보낸다(백엔드 계약 — 없으면 서버가 무시). global 또는 프로젝트 루트.
      body: JSON.stringify({ kind, name, baseTool, sourceId, scope }),
    });
  } catch (e) { $('#sync-run').disabled = false; toast('동기화 실패: ' + e.message); return; }
  if (!res.ok) { $('#sync-run').disabled = false; toast('동기화 실패: ' + (await errMsg(res))); return; }
  const r = await res.json();
  if (r.error) { $('#sync-run').disabled = false; toast('동기화 실패: ' + r.error); return; }
  renderSyncResult(r);
  // 목록 새로고침 (열려 있는 뷰만)
  if (loaded.skills) loadSkillOverview();
  if (loaded.agents) loadAgentOverview();
  const pushed = (r.results || []).filter((x) => x.action === 'pushed').length;
  const errs = (r.results || []).filter((x) => x.action === 'error').length;
  toast(`✓ 동기화 완료 · pushed ${pushed}${errs ? ` · 오류 ${errs}` : ''}`);
}

function renderSyncResult(r) {
  const pulled = r.pulled || {};
  const pulledHtml = pulled.imported === false
    ? `<div class="loss-banner"><span class="lb-ic">⚠</span><div class="lb-txt">가져오기 안 됨: ${esc(pulled.reason || '')}</div></div>`
    : `<div class="loss-banner ok"><span class="lb-ic">✓</span><div class="lb-txt">기준 <b>${esc(pulled.from || currentSync.baseTool)}</b> → 중앙 저장소 저장 완료</div></div>`;
  const resRows = (r.results || []).map((x) => {
    let label, detail = '';
    if (x.action === 'pushed') { label = '<span class="badge ok">내보냄</span>'; detail = esc((x.targetPath || '').split('/').slice(-2).join('/')) + (x.backup ? ' · 백업됨' : '') + ((x.losses || []).length ? ` · 손실 ${x.losses.length}` : ''); }
    else if (x.action === 'skipped_same') { label = '<span class="badge muted">동일 — 건너뜀</span>'; detail = esc((x.targetPath || '').split('/').slice(-2).join('/')); }
    else { label = '<span class="badge error">오류</span>'; detail = esc(x.error || ''); }
    return `<div class="sync-result-row"><span class="tool-dot" style="background:${TOOL_COLOR[x.tool]}"></span><span class="tool-name">${esc(x.tool)}</span>${label}<span class="srr-detail">${detail}</span></div>`;
  }).join('');
  $('#sync-body').innerHTML = pulledHtml + '<div class="sync-base-label" style="margin-top:8px">모델별 결과</div>' + (resRows || '<div class="muted" style="padding:10px">내보낼 모델 없음</div>');
  // 실행 후: 실행 버튼 숨기고 닫기만
  $('#sync-run').hidden = true;
  $('#sync-cancel').textContent = '닫기';
}

function closeSyncModal() {
  $('#sync-modal').hidden = true;
  $('#sync-run').hidden = false;
  $('#sync-run').disabled = true;
  // (과제3) single/synced 흐름에서 바꾼 실행 버튼 텍스트를 기본값으로 복원(다음 모달 오염 방지).
  $('#sync-run').textContent = '적용하기';
  $('#sync-cancel').textContent = '취소';
  currentSync = null;
}

// ===================== 배치 동기화(#8) — 선택 항목을 순차로 /sync/apply =====================
// kind: 'skill' | 'agent'. 체크된 행을 순차 실행하고 진행/결과를 인라인으로 보여준다.
// 기준 도구(baseTool)는 매트릭스 행에서 존재하는 첫 도구(data-mx-base)를 기본값으로 쓴다.
async function runBatchSync(kind) {
  const picks = $$(`.mx-pick[data-mx-kind="${kind}"]:checked`).map((c) => ({
    name: c.dataset.mxName,
    sourceId: undefined,
    baseTool: c.dataset.mxBase || undefined,
    scope: c.dataset.mxScope || undefined, // (과제4) 행별 scope — /sync/apply에 그대로 전달.
  }));
  const prog = $('#' + kind + '-mx-progress');
  const out = $('#' + kind + '-mx-batch-result');
  if (!picks.length) { if (prog) prog.textContent = '선택된 항목이 없습니다.'; if (out) out.innerHTML = ''; return; }
  const btn = $('#' + kind + '-mx-batch-sync');
  if (btn) btn.disabled = true;
  const results = [];
  let done = 0, ok = 0, same = 0, fail = 0;
  for (const p of picks) {
    if (prog) prog.textContent = `${done + 1}/${picks.length} 처리 중…`;
    try {
      const res = await fetch('/sync/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, name: p.name, baseTool: p.baseTool, sourceId: p.sourceId, scope: p.scope }),
      });
      if (!res.ok) {
        fail++;
        results.push({ name: p.name, status: 'error', msg: await errMsg(res) });
      } else {
        const r = await res.json();
        if (r.error) { fail++; results.push({ name: p.name, status: 'error', msg: r.error }); }
        else {
          const pushed = (r.results || []).filter((x) => x.action === 'pushed').length;
          const sk = (r.results || []).filter((x) => x.action === 'skipped_same').length;
          const errs = (r.results || []).filter((x) => x.action === 'error').length;
          if (errs) fail++; else ok++;
          if (pushed === 0 && sk > 0 && errs === 0) { same++; }
          results.push({ name: p.name, status: errs ? 'partial' : 'ok', msg: `내보냄 ${pushed} · 동일 ${sk}${errs ? ` · 오류 ${errs}` : ''}` });
        }
      }
    } catch (e) {
      fail++;
      results.push({ name: p.name, status: 'error', msg: e.message });
    }
    done++;
  }
  if (btn) btn.disabled = false;
  if (prog) prog.textContent = `완료 ${done}/${picks.length}`;
  renderBatchResult(out, results, { ok, same, fail });
  toast(`동기화 ${ok}건 · 실패 ${fail}건`);
  // 목록 새로고침(상태 변화 반영).
  if (kind === 'skill' && loaded.skills) loadSkillOverview();
  if (kind === 'agent' && loaded.agents) loadAgentOverview();
}

function renderBatchResult(out, results, sum) {
  if (!out) return;
  const badgeFor = (s) => s === 'ok' ? '<span class="badge ok">완료</span>'
    : s === 'partial' ? '<span class="badge warn">일부 오류</span>'
      : '<span class="badge error">실패</span>';
  const rows = results.map((r) => `<div class="sync-result-row"><span class="tool-name">${esc(r.name)}</span>${badgeFor(r.status)}<span class="srr-detail">${esc(r.msg)}</span></div>`).join('');
  out.innerHTML = `<div class="batch-result">
    <div class="sync-base-label" style="margin-top:12px">배치 동기화 결과 — 적용 ${sum.ok} · 이미 동일 ${sum.same} · 실패 ${sum.fail}</div>
    ${rows}
  </div>`;
}

// 전체 선택 체크박스 토글 → 현재 렌더된 매트릭스 행의 체크박스 on/off (+행 하이라이트 .sel 연동).
function toggleBatchAll(kind, checked) {
  $$(`.mx-pick[data-mx-kind="${kind}"]`).forEach((c) => {
    c.checked = checked;
    const tr = c.closest('tr');
    if (tr) tr.classList.toggle('sel', checked);
  });
}

// ===================== 프로젝트 관리(T3) =====================
async function openProjectsModal() {
  $('#projects-modal').hidden = false;
  $('#projects-hint').textContent = '';
  await renderProjectsList();
}

async function renderProjectsList() {
  $('#projects-body').innerHTML = '<div class="skel">불러오는 중…</div>';
  let d;
  try { d = await api('/projects'); }
  catch { showLoadError('#projects-body', renderProjectsList); return; }
  const projectsArr = d.projects || [];
  const missing = projectsArr.filter((p) => p.exists === false);
  const list = projectsArr.map((p) => {
    const gone = p.exists === false;
    return `
    <div class="proj-row${gone ? ' proj-missing' : ''}">
      <div class="proj-main">
        <div class="proj-path">${esc(p.root)}${gone ? ' <span class="badge warn"><span class="bdot"></span>없음</span>' : ''}</div>
        <div class="proj-markers">${gone ? '이 경로가 더 이상 존재하지 않습니다' : esc((p.markers || []).join(' · ') || '—')}${p.source ? ` · ${esc(p.source)}` : ''}</div>
      </div>
      <button class="btn btn-ghost btn-sm" data-proj-remove="${esc(p.root)}">해제</button>
    </div>`;
  }).join('') || '<div class="empty-state" style="padding:24px">등록된 프로젝트 없음.</div>';

  // 없는 프로젝트가 있으면 한 번에 정리하는 버튼을 노출한다(있을 때만).
  const pruneBtn = missing.length
    ? `<button class="btn btn-ghost btn-sm" data-proj-prune="1">없는 프로젝트 ${missing.length}개 정리</button>`
    : '';

  $('#projects-body').innerHTML =
    `<div class="proj-section">
       <div class="inline-acts">
         <button class="btn btn-secondary btn-sm" data-proj-rescan="1">다시 찾기</button>
         ${pruneBtn}
         <button class="btn btn-ghost btn-sm" data-proj-reset="1">🗑️ 초기화</button>
       </div>
       <div class="muted" style="margin-top:6px;font-size:12px">다시 찾기는 새 프로젝트만 찾아 병합합니다. 정리는 사라진 폴더만 목록에서 지웁니다. 초기화는 목록을 비우고 처음부터 다시 찾습니다.</div>
       <div id="proj-reset-out"></div>
     </div>
     <div class="proj-section">
       <div class="sub-label">등록된 프로젝트</div>
       ${list}
     </div>
     <div class="proj-section">
       <div class="sub-label">후보 검토 / 직접 추가</div>
       <div class="inline-acts">
         <button class="btn btn-ghost btn-sm" data-proj-scan="1">후보 훑어보기</button>
       </div>
       <div class="proj-add-row">
         <input id="proj-add-path" class="pg-input" placeholder="직접 추가할 프로젝트 경로" />
         <button class="btn btn-primary btn-sm" data-proj-add="1">직접 추가</button>
       </div>
       <div id="proj-scan-out"></div>
     </div>`;
}

// (과제4) [다시 찾기] — 기존 스캔+adopt 재사용. 스캔 후 미등록 후보만 한 번에 등록(신규만 병합).
async function projRescan() {
  const out = $('#proj-reset-out');
  if (out) out.innerHTML = '<div class="skel" style="padding:12px">다시 찾는 중…</div>';
  let d;
  try { d = await api('/projects/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); }
  catch (e) { if (out) out.innerHTML = `<div class="muted" style="padding:10px;font-size:12px">다시 찾지 못했습니다: ${esc(e.message)}</div>`; return; }
  const cands = (d.candidates || []).filter((c) => !c.registered);
  if (!cands.length) {
    if (out) out.innerHTML = '';
    toast('새로 찾은 프로젝트가 없습니다');
    return;
  }
  try {
    await api('/projects/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates: cands.map((c) => ({ root: c.root, markers: c.markers || [] })) }) });
  } catch (e) { if (out) out.innerHTML = `<div class="muted" style="padding:10px;font-size:12px">등록하지 못했습니다: ${esc(e.message)}</div>`; return; }
  if (out) out.innerHTML = '';
  toast(`${cands.length}개 프로젝트를 새로 찾았습니다`);
  await renderProjectsList();
  refreshAfterProjectChange();
}

// (과제4) [초기화] — confirm 1회 → POST /projects/reset(레지스트리 비우고 재스캔+전체 등록).
//  완료 후 매트릭스를 강제 새로고침(force)해 새 등록 결과를 반영한다.
async function projReset() {
  if (!confirm('프로젝트 목록을 지우고 처음부터 다시 찾습니다. 계속할까요?')) return;
  const out = $('#proj-reset-out');
  if (out) out.innerHTML = '<div class="skel" style="padding:12px">초기화하는 중…</div>';
  let r;
  try { r = await api('/projects/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); }
  catch (e) { if (out) out.innerHTML = `<div class="muted" style="padding:10px;font-size:12px">초기화하지 못했습니다: ${esc(e.message)}</div>`; return; }
  if (out) out.innerHTML = '';
  toast(`${(r && r.adopted) || 0}개 프로젝트를 다시 찾았습니다`);
  await renderProjectsList();
  // 매트릭스는 force 새로고침(레지스트리가 통째로 바뀜) — 열려 있는 뷰 즉시 반영.
  if (loaded.skills) loadSkillOverview(true);
  if (loaded.agents) loadAgentOverview(true);
}

// 없는 프로젝트 정리 — POST /projects/prune(root 미존재 항목만 제거). 목록·매트릭스 갱신.
async function projPrune() {
  const out = $('#proj-reset-out');
  if (out) out.innerHTML = '<div class="skel" style="padding:12px">정리하는 중…</div>';
  let r;
  try { r = await api('/projects/prune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); }
  catch (e) { if (out) out.innerHTML = `<div class="muted" style="padding:10px;font-size:12px">정리하지 못했습니다: ${esc(e.message)}</div>`; return; }
  if (out) out.innerHTML = '';
  const n = (r && r.removed && r.removed.length) || 0;
  toast(n ? `없는 프로젝트 ${n}개를 정리했습니다` : '정리할 프로젝트가 없습니다');
  await renderProjectsList();
  // 레지스트리가 줄었으므로 매트릭스도 force 새로고침(열려 있는 뷰 즉시 반영).
  if (n) refreshAfterProjectChange();
}

async function projScan() {
  const out = $('#proj-scan-out');
  out.innerHTML = '<div class="skel" style="padding:14px">스캔 중…</div>';
  // 버튼 클릭 시에만 호출(자동 호출 금지). root 미지정 → 서버가 모드별 기본 루트.
  let d;
  try { d = await api('/projects/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }); }
  catch (e) { out.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">스캔하지 못했습니다: ${esc(e.message)}</div>`; return; }
  const cands = d.candidates || [];
  if (!cands.length) { out.innerHTML = `<div class="muted" style="padding:12px;font-size:12px">후보 없음 (${esc(d.root || '')})</div>`; return; }
  out.innerHTML = `<div class="sub-label" style="margin-top:14px">후보 (${esc(d.root || '')})</div>` + cands.map((c) => `
    <div class="proj-row">
      <div class="proj-main">
        <div class="proj-path">${esc(c.root)}</div>
        <div class="proj-markers">${esc((c.markers || []).join(' · ') || '—')}</div>
      </div>
      ${c.registered ? '<span class="badge muted">등록됨</span>' : `<button class="btn btn-primary btn-sm" data-proj-adopt="${esc(c.root)}">등록</button>`}
    </div>`).join('');
}

async function projAdopt(root) {
  const cand = { root, markers: [] };
  try { await api('/projects/adopt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidates: [cand] }) }); }
  catch (e) { toast('등록하지 못했습니다: ' + e.message); return; }
  toast('프로젝트 등록됨');
  await renderProjectsList();
  refreshAfterProjectChange();
}

async function projAdd() {
  const root = ($('#proj-add-path').value || '').trim();
  if (!root) { $('#projects-hint').textContent = '경로를 입력하세요.'; return; }
  let r;
  try { r = await api('/projects/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) }); }
  catch (e) { $('#projects-hint').textContent = e.message; return; }
  if (r.error) { $('#projects-hint').textContent = r.error; return; }
  if (r.added === false) { toast(`추가 안 됨: ${r.reason || ''}`); }
  else toast('프로젝트 추가됨');
  await renderProjectsList();
  refreshAfterProjectChange();
}

async function projRemove(root) {
  try { await api('/projects/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) }); }
  catch (e) { toast('해제하지 못했습니다: ' + e.message); return; }
  toast('프로젝트 해제됨');
  await renderProjectsList();
  refreshAfterProjectChange();
}

// 등록/해제 후 스킬·에이전트 목록 새로고침(열려 있으면).
function refreshAfterProjectChange() {
  if (loaded.skills) loadSkillOverview();
  if (loaded.agents) loadAgentOverview();
}

// ===================== 스킬 본문 뷰어 (중앙 모달 · 과제3·4) =====================
// 스킬 (scope,name)의 모델별 파일 본문을 화면 중앙 모달로 보여준다(전체화면 아님).
//  · 단일(1곳만)/동일(2곳 동일): 단일 본문 <pre>(읽기 전용, 내부 스크롤). 모달 폭 min(900px,92vw).
//  · 어긋남(2곳 다름): 좌우 diff(renderSideBySide) + 기준 선택 → 스킬 동기화 흐름. 모달 폭 min(1300px,94vw).
//  · 헤더: 이름 + 경로(말줄임)+[경로 복사] + [닫기]. ESC·바깥 클릭으로 닫기. 로딩·실패 재시도.
let viewerCtx = null; // {kind, name, scope, tool, tools, path} — 현재 뷰어 상태(경로 복사).

// 매트릭스 데이터에서 (kind,name)의 scope를 찾는다. 없으면 'global'.
function mxScopeOf(kind, name) {
  const rows = (mxState[kind] && mxState[kind].data && mxState[kind].data.rows) || [];
  const row = rows.find((r) => r.name === name);
  return (row && row.scope) || 'global';
}

// 뷰어 열기: (kind, name, scope) — 다른 패널이 열려 있으면 닫고 중앙 모달을 연다.
function openContentViewer(kind, name, scope, tool) {
  closePanel();
  viewerCtx = { kind, name, scope: scope || 'global', tool: tool || null, tools: [], path: '' };
  $('#viewer-title').textContent = name;
  $('#viewer-path').textContent = '';
  $('#viewer-path').title = '';
  $('#viewer-copy').hidden = true;
  $('#viewer-tabs').innerHTML = '';
  $('#viewer-modal').classList.remove('viewer-modal-wide'); // drift일 때만 넓힘.
  $('#content-viewer').hidden = false;
  loadViewerContent();
}

// 현재 viewerCtx로 /item/content 조회 후 렌더. (PI 게이트 제거 — 409 PI 경로 없음.)
async function loadViewerContent() {
  if (!viewerCtx) return;
  const { kind, name, scope, tool } = viewerCtx;
  $('#viewer-body').innerHTML = '<div class="skel">불러오는 중…</div>';
  const qs = '/item/content?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name)
    + '&scope=' + encodeURIComponent(scope)
    + (tool ? '&tool=' + encodeURIComponent(tool) : '');
  const res = await fetch(qs);
  if (!res.ok) {
    const msg = await errMsg(res);
    $('#viewer-body').innerHTML =
      `<div class="empty-state">이슈가 생겼습니다 — ${esc(msg)}
        <span class="inline-acts" style="justify-content:center;margin-top:10px">
          <button class="btn btn-secondary btn-sm" id="viewer-retry">다시 시도</button>
        </span></div>`;
    const rb = $('#viewer-retry');
    if (rb) rb.addEventListener('click', () => loadViewerContent());
    return;
  }
  const d = await res.json();
  viewerCtx.tools = d.tools || [];
  viewerCtx.tool = d.tool; // 실제로 읽은 도구로 확정.
  renderViewer(d);
}

// (과제4) 스킬 내용 뷰어 렌더:
//  · 존재 도구 1개(single) 또는 2개인데 동일(sideBySide=null): 단일 본문 한 화면(탭 불필요).
//  · 2개인데 다름(sideBySide 있음): 좌우 diff(renderSideBySide) + 기준 선택 → 스킬 동기화 흐름.
function renderViewer(d) {
  $('#viewer-title').textContent = viewerCtx.name;
  $('#viewer-tabs').innerHTML = '';
  const contents = d.contents || {};
  const present = (d.tools || []).filter((tl) => contents[tl]);

  // drift: 좌우 diff + 기준 선택(claude=왼쪽, codex=오른쪽). 모달을 넓게(diff 폭 확보).
  if (d.sideBySide) {
    $('#viewer-modal').classList.add('viewer-modal-wide');
    $('#viewer-path').textContent = '두 모델 내용이 다릅니다';
    $('#viewer-path').title = '';
    $('#viewer-copy').hidden = true; // 경로가 둘이라 헤더 복사 버튼은 숨김(diff 헤더에 각 경로 표시).
    viewerCtx.path = '';
    const cl = contents.claude || {}, cx = contents.codex || {};
    $('#viewer-body').innerHTML = renderSideBySide(d.sideBySide, {
      leftLabel: 'claude', rightLabel: 'codex',
      leftTool: 'claude', rightTool: 'codex',
      leftPath: (cl.path || '').split('/').slice(-2).join('/'),
      rightPath: (cx.path || '').split('/').slice(-2).join('/'),
      onPickBase: true, // 기준 선택 → data-sxs-base → openSyncModal('skill', name, tool)
    });
    return;
  }

  // single 또는 synced: 단일 본문. present가 2개(동일)면 그 사실을 은은히 안내. 경로+복사 버튼 노출.
  $('#viewer-modal').classList.remove('viewer-modal-wide');
  const same2 = present.length === 2; // sideBySide=null인데 둘 다 존재 = 동일.
  const path = d.path || '';
  viewerCtx.path = path;
  $('#viewer-path').textContent = path;
  $('#viewer-path').title = path;
  $('#viewer-copy').hidden = !path;
  const note = same2
    ? `<div class="loss-banner ok" style="margin:0 0 12px"><span class="lb-ic">✓</span><div class="lb-txt">두 모델의 내용이 <b>같습니다</b>.</div></div>`
    : '';
  $('#viewer-body').innerHTML = note + `<pre class="viewer-pre">${esc(d.body || '')}</pre>`;
}

function closeContentViewer() {
  $('#content-viewer').hidden = true;
  $('#viewer-modal').classList.remove('viewer-modal-wide');
  viewerCtx = null;
}

// ===================== 이벤트 위임 =====================
function getView() { const el = $('.nav-item.active, .topnav-tab.active'); return el ? el.dataset.view : 'overview'; }

document.addEventListener('click', (e) => {
  const t = e.target;
  // 사이드바(.nav-item)와 상단 가로 메뉴(.topnav-tab)가 같은 data-view 액션을 공유한다.
  const nav = t.closest('.nav-item, .topnav-tab');
  if (nav) { showView(nav.dataset.view); return; }
  // (v2) 개요 배너·상태 행·스탯 카드 → 스킬 뷰 + 상태 필터 지정.
  const gotoFilter = t.closest('[data-goto-skills-filter]');
  if (gotoFilter) { gotoSkillsFilter(gotoFilter.dataset.gotoSkillsFilter); return; }
  const goto = t.closest('[data-goto]');
  if (goto) { showView(goto.dataset.goto); return; }

  // (v2) 사용량 정렬 토글(최근 사용 순 / 사용량 순).
  const usort = t.closest('[data-usage-sort]');
  if (usort) { usageSort = usort.dataset.usageSort; renderUsage(); return; }

  // 공용 패널/모달
  if (t.id === 'panel-close' || t.id === 'panel-cancel' || t.id === 'scrim') return closePanel();
  if (t.id === 'sidebar-toggle') return toggleSidebar();
  // (v2) 접힌 레일에서 AAD 로고 클릭 → 펼치기(접힘 상태에서만).
  if (t.id === 'sidebar-expand' && document.querySelector('.app').classList.contains('sidebar-collapsed')) return toggleSidebar();
  if (t.id === 'refresh') { ensureLoaded(getView(), true); return; }

  // 지시문 — 다시 시도(비교 전용, 동기화 버튼 없음).
  if (t.dataset.instrRetry != null) return loadInstructions();

  // 좌우 diff의 기준 선택 버튼(data-sxs-base) — 스킬 뷰어(모달)에서만 노출된다(지시문은 onPickBase 미사용).
  //  · 스킬 모달 뷰어가 열려 있으면 → 스킬 동기화 모달(openSyncModal). 스킬 sync 흐름 유지.
  const sxsBase = t.closest('[data-sxs-base]');
  if (sxsBase) {
    const tool = sxsBase.dataset.sxsBase;
    if (viewerCtx && viewerCtx.kind === 'skill') {
      // (과제4) 뷰어가 아는 scope를 그대로 sync 모달에 넘긴다(그 폴더 기준으로 plan/apply).
      return openSyncModal('skill', viewerCtx.name, tool, viewerCtx.scope);
    }
    return;
  }

  // 동기화(Sync) — 매트릭스 행의 [동기화] 버튼. (과제4) 행 scope도 함께 전달.
  const syncOpenBtn = t.closest('[data-sync-open]');
  if (syncOpenBtn) return openSyncModal(syncOpenBtn.dataset.syncOpen, syncOpenBtn.dataset.syncName, syncOpenBtn.dataset.syncSource, syncOpenBtn.dataset.syncScope);
  if (t.id === 'sync-cancel') return closeSyncModal();
  if (t.id === 'sync-run') return runSync();
  // 배치 동기화 — 매트릭스 [선택 항목 동기화] 버튼(스킬/에이전트).
  if (t.id === 'skill-mx-batch-sync') return runBatchSync('skill');
  if (t.id === 'agent-mx-batch-sync') return runBatchSync('agent');
  const syncBaseRow = t.closest('[data-sync-base]');
  if (syncBaseRow) return selectSyncBase(syncBaseRow.dataset.syncBase);

  // (과제4) 폴더 경로 복사 📋 버튼 — 폴더 선택(data-folder)보다 먼저 분기해 선택 클릭과 분리한다.
  const folderCopyBtn = t.closest('[data-folder-copy]');
  if (folderCopyBtn) { e.stopPropagation(); return copyFolderPath(folderCopyBtn.dataset.folderCopy, folderCopyBtn.dataset.copyKind); }

  // F4/F5: 좌측 폴더 리스트 클릭 → 우측 표를 그 폴더로 좁힌다([전체]는 data-folder="").
  // data-folder-kind로 skill/agent를 구분(둘 다 마스터-디테일).
  const folderBtn = t.closest('[data-folder]');
  if (folderBtn) return selectFolder(folderBtn.dataset.folderKind || 'skill', folderBtn.dataset.folder);

  // F5: 에이전트 상세의 "참조 스킬" 링크 → 스킬 뷰로 이동 + 이름 검색.
  const refSkill = t.closest('[data-ref-skill]');
  if (refSkill) return gotoSkillSearch(refSkill.dataset.refSkill);

  // (과제3) 이름 클릭 → 중앙 본문 뷰어(행 클릭도 아래에서 같은 뷰어를 연다).
  const viewLink = t.closest('[data-view-content]');
  if (viewLink) { e.stopPropagation(); return openContentViewer(viewLink.dataset.viewContent, viewLink.dataset.viewName, viewLink.dataset.viewScope); }
  // 중앙 뷰어 — 닫기 / 경로 복사 / 바깥(scrim) 클릭 닫기.
  if (t.id === 'viewer-close') return closeContentViewer();
  if (t.id === 'viewer-copy') {
    if (viewerCtx && viewerCtx.path) {
      const p = viewerCtx.path;
      copyToClipboard(p).then((ok) => toast(ok ? `경로를 복사했습니다: ${p}` : `복사하지 못했습니다 — 경로: ${p}`));
    }
    return;
  }
  if (t.id === 'content-viewer') return closeContentViewer(); // scrim 바깥 클릭.
  // 상세 슬라이드오버(에이전트) 안의 [내용 보기] 버튼(같은 뷰어). 스킬은 슬라이드오버 제거.
  if (t.dataset.viewOpen != null) return openContentViewer(t.dataset.viewOpen, t.dataset.viewName, t.dataset.viewScope);

  // 동기화 매트릭스(D27, UX-E2) — data-mx-* 접두사.
  if (t.dataset.mxFilter != null) { const [k, key] = t.dataset.mxFilter.split(':'); return applyMxFilter(k, key); }
  if (t.dataset.mxMore != null) return mxMore(t.dataset.mxMore);
  // 행 클릭 → 본문 뷰어(이름 클릭과 동일한 중앙 모달). 체크박스·[동기화] 버튼·이름 링크 클릭은 제외.
  // (과제3) 스킬 슬라이드오버(openSkillDetail) 제거 — 행 클릭도 중앙 모달을 연다. 에이전트 뷰는 숨김 상태.
  const mxRow = t.closest('[data-mx-row]');
  if (mxRow && !t.closest('.mx-pick') && !t.closest('[data-sync-open]') && !t.closest('[data-view-content]')) {
    const name = mxRow.dataset.mxName;
    const kind = mxRow.dataset.mxRow;
    return openContentViewer(kind, name, mxRow.dataset.mxScope);
  }

  // 프로젝트 관리(T3)
  if (t.dataset.openProjects != null) return openProjectsModal();
  if (t.id === 'projects-close-btn') { $('#projects-modal').hidden = true; return; }
  if (t.dataset.projRescan != null) return projRescan();
  if (t.dataset.projPrune != null) return projPrune();
  if (t.dataset.projReset != null) return projReset();
  if (t.dataset.projScan != null) return projScan();
  if (t.dataset.projAdd != null) return projAdd();
  if (t.dataset.projAdopt != null) return projAdopt(t.dataset.projAdopt);
  if (t.dataset.projRemove != null) return projRemove(t.dataset.projRemove);

  // 스킬
  if (t.dataset.skillPullName != null) return doSkillPull(t.dataset.skillPullName, t.dataset.skillPullSource);
  if (t.dataset.skillApplyAll != null) return doSkillApplyAll(t.dataset.skillApplyAll); // #1 세 도구에 적용
  if (t.dataset.skillApply != null) return doSkillApply(t.dataset.skillApply, t.dataset.skillApplyTo);
  if (t.dataset.skillDiffName != null) return doSkillDiff(t.dataset.skillDiffName, t.dataset.skillDiffTo);

  // 에이전트 (상세 슬라이드오버 안의 버튼 배선 — 목록은 매트릭스가 담당)
  if (t.dataset.agentPullFrom != null) return doAgentPull(t.dataset.agentPullFrom, t.dataset.agentPullName);
  if (t.dataset.agentApplyAll != null) return doAgentApplyAll(t.dataset.agentApplyAll); // #1 세 도구에 적용
  if (t.dataset.agentApply != null) return doAgentApply(t.dataset.agentApply, t.dataset.agentApplyTo);
  if (t.dataset.agentDiffId != null) return doAgentDiff(t.dataset.agentDiffId, t.dataset.agentDiffTo);

  // 태그
  if (t.dataset.tagFilter != null) return applyTagFilter(t.dataset.tagFilter);
  if (t.dataset.tagKind != null) return setTagsFor(t.dataset.tagKind, t.dataset.tagId);

  // 스토어
  if (t.dataset.storeItem != null) return openStoreDetail(t.dataset.storeItem);
  // #2: 카드/드릴다운의 [미리보기 · 적용]은 직접 적용 대신 미리보기 슬라이드오버를 연다("세 도구에 적용" 경유).
  if (t.dataset.storePreview != null) return openStoreDetail(t.dataset.storePreview);
  // 미리보기 패널 안의 "세 도구에 적용" 버튼(data-store-apply)만 실제 적용을 수행한다.
  if (t.dataset.storeApply != null) return doStoreApply(t.dataset.storeApply);
  // #5: 스토어 빈 상태의 [필터 해제] — 활성 태그와 검색어를 모두 비운다.
  if (t.dataset.storeClearFilter != null) {
    activeTags.clear();
    const si = $('#global-search-input'); if (si) si.value = '';
    loadTags();
    loadStore('');
    return;
  }

  // 스토어 퍼블리셔(SKC2) — data-pub-* 접두사 분기
  // F6: 수집 배너 [새로고침] — 스토어(+수집 상태) 재조회. 자동 폴링 대신 수동 갱신.
  if (t.dataset.collectRefresh != null) return loadStore($('#global-search-input') ? $('#global-search-input').value : '');
  // F6: [수집] 버튼은 카드(data-pub-open) 밖에 있으므로 먼저 분기(드릴다운 진입 방지).
  if (t.dataset.pubCollect != null) return collectRepo(t.dataset.pubCollect);
  const pubCard = t.closest('[data-pub-open]');
  if (pubCard) return openPublisherDrilldown(pubCard.dataset.pubOpen);
  if (t.dataset.pubBack != null) return closePublisherDrilldown();
  if (t.dataset.pubCat != null) return applyCategoryFilter(t.dataset.pubCat);

  // 레지스트리(스토어-R2) — data-reg-* 접두사 분기
  if (t.dataset.regOpen != null) return openRegistriesModal();
  if (t.id === 'registries-close-btn') { $('#registries-modal').hidden = true; return; }
  if (t.dataset.regAdd != null) return regAdd();
  if (t.dataset.regRemove != null) return regRemove(t.dataset.regRemove);
  if (t.dataset.regRefresh != null) return regRefresh(t.dataset.regRefresh);
  if (t.dataset.regUpdates != null) return regCheckUpdates();

  // 플레이그라운드
  if (t.id === 'pg-skill-reco-btn') return pgRecommendSkills();
  // #2: 추천표의 [적용]은 미리보기 패널을 거치게 함(pgPreviewSkill → #pg-adopt-btn).
  if (t.dataset.pgSkillPreview != null) return pgPreviewSkill(t.dataset.pgSkillPreview);
  if (t.id === 'pg-role-reco-btn') return pgRecommendForRole();
  if (t.id === 'pg-compose-btn') return pgCompose();
  if (t.id === 'pg-agent-preview-btn') return pgPreviewAgent();
  if (t.id === 'pg-adopt-btn') return pgAdoptCurrent();

  // (백업/복구 UI 제거 — data-backup-* · restore 모달 핸들러 삭제.)
  // (PI 게이트 제거 — pi-cancel·data-ack 핸들러 삭제. 백엔드가 409 PI를 더 이상 내지 않는다.)

  // 충돌 모달
  if (t.id === 'conflict-cancel') { $('#conflict-modal').hidden = true; conflictCtx = null; return; }
  if (t.id === 'conflict-confirm') return confirmConflict();
  const rr = t.closest('#conflict-options .radio-row');
  if (rr) {
    $$('#conflict-options .radio-row').forEach((x) => x.classList.remove('sel'));
    rr.classList.add('sel');
    const radio = rr.querySelector('input');
    if (radio) radio.checked = true;
    $('#conflict-newname').hidden = radio.value !== 'rename';
    return;
  }
});

$('#scrim').addEventListener('click', closePanel);

// 매트릭스 "전체 선택" 체크박스(현재 렌더된 행) + (v2) 개별 체크 시 행 하이라이트(.sel).
document.addEventListener('change', (e) => {
  if (e.target.id === 'skill-mx-all') return toggleBatchAll('skill', e.target.checked);
  if (e.target.id === 'agent-mx-all') return toggleBatchAll('agent', e.target.checked);
  if (e.target.classList && e.target.classList.contains('mx-pick')) {
    const tr = e.target.closest('tr');
    if (tr) tr.classList.toggle('sel', e.target.checked);
  }
});

// 검색 입력 → 즉시 필터(스토어 + 매트릭스 이름 검색).
document.addEventListener('input', (e) => {
  if (e.target.id === 'global-search-input') return loadStore(e.target.value);
  if (e.target.id === 'skill-folder-search') return applyFolderSearch('skill', e.target.value); // F4 폴더 리스트 검색
  if (e.target.id === 'agent-folder-search') return applyFolderSearch('agent', e.target.value); // F5 폴더 리스트 검색
  if (e.target.id === 'skill-mx-search') return applyMxSearch('skill', e.target.value);
  if (e.target.id === 'agent-mx-search') return applyMxSearch('agent', e.target.value);
});

// 해시 변경(뒤로가기 등) → 뷰 동기화
window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'overview'));

// (이슈5) ESC → 전체화면 본문 뷰어 닫기(열려 있을 때만).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#content-viewer').hidden) closeContentViewer();
});

// ===================== 사이드바 접기/펼치기 (≥1024px) =====================
// 접으면 .app에 .sidebar-collapsed 클래스 → 아이콘만 남는 좁은 사이드바(CSS가 담당).
// 접힘 상태는 localStorage에 기억한다(중간/좁은 화면에서는 상단 탭이라 무관).
function toggleSidebar() {
  const collapsed = document.querySelector('.app').classList.toggle('sidebar-collapsed');
  try { localStorage.setItem('aad-sidebar-collapsed', collapsed ? '1' : ''); } catch { }
}
(function initSidebar() {
  let saved = '';
  try { saved = localStorage.getItem('aad-sidebar-collapsed') || ''; } catch { }
  if (saved === '1') document.querySelector('.app').classList.add('sidebar-collapsed');
})();

// (더미 모드 안내 배너 제거 — D37: 데모/더미 모드 자체가 없어져 항상 실제 파일 기준.)

// ===================== 초기 로드 =====================
initNavCounts(); // (이슈1) 배지 4개를 "…"로 띄우고 백그라운드로 개수 채움(matrix는 캐시 공유).
showView(location.hash.slice(1) || 'overview'); // 기본 overview, 새로고침 시 해시 복원
