'use strict';
// 트랙 C — 지시문 변환.
// canonical 본문은 그대로 두고, 도구별로 "파일명만" 바꿔 배포한다.
//   canonical 본문 → claude: CLAUDE.md / codex: AGENTS.md
// (지시문은 둘 다 프로젝트/글로벌 지시문이라 본문 변환이 필요 없다 — D3 근거)

const paths = require('../paths');

// 대상 도구로 보낼 결과를 만든다. 본문은 동일, 목적지 경로만 다르다.
function render(canonicalBody, tool) {
  return {
    tool,
    targetPath: paths.instructionPath(tool),
    filename: paths.INSTRUCTION_FILENAME[tool],
    body: canonicalBody, // 지시문은 본문 변환 없음
    losses: [], // 손실 없음 (skill/agent 트랙에서 채워질 자리)
  };
}

module.exports = { render };
