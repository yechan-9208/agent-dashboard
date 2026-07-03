'use strict';
// 태그 기반 분류 모듈 (갱신1 — 태그 모델).
//
// 철학: 고정 카테고리가 아니라 "태그 중심"으로 분류한다. PRESET은 추천(자동완성)용
//       프리셋일 뿐 강제 분류가 아니다. 사용자가 만든 커스텀 태그는 canonical 루트의
//       categories.json(배열)에 누적 저장한다.
//
// 정규화 규칙: 소문자화 → 허용문자 [a-z0-9가-힣-]만 남기고 나머지는 태그 경계로 →
//             빈값 제거 → 각 길이 ≤24로 자르기 → 중복 제거 → 최대 12개.
//
// 외부 의존성은 같은 cli/ 안의 paths(경로)·duplicate(jaccard)만 사용한다(둘 다 수정 금지).

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const duplicate = require('./duplicate');

// 추천용 프리셋(고정 분류 아님). 자동완성/제안 상단에 먼저 노출한다.
// 새 카테고리 어휘 12종(정규화 키 기준 — 소문자 ascii + 한글). 자유 태그는 그대로 누적된다.
const PRESET = ['ui', '서버', '앱', 'devops', 'ai', 'db', '보안', '테스트', '문서', '디자인', '코드', '리뷰'];

// 구 태그 → 새 카테고리 매핑(표시·자동분류 공용). 정규화된 키(소문자) 기준으로 조회한다.
// 매핑에 없는 기존 태그는 그대로 통과시킨다(커스텀 태그 보존).
const LEGACY_MAP = {
  code: '코드',
  review: '리뷰',
  docs: '문서', documentation: '문서',
  infra: 'devops', devops: 'devops', deploy: 'devops',
  security: '보안',
  test: '테스트', testing: '테스트',
  design: '디자인',
  ui: 'ui', frontend: 'ui',
  server: '서버', backend: '서버',
  app: '앱',
  ai: 'ai', ml: 'ai', llm: 'ai', 'ai-ml': 'ai',
  db: 'db', database: 'db', sql: 'db',
};

// 태그 하나를 새 카테고리 어휘로 변환(매핑에 없으면 원본 유지). 표시·자동분류가 공유한다.
function mapLegacyTag(tag) {
  const k = String(tag == null ? '' : tag).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEGACY_MAP, k) ? LEGACY_MAP[k] : tag;
}

// 태그 배열을 새 어휘로 변환(매핑 후 중복 제거, 순서 보존).
function mapLegacyTags(tags) {
  const out = [];
  const seen = new Set();
  for (const t of Array.isArray(tags) ? tags : []) {
    const m = mapLegacyTag(t);
    if (m == null || m === '') continue;
    if (seen.has(m)) continue;
    seen.add(m);
    out.push(m);
  }
  return out;
}

// 커스텀 태그를 저장하는 파일 경로 (canonical 루트 안, 모드별 분리는 paths가 처리).
function categoriesFile() {
  return path.join(paths.canonicalRoot(), 'categories.json');
}

// 저장된 커스텀 태그 배열을 읽는다. 없거나 깨졌으면 [] 로 폴백(try/catch).
function loadCustom() {
  try {
    const raw = fs.readFileSync(categoriesFile(), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// 커스텀 태그 배열을 파일에 저장한다. 디렉토리 보장 + 실패해도 던지지 않게 try/catch.
function saveCustom(tags) {
  try {
    fs.mkdirSync(paths.canonicalRoot(), { recursive: true });
    fs.writeFileSync(categoriesFile(), JSON.stringify(tags, null, 2) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

// 입력(문자열: 쉼표/공백 구분, 또는 배열)을 정규화한 태그 배열로 변환한다.
//   - 소문자화
//   - 허용문자 [a-z0-9가-힣-] 외는 태그 경계로 취급(쪼갬)
//   - 빈값 제거, 각 길이 ≤24, 중복 제거, 최대 12개
function normalizeTags(input) {
  let parts;
  if (Array.isArray(input)) {
    parts = input;
  } else if (input == null) {
    parts = [];
  } else {
    parts = [String(input)];
  }

  const out = [];
  const seen = new Set();
  for (const part of parts) {
    // 허용문자 외(공백·쉼표·구두점 등)는 모두 경계로 → 여러 태그로 쪼갠다.
    const pieces = String(part)
      .toLowerCase()
      .split(/[^a-z0-9가-힣-]+/);
    for (let piece of pieces) {
      if (!piece) continue;
      // 경계 하이픈은 다듬는다(태그 중간 하이픈은 유지).
      piece = piece.replace(/^-+/, '').replace(/-+$/, '');
      if (!piece) continue;
      if (piece.length > 24) piece = piece.slice(0, 24);
      if (seen.has(piece)) continue;
      seen.add(piece);
      out.push(piece);
      if (out.length >= 12) return out;
    }
  }
  return out;
}

// 추천 묶음을 만든다.
//   preset : 고정 프리셋
//   custom : 저장된 커스텀 태그
//   all    : preset + custom 합쳐 중복 제거(preset 먼저)
function suggestions() {
  const custom = loadCustom();
  const all = [];
  const seen = new Set();
  for (const t of PRESET.concat(custom)) {
    if (seen.has(t)) continue;
    seen.add(t);
    all.push(t);
  }
  return { preset: PRESET.slice(), custom, all };
}

// 새 태그를 커스텀 목록에 등록한다.
//   - 입력을 normalize
//   - PRESET·기존 커스텀에 이미 있는 건 건너뛰고, 새 것만 append
//   - 저장 후 갱신된 커스텀 배열을 반환
function registerCustom(tags) {
  const incoming = normalizeTags(tags);
  const existing = loadCustom();
  const known = new Set(PRESET.concat(existing));
  let changed = false;
  for (const t of incoming) {
    if (known.has(t)) continue;
    known.add(t);
    existing.push(t);
    changed = true;
  }
  if (changed) saveCustom(existing);
  return existing;
}

// 두 태그 집합의 유사도(0~1). duplicate.jaccard에 위임한다.
function tagMatch(aTags, bTags) {
  return duplicate.jaccard(new Set(normalizeTags(aTags)), new Set(normalizeTags(bTags)));
}

// 태그 배열들의 출현 빈도 집계. [['a','b'],['a']] → { a: 2, b: 1 }
//   (각 항목은 normalize하지 않고 그대로 센다 — 이미 정규화된 태그가 들어온다는 전제)
function tagCounts(listOfTagArrays) {
  const counts = {};
  const list = Array.isArray(listOfTagArrays) ? listOfTagArrays : [];
  for (const arr of list) {
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}

module.exports = {
  PRESET,
  LEGACY_MAP,
  mapLegacyTag,
  mapLegacyTags,
  normalizeTags,
  suggestions,
  registerCustom,
  tagMatch,
  tagCounts,
};

// 부작용 없는 검증 데모 (registerCustom은 파일을 쓰므로 호출하지 않는다).
if (require.main === module) {
  console.log('normalize:', normalizeTags('Code, Review code'));
  console.log('suggestions:', suggestions());
  console.log('match:', tagMatch(['code', 'review'], ['review']));
}
