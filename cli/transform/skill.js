'use strict';
// 트랙 A — skill 변환. SKILL.md는 agentskills.io 표준이라 세 도구 본문이 동일 → "복사".
//  - 도구별로 <skillTargetDir>/<name>/SKILL.md 로 그대로 쓴다.
//  - (후속) 도구별 메타 오버레이(Claude context 필드, Codex agents/openai.yaml 등)는
//    이번 범위 밖. 검증에서 스키마가 미확인이라 임의로 만들지 않는다(docs/verification/skill-format-verification.md).

const path = require('path');
const paths = require('../paths');

function render(canonicalBody, name, tool) {
  const dir = paths.skillTargetDir(tool);
  return {
    tool,
    name,
    targetPath: path.join(dir, name, 'SKILL.md'),
    content: canonicalBody, // skill 본문은 도구 공통(표준)
    losses: [], // 코어 복사엔 손실 없음 (도구별 메타 오버레이는 후속)
  };
}

module.exports = { render };
