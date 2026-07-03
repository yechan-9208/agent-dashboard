'use strict';
// 중복/유사 항목 "탐지·제안" 모듈 (Phase 2).
//
// 철학: 대시보드는 절대 자동 병합하지 않는다. 겹치는 항목 쌍을 점수화해서
//       "이 둘이 겹친다"라고 제안만 한다. 실제 통합 여부는 사람이 정한다.
//
// 1차 패스는 LLM 없이 순수 휴리스틱으로 돌린다:
//   - 이름 유사도   : 정규화 후 (문자 Levenshtein 유사도)와 (토큰 Jaccard)의 평균
//   - 텍스트 유사도 : 설명/본문을 소문자·공백 정규화한 뒤 단어 집합 Jaccard
//   - 종합 점수     : 위 둘의 가중합 (기본 이름 0.4 / 텍스트 0.6)
//
// LLM 통합 패스(opts.useLLM)는 훅 자리만 남겨두고 기본 꺼짐 — 실제 호출은 미구현.
//
// 외부 의존성 없음(순수 JS). 입력 item 형태: { id, name, text } (+ 선택적 type).

// ---------- 문자열 정규화 ----------

// 이름 정규화: 소문자화, 영숫자만 남기고 나머지(하이픈/언더스코어/공백)는 공백으로.
//   'code-review' / 'code_review' / 'Code Review' → 'code review'
function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// 본문/설명 정규화: 소문자화 + 공백 정규화. 단어 분해는 호출부에서 한다.
function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// 정규화한 텍스트를 단어 토큰 집합(Set)으로. (구두점은 경계로만 쓰고 버린다)
function tokenSet(s) {
  const norm = normalizeText(s);
  if (!norm) return new Set();
  const tokens = norm
    .split(/[^a-z0-9가-힣]+/)
    .filter((t) => t.length > 0);
  return new Set(tokens);
}

// ---------- 유사도 원시 함수 ----------

// 두 집합의 Jaccard 유사도 = 교집합 / 합집합. (둘 다 비면 0)
function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Levenshtein 편집 거리(삽입/삭제/치환 = 1). 순수 DP, 메모리는 한 행만 유지.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,        // 삭제
        curr[j - 1] + 1,    // 삽입
        prev[j - 1] + cost  // 치환
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

// 편집 거리를 0~1 유사도로 환산: 1 - dist / max(len). (둘 다 빈 문자열이면 1)
function levenshteinSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// ---------- 개별 항목 유사도 ----------

// 이름 유사도: 정규화 문자열의 Levenshtein 유사도와 토큰 Jaccard를 평균.
//   - Levenshtein : 'review' vs 'reviewer' 같은 철자 변형을 잡는다.
//   - 토큰 Jaccard: 'code review tool' vs 'tool for code review' 같은 어순 변형을 잡는다.
function nameSimilarity(nameA, nameB) {
  const na = normalizeName(nameA);
  const nb = normalizeName(nameB);
  const lev = levenshteinSimilarity(na, nb);
  const jac = jaccard(new Set(na.split(' ').filter(Boolean)), new Set(nb.split(' ').filter(Boolean)));
  return (lev + jac) / 2;
}

// 텍스트(설명/본문) 유사도: 단어 집합 Jaccard.
function textSimilarity(textA, textB) {
  return jaccard(tokenSet(textA), tokenSet(textB));
}

// ---------- 한 쌍 점수화 ----------

// 두 항목의 종합 유사도를 계산하고, 사람이 읽을 수 있는 reasons를 만든다.
function scorePair(a, b, weights) {
  const nameScore = nameSimilarity(a.name, b.name);
  const textScore = textSimilarity(a.text, b.text);
  const score = nameScore * weights.name + textScore * weights.text;

  // 왜 닮았다고 봤는지: 임계 넘은 신호만 사람 친화적으로 적는다.
  const reasons = [];
  if (nameScore >= 0.6) {
    reasons.push(`이름 유사 (${nameScore.toFixed(2)}): '${a.name}' ↔ '${b.name}'`);
  }
  if (textScore >= 0.5) {
    reasons.push(`본문/설명 유사 (Jaccard ${textScore.toFixed(2)})`);
  }
  return { nameScore, textScore, score, reasons };
}

// ---------- 메인: 중복 후보 탐지 ----------

// findDuplicates(items, opts)
//   items: [{ id, name, text, type? }, ...]  — canonical에서 모아 넘긴다고 가정.
//   opts:
//     - threshold     : 종합 점수 임계값 (기본 0.5). 이상이면 후보 쌍.
//     - weights       : { name, text } 가중치 (기본 {name:0.4, text:0.6}).
//     - ignoreType    : true면 타입 무시하고 전부 비교 (기본 false = 같은 type끼리만).
//     - useLLM        : LLM 통합 패스 훅 (기본 false, 미구현).
//     - llmRefine(...) : useLLM=true일 때 호출될 사용자 제공 함수 (선택).
//
// 반환: [{ a, b, score, reasons }, ...] — 점수 내림차순. 자동 병합은 하지 않는다(제안만).
function findDuplicates(items, opts = {}) {
  const threshold = opts.threshold != null ? opts.threshold : 0.5;
  const weights = Object.assign({ name: 0.4, text: 0.6 }, opts.weights);
  const ignoreType = opts.ignoreType === true;

  const list = Array.isArray(items) ? items : [];
  const candidates = [];

  // 모든 비순서 쌍 (i < j) 을 비교. 항목 수가 적은 로컬 라이브러리 전제라 O(n^2)면 충분.
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];

      // 기본은 같은 타입끼리만(skill↔skill, agent↔agent). ignoreType면 건너뛴다.
      if (!ignoreType && a.type != null && b.type != null && a.type !== b.type) {
        continue;
      }

      const { score, reasons } = scorePair(a, b, weights);
      if (score >= threshold) {
        candidates.push({ a, b, score, reasons });
      }
    }
  }

  // 점수 높은 순으로 정렬해 제안 인박스 상단이 가장 의심스러운 쌍이 되게 한다.
  candidates.sort((x, y) => y.score - x.score);

  // --- LLM 통합 패스 (옵션, 기본 꺼짐) ---
  // 휴리스틱이 추린 후보를 더 똑똑하게 판정하고 싶을 때만 켠다.
  // 실제 LLM 호출은 여기서 구현하지 않는다. opts.llmRefine(candidates, items)가
  // 주어지면 그 훅에 위임만 한다. (없으면 휴리스틱 결과를 그대로 반환)
  if (opts.useLLM === true && typeof opts.llmRefine === 'function') {
    return opts.llmRefine(candidates, list);
  }

  return candidates;
}

module.exports = {
  findDuplicates,
  // 단위 테스트/재사용을 위해 내부 유사도 함수도 노출.
  nameSimilarity,
  textSimilarity,
  scorePair,
  normalizeName,
  normalizeText,
  tokenSet,
  jaccard,
  levenshtein,
  levenshteinSimilarity,
};
