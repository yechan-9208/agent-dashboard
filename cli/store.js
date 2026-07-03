'use strict';
// 스토어 = 카탈로그 로더. 번들 정적 카탈로그(catalog/catalog.json, 외부 통신 없음)를
// 읽고, 스토어-R1부터는 레지스트리 캐시(catalog/cache/registry-*.json)도 병합한다.
// (적용 로직은 core.js가 가짐. 여기서는 canonical/transform을 모르고 "읽기"만 한다.)
//
// 병합 규칙(하위호환):
//  - 반환 형태는 기존과 동일한 { version, items[] } — 기존 소비자(storeList/storeItem/
//    playground)가 그대로 동작한다.
//  - 레지스트리 항목 id는 registry.js에서 이미 'reg-<registry_id>-<name>' 으로
//    네임스페이스돼 있어 번들 id와 충돌하지 않는다. 그래도 id 충돌 시 "번들 우선".
//  - 캐시 파일이 하나도 없으면 병합 결과 = 번들 그대로(기존과 완전 동일).

const fs = require('fs');
const paths = require('./paths');
const registry = require('./registry');

// 번들 catalog.json만 읽어 { version, items[] } 로 돌려준다. 없거나 깨졌으면 빈 카탈로그.
function loadBundled() {
  try {
    const raw = fs.readFileSync(paths.catalogPath(), 'utf8');
    const data = JSON.parse(raw);
    return {
      version: data.version || 0,
      items: Array.isArray(data.items) ? data.items : [],
    };
  } catch (e) {
    return { version: 0, items: [] };
  }
}

// 번들 + 레지스트리 캐시를 병합해 { version, items[] } 반환.
function load() {
  const bundled = loadBundled();
  let regItems = [];
  try {
    regItems = registry.cachedItems();
  } catch {
    regItems = []; // 캐시 로드 실패는 번들만으로 진행(하위호환)
  }
  const byId = new Map();
  for (const it of bundled.items) byId.set(it.id, it); // 번들 먼저
  for (const it of regItems) {
    // registry 캐시 항목은 통째로 실어 보낸다(하위호환 유지) — SKC1에서 추가된
    // tags/publisher/publisherSlug/sourceRepo 필드도 그대로 소비자에게 전달된다.
    if (!byId.has(it.id)) byId.set(it.id, it); // id 충돌 시 번들 우선(레지스트리는 스킵)
  }
  return { version: bundled.version, items: [...byId.values()] };
}

// id로 카탈로그 항목 1개를 찾는다(본문/neutral 포함). 없으면 null.
function get(id) {
  return load().items.find((it) => it.id === id) || null;
}

module.exports = { load, loadBundled, get };
