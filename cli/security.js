'use strict';
// 보안 가드레일 한 곳 모음 (security-check.md와 동기화).
//  - 거부목록: 시크릿/개인정보 파일은 절대 읽지/수집하지 않는다.
//  - PI 게이트(본문 개인정보 탐지/마스킹)는 D33으로 제거됨 — 로컬 전용·사용자 본인만
//    열람하므로 불필요(외부 통신 없음). 파일 경로 기반 거부목록만 남긴다.

// (1) 거부목록 — 파일 경로가 하나라도 매칭되면 읽기 거부
const DENY_PATTERNS = [
  /auth\.json$/i,
  /oauth_creds\.json$/i,
  /google_account/i,
  /\.sqlite(-shm|-wal)?$/i,
  /(^|\/)(sessions|archived_sessions)\//i,
  /history\.jsonl$/i,
  /\.env$/i,
  /\.(key|pem)$/i,
];

function isDenied(filePath) {
  return DENY_PATTERNS.some((re) => re.test(filePath));
}

module.exports = { isDenied };
