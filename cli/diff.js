'use strict';
// 간단한 LCS(최장 공통 부분수열) 기반 라인 diff. 외부 의존성 없이, 가독성 우선.
// canonical 본문과 배포본 본문을 줄 단위로 비교해 +/-/(공백)으로 표시한다.

function lineDiff(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  const m = a.length;
  const n = b.length;

  // dp[i][j] = a[i..], b[j..]의 LCS 길이
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ type: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: '-', line: a[i] }); // 배포본에서 사라질 줄
      i++;
    } else {
      out.push({ type: '+', line: b[j] }); // 새로 들어갈 줄
      j++;
    }
  }
  while (i < m) out.push({ type: '-', line: a[i++] });
  while (j < n) out.push({ type: '+', line: b[j++] });
  return out;
}

function hasChanges(diff) {
  return diff.some((d) => d.type !== ' ');
}

// 터미널/엔드포인트 출력용 텍스트 ("+ ...", "- ...", "  ...")
function render(diff) {
  return diff.map((d) => `${d.type} ${d.line}`).join('\n');
}

// lineDiff 결과를 hunk 단위로 그룹화한다.
// 변경(+/-) 주변 context줄의 미변경( )만 남기고, 그보다 긴 미변경 구간은 접는다.
// 반환: [{ lines: [{type,line}], hiddenBefore: number }]
//   - lines       : 이 hunk에 포함되는 줄들(변경줄 + 양옆 문맥줄)
//   - hiddenBefore : 이 hunk 앞에서 접혀 생략된 미변경 줄 수
//                    (첫 hunk면 파일 맨 앞에서 생략된 줄 수)
// 동작 메모:
//   - 변경이 전혀 없으면 빈 배열([])을 반환한다(접을 hunk가 없으므로).
//   - 마지막 hunk 뒤에 남는 미변경 구간(꼬리)은 표시 대상이 아니므로 무시한다
//     (어느 hunk에도 hiddenAfter로 싣지 않는다 — renderHunked도 꼬리는 그리지 않음).
function hunks(diff, context = 3) {
  // 변경이 없으면 hunk도 없다.
  if (!hasChanges(diff)) return [];

  // 1) 각 줄을 hunk에 "포함할지" 마킹한다.
  //    - 변경줄(+/-)은 무조건 포함.
  //    - 변경줄에서 앞뒤로 context 거리 이내의 미변경줄도 포함(문맥).
  const keep = new Array(diff.length).fill(false);
  for (let idx = 0; idx < diff.length; idx++) {
    if (diff[idx].type === ' ') continue;
    const from = Math.max(0, idx - context);
    const to = Math.min(diff.length - 1, idx + context);
    for (let k = from; k <= to; k++) keep[k] = true;
  }

  // 2) keep 구간을 이어붙여 hunk로 묶고, 그 사이 접힌 미변경 줄 수를 센다.
  const result = [];
  let hiddenRun = 0; // 직전 hunk 이후(또는 파일 시작 이후) 접힌 미변경 줄 수 누적
  let current = null; // 현재 만들고 있는 hunk

  for (let idx = 0; idx < diff.length; idx++) {
    if (keep[idx]) {
      if (!current) {
        // 새 hunk 시작 — 지금까지 접힌 줄 수를 hiddenBefore로 싣는다.
        current = { lines: [], hiddenBefore: hiddenRun };
        result.push(current);
        hiddenRun = 0;
      }
      current.lines.push(diff[idx]);
    } else {
      // keep 안 되는 줄은 정의상 미변경줄이므로 접힘으로 카운트.
      hiddenRun++;
      current = null; // hunk 경계
    }
  }

  // 꼬리(hiddenRun > 0)는 위 동작 메모대로 무시한다.
  return result;
}

// hunk 렌더러(텍스트). hunk 내부는 render와 동일한 "+ /- /  " 접두사,
// hunk 사이의 접힌 구간은 "  ⋯ (N줄 변경 없음)" 구분선으로 표시한다.
function renderHunked(diff, context = 3) {
  const hs = hunks(diff, context);
  const parts = [];
  for (const h of hs) {
    if (h.hiddenBefore > 0) {
      parts.push(`  ⋯ (${h.hiddenBefore}줄 변경 없음)`);
    }
    for (const d of h.lines) {
      parts.push(`${d.type} ${d.line}`);
    }
  }
  return parts.join('\n');
}

// lineDiff 결과를 좌우 2열 정렬 행 배열로 변환한다(프런트의 side-by-side 뷰용).
// 반환 행: { type:'same'|'change'|'left'|'right', left:{n,line}, right:{n,line} }
//   - 'same'  : 양쪽 동일한 줄(줄번호는 각 파일 기준 각각 부여).
//   - 'change': 연속 '-'(왼쪽만) 블록과 '+'(오른쪽만) 블록을 행 단위로 짝지음(removed[i]↔added[i]).
//   - 'left'  : 왼쪽에만 남는 줄(오른쪽은 filler: n=null,line=null).
//   - 'right' : 오른쪽에만 남는 줄(왼쪽은 filler: n=null,line=null).
// 줄번호(n)는 각 파일 기준 1부터. filler 쪽은 n=null,line=null.
// 순수 함수(디스크·네트워크 없음). intra-line(문자 단위) 하이라이트는 프런트 담당.
function sideBySide(leftText, rightText) {
  const d = lineDiff(leftText, rightText);
  const out = [];
  let ln = 0; // 왼쪽 줄번호 카운터
  let rn = 0; // 오른쪽 줄번호 카운터

  // 연속된 '-'(removed)와 '+'(added) 블록을 모아 한 번에 짝지어 flush한다.
  let removed = [];
  let added = [];
  function flushBlock() {
    if (!removed.length && !added.length) return;
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) {
      out.push({
        type: 'change',
        left: { n: ++ln, line: removed[i] },
        right: { n: ++rn, line: added[i] },
      });
    }
    // 남는 removed → left 행(오른쪽 filler)
    for (let i = pairs; i < removed.length; i++) {
      out.push({
        type: 'left',
        left: { n: ++ln, line: removed[i] },
        right: { n: null, line: null },
      });
    }
    // 남는 added → right 행(왼쪽 filler)
    for (let i = pairs; i < added.length; i++) {
      out.push({
        type: 'right',
        left: { n: null, line: null },
        right: { n: ++rn, line: added[i] },
      });
    }
    removed = [];
    added = [];
  }

  for (const row of d) {
    if (row.type === ' ') {
      flushBlock();
      out.push({
        type: 'same',
        left: { n: ++ln, line: row.line },
        right: { n: ++rn, line: row.line },
      });
    } else if (row.type === '-') {
      removed.push(row.line);
    } else {
      added.push(row.line);
    }
  }
  flushBlock();
  return out;
}

module.exports = { lineDiff, hasChanges, render, hunks, renderHunked, sideBySide };

// --- 검증용 데모 (실제 사용자 파일 접근 없음, 인메모리 문자열만) ---
if (require.main === module) {
  // 여러 줄 중 일부만 변경된 예시: 긴 미변경 구간이 hunk 사이에서 접히는지 확인.
  const a = [
    'line 1',
    'line 2',
    'line 3',
    'line 4',
    'line 5',
    'line 6',
    'line 7',
    'line 8',
    'line 9',
    'line 10',
    'line 11',
    'line 12',
  ].join('\n');

  const b = [
    'line 1 CHANGED',
    'line 2',
    'line 3',
    'line 4',
    'line 5',
    'line 6',
    'line 7',
    'line 8',
    'line 9',
    'line 10',
    'line 11 CHANGED',
    'line 12',
  ].join('\n');

  const d = lineDiff(a, b);
  console.log('--- render(전체) ---');
  console.log(render(d));
  console.log('--- renderHunked(문맥3) ---');
  console.log(renderHunked(d));
}
