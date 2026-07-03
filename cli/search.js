'use strict';
// 항목 목록을 검색어로 "점수 기반 랭킹"하는 공용 모듈.
// 스토어 목록·플레이그라운드 추천·사용량 목록 정렬에 함께 쓴다.
// 순수 JS, 외부 의존성 없음. 대소문자 정규화도 자체 구현(toLowerCase 사용).

// 점수 티어(높을수록 우선). 가장 높은 티어 "하나"만 점수로 쓰고 합산하지 않는다.
const TIER = {
  NAME_EXACT: 100, // 이름 정확일치
  NAME_PREFIX: 80, // 이름 prefix
  NAME_CONTAINS: 60, // 이름 부분일치
  TAG_EXACT: 55, // 태그 정확일치(태그가 있을 때만)
  DESC_PREFIX: 40, // 설명 prefix
  DESC_CONTAINS: 30, // 설명 부분일치
  BODY_CONTAINS: 10, // 본문 부분일치
  NONE: 0, // 그 외
};

// 검색 비교용으로 문자열을 정규화한다(대소문자 무시 + 앞뒤 공백 제거).
// 문자열이 아니거나 비어 있으면 빈 문자열을 돌려준다.
function normalize(value) {
  if (typeof value !== 'string') return '';
  return value.toLowerCase().trim();
}

// item을 query로 채점한다.
// item: { name, description, body?, tags? } — 없는 필드는 무시.
// query: 문자열. 대소문자 무시. 반환: number(가장 높은 티어 하나).
function scoreItem(item, query) {
  const q = normalize(query);
  // 검색어가 비어 있으면 점수를 매길 수 없다.
  if (!q || !item || typeof item !== 'object') return TIER.NONE;

  const name = normalize(item.name);
  const description = normalize(item.description);
  const body = normalize(item.body);

  // 이름 티어: 정확일치 > prefix > 부분일치 순으로 확인.
  if (name) {
    if (name === q) return TIER.NAME_EXACT;
    if (name.startsWith(q)) return TIER.NAME_PREFIX;
    if (name.includes(q)) return TIER.NAME_CONTAINS;
  }

  // 태그 정확일치(태그가 배열로 있을 때만). 하나라도 정확히 맞으면 인정.
  if (Array.isArray(item.tags)) {
    const tagHit = item.tags.some((tag) => normalize(tag) === q);
    if (tagHit) return TIER.TAG_EXACT;
  }

  // 설명 티어: prefix > 부분일치.
  if (description) {
    if (description.startsWith(q)) return TIER.DESC_PREFIX;
    if (description.includes(q)) return TIER.DESC_CONTAINS;
  }

  // 본문 부분일치.
  if (body && body.includes(q)) return TIER.BODY_CONTAINS;

  return TIER.NONE;
}

// items를 query로 점수 매겨 랭킹한 새 배열을 돌려준다.
// 원본 객체는 변형하지 않고 얕은 복사 후 score 필드를 붙인다.
// opts:
//   - keepAll: true면 score가 0인 항목도 남긴다(기본은 score>0만).
//   - sortEmptyByName: true면 query가 비었을 때 이름 오름차순으로 정렬.
function rankItems(items, query, opts = {}) {
  // 입력이 배열이 아니면 빈 배열로 방어.
  if (!Array.isArray(items)) return [];

  const q = normalize(query);

  // 검색어가 비어 있으면(빈 문자열/공백) 채점하지 않는다.
  if (!q) {
    // score는 0으로 채워 형태를 일관되게 유지한다.
    const copied = items.map((item) => ({ ...item, score: TIER.NONE }));
    if (opts.sortEmptyByName) {
      // 이름 오름차순. localeCompare로 자연스러운 정렬(대소문자 무시).
      copied.sort((a, b) =>
        normalize(a.name).localeCompare(normalize(b.name))
      );
    }
    // 기본은 입력 순서 그대로.
    return copied;
  }

  // 각 항목을 채점하면서 원래 입력 순서(index)를 함께 보관한다.
  // index는 동점 처리(안정 정렬)에 쓰고, 결과 객체에는 넣지 않는다.
  const scored = items.map((item, index) => ({
    item,
    index,
    score: scoreItem(item, q),
  }));

  // 기본은 score>0만 남기고, keepAll이면 전부 유지.
  const filtered = opts.keepAll
    ? scored
    : scored.filter((entry) => entry.score > TIER.NONE);

  // 점수 내림차순, 동점이면 입력 순서 유지(안정 정렬 직접 구현).
  filtered.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  // 얕은 복사 + score 부착. 원본 item은 건드리지 않는다.
  return filtered.map((entry) => ({ ...entry.item, score: entry.score }));
}

module.exports = { scoreItem, rankItems };

// 검증용 데모: `node cli/search.js`로 직접 실행할 때만 동작.
if (require.main === module) {
  const items = [
    { name: 'code-review', description: '코드 리뷰 도우미', tags: ['review'] },
    { name: 'code-reviewer', description: 'PR 리뷰', tags: ['review', 'pr'] },
    { name: 'deep-think', description: '심층 사고', tags: ['think'] },
  ];
  console.log(JSON.stringify(rankItems(items, 'review'), null, 2));
}
