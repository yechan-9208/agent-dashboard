'use strict';
// "마지막 동기화/점검 시각" 기록. 자동 스케줄은 두지 않고(사용자 동작 시에만),
// 언제 마지막으로 push(적용)·review(점검)했는지만 남겨 대시보드에 표시한다.
// 저장: canonicalRoot()/.sync-log.json  { push: {claude,codex: ISO}, lastReview: ISO }
// (과거 기록에 gemini 키가 남아 있을 수 있으나 무시된다 — 2모델 체제.)

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

function file() {
  return path.join(paths.canonicalRoot(), '.sync-log.json');
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return { push: d.push || {}, lastReview: d.lastReview || null };
  } catch {
    return { push: {}, lastReview: null };
  }
}

function save(d) {
  fs.mkdirSync(paths.canonicalRoot(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(d, null, 2) + '\n');
}

// 도구로 push(적용)한 시각 기록
function recordPush(tool) {
  const d = load();
  d.push[tool] = new Date().toISOString();
  save(d);
}

// review(점검) 실행 시각 기록
function recordReview() {
  const d = load();
  d.lastReview = new Date().toISOString();
  save(d);
}

module.exports = { load, recordPush, recordReview, file };
