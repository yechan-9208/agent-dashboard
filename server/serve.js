'use strict';
// 얇은 로컬 서버 (다리). 127.0.0.1에만 바인딩하고, 엔드포인트는 cli/core를 호출만 한다.
// 로직 중복 없음 — 모든 동작은 core에 있다.

const http = require('http');
const fs = require('fs');
const path = require('path');
const core = require('../cli/core');

const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function start({ port = 4319 } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const route = url.pathname;
    try {
      // --- 정적 파일 ---
      if (req.method === 'GET' && route === '/') {
        return sendFile(res, path.join(DASHBOARD_DIR, 'index.html'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && route === '/app.js') {
        return sendFile(res, path.join(DASHBOARD_DIR, 'app.js'), 'text/javascript; charset=utf-8');
      }
      if (req.method === 'GET' && route === '/design-system.css') {
        return sendFile(res, path.join(DASHBOARD_DIR, 'design-system.css'), 'text/css; charset=utf-8');
      }

      // --- API (core 호출) --- (데이터 소스 모드 /mode 라우트는 D37로 제거 — 항상 실제 파일 기준)
      if (req.method === 'GET' && route === '/overview') {
        return sendJson(res, 200, core.overview()); // 하이브리드: 존재만
      }
      if (req.method === 'GET' && route === '/diff') {
        return sendJson(res, 200, core.diffFor(url.searchParams.get('to'))); // 클릭 시 drift
      }
      if (req.method === 'POST' && route === '/pull') {
        const b = await readBody(req);
        // PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람. 이전 409(piGate) 응답 경로 소멸.
        return sendJson(res, 200, core.pull({ from: b.from }));
      }
      if (req.method === 'POST' && route === '/push') {
        const b = await readBody(req);
        return sendJson(res, 200, core.push({ to: b.to, apply: !!b.apply }));
      }

      // --- 프로젝트 레지스트리 API (T2, core 호출만) ---
      if (req.method === 'GET' && route === '/projects') {
        return sendJson(res, 200, core.projectsList()); // 등록 목록
      }
      if (req.method === 'POST' && route === '/projects/scan') {
        const b = await readBody(req);
        return sendJson(res, 200, core.projectsScan({ root: b.root })); // 후보만 — 등록 안 함
      }
      if (req.method === 'POST' && route === '/projects/adopt') {
        const b = await readBody(req);
        return sendJson(res, 200, core.projectsAdopt({ candidates: b.candidates }));
      }
      if (req.method === 'POST' && route === '/projects/add') {
        const b = await readBody(req);
        return sendJson(res, 200, core.projectsAdd({ root: b.root }));
      }
      if (req.method === 'POST' && route === '/projects/remove') {
        const b = await readBody(req);
        return sendJson(res, 200, core.projectsRemove({ root: b.root }));
      }
      if (req.method === 'POST' && route === '/projects/reset') {
        // 레지스트리 비우고 기본 루트 재스캔 → 후보 전체 재등록. { reset:true, adopted:N }.
        return sendJson(res, 200, core.projectsReset());
      }
      if (req.method === 'POST' && route === '/projects/prune') {
        // 디스크에서 사라진(root 미존재) 프로젝트를 레지스트리에서 정리. { removed:[...], remaining:N }.
        return sendJson(res, 200, core.projectsPrune());
      }

      // --- agent 트랙 API (지시문 트랙과 동일 패턴, core 호출만) ---
      if (req.method === 'GET' && route === '/agents/overview') {
        return sendJson(res, 200, core.agentOverview()); // canonical agents + 도구별 발견 + 비표준
      }
      if (req.method === 'GET' && route === '/agents/diff') {
        // 미리보기: canonical agent → 특정 도구 렌더 결과(diff + 손실)
        return sendJson(res, 200, core.agentDiff(url.searchParams.get('id'), url.searchParams.get('to')));
      }
      if (req.method === 'POST' && route === '/agents/pull') {
        const b = await readBody(req);
        return sendJson(res, 200, core.agentPull({ from: b.from, name: b.name, projectRoot: b.projectRoot }));
      }
      if (req.method === 'POST' && route === '/agents/push') {
        const b = await readBody(req);
        return sendJson(res, 200, core.agentPush({ id: b.id, to: b.to, apply: !!b.apply }));
      }

      // --- skill 트랙 API (동일 패턴, core 호출만) ---
      if (req.method === 'GET' && route === '/skills/overview') {
        return sendJson(res, 200, core.skillOverview()); // canonical + 도구별 발견 + 비공식
      }
      if (req.method === 'GET' && route === '/skills/diff') {
        return sendJson(res, 200, core.skillDiff(url.searchParams.get('name'), url.searchParams.get('to')));
      }
      if (req.method === 'POST' && route === '/skills/pull') {
        const b = await readBody(req);
        return sendJson(res, 200, core.skillPull({ name: b.name, source_id: b.source_id, projectRoot: b.projectRoot }));
      }
      if (req.method === 'POST' && route === '/skills/push') {
        const b = await readBody(req);
        return sendJson(res, 200, core.skillPush({ name: b.name, to: b.to, apply: !!b.apply }));
      }

      // --- 한 번에 동기화(Sync) API (UX-A, core 호출만) ---
      if (req.method === 'GET' && route === '/sync/plan') {
        // 읽기 전용 계획: 도구별 그룹/특이사항/기준 후보/기준별 손실.
        // scope: 'global'(미지정 시) 또는 프로젝트 root — 그대로 core에 전달만.
        return sendJson(res, 200, core.syncPlan({
          kind: url.searchParams.get('kind'),
          name: url.searchParams.get('name'),
          scope: url.searchParams.get('scope') || undefined,
        }));
      }
      if (req.method === 'POST' && route === '/sync/apply') {
        const b = await readBody(req);
        // pull(기준→canonical) + push(나머지 도구). scope: body의 값(global 또는 프로젝트 root)을 그대로 전달.
        return sendJson(res, 200, core.syncApply({ kind: b.kind, name: b.name, baseTool: b.baseTool, scope: b.scope, sourceId: b.sourceId }));
      }

      // --- 동기화 매트릭스 API (UX-E1, core 호출만) ---
      if (req.method === 'GET' && route === '/matrix') {
        // 행=(scope,name) × 도구 슬롯 + 동기화 상태. 첫 호출 시 프로젝트 자동 발견(레지스트리 비었을 때만).
        return sendJson(res, 200, core.syncMatrix({ kind: url.searchParams.get('kind') }));
      }

      // --- 스킬/에이전트 본문 뷰어 (이슈5, core 호출만) ---
      if (req.method === 'GET' && route === '/item/content') {
        // PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람. 이전 409(piGate) 응답 경로 소멸.
        return sendJson(res, 200, core.itemContent({
          kind: url.searchParams.get('kind'),
          name: url.searchParams.get('name'),
          scope: url.searchParams.get('scope') || undefined,
          tool: url.searchParams.get('tool') || undefined,
        }));
      }

      // --- 지시문 매트릭스 / 한 방 동기화 API (UX v2 — F2, core 호출만) ---
      if (req.method === 'GET' && route === '/instr/matrix') {
        // 전역 지시문 3파일 비교(존재/내용그룹/종합상태). canonical은 계산에 넣지 않음(순수 백업).
        return sendJson(res, 200, core.instrMatrix());
      }
      if (req.method === 'GET' && route === '/instr/content') {
        // 두 모델 지시문 본문 + 좌우 diff. (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람.)
        return sendJson(res, 200, core.instrContent());
      }
      if (req.method === 'POST' && route === '/instr/sync') {
        const b = await readBody(req);
        // apply:false=diff 요약(디스크 무변경), apply:true=pull(base)→push.
        return sendJson(res, 200, core.instrSync({ base: b.base, apply: !!b.apply }));
      }

      // --- 백업 목록 / 복구 API (UX-D1, core 호출만) ---
      if (req.method === 'GET' && route === '/backups') {
        return sendJson(res, 200, core.backupsList()); // 최신순 백업 목록(원위치 정보 포함)
      }
      if (req.method === 'POST' && route === '/backups/restore') {
        const b = await readBody(req);
        // 복구: backup.js가 경로 탈출 차단 + 대상 화이트리스트 검증을 강제한다.
        // 거부(경로 밖·비정당 대상)는 아래 공통 catch가 500 {error}로 표면화.
        return sendJson(res, 200, core.backupRestore({ path: b.path }));
      }

      // --- 태그 + 스토어(카탈로그) API (core 호출만) ---
      if (req.method === 'GET' && route === '/tags') {
        return sendJson(res, 200, core.tagSuggestions());
      }
      if (req.method === 'POST' && route === '/tags/set') {
        const b = await readBody(req);
        return sendJson(res, 200, core.setItemTags(b));
      }
      if (req.method === 'GET' && route === '/store') {
        // SKC1: ?publisher=<slug> 로 퍼블리셔 필터(있으면 core.storeList에 전달). ?q= 유지.
        return sendJson(res, 200, core.storeList(
          url.searchParams.get('q') || undefined,
          { publisher: url.searchParams.get('publisher') || undefined }
        ));
      }
      if (req.method === 'GET' && route === '/publishers') {
        // SKC1: 퍼블리셔 카드 목록(퍼블리셔별 repo·스킬 수 그룹핑).
        return sendJson(res, 200, core.publishers());
      }
      if (req.method === 'GET' && route === '/store/item') {
        return sendJson(res, 200, core.storeItem(url.searchParams.get('id')));
      }
      if (req.method === 'GET' && route === '/store/preview') {
        return sendJson(res, 200, core.storePreview(url.searchParams.get('id')));
      }
      if (req.method === 'POST' && route === '/store/apply') {
        const b = await readBody(req);
        // (PI 게이트는 D33으로 제거 — 로컬 전용·본인 열람.) 충돌(conflict) 응답은 200 본문 {conflict:true,...} 그대로 유지.
        return sendJson(res, 200, core.storeApply(b));
      }

      // --- 원격 레지스트리 API (스토어-R2, core 호출만 · 로직 0) ---
      if (req.method === 'GET' && route === '/registries') {
        return sendJson(res, 200, core.registryList()); // 등록 목록
      }
      if (req.method === 'POST' && route === '/registries/add') {
        const b = await readBody(req);
        return sendJson(res, 200, core.registryAdd({ url: b.url, name: b.name })); // 등록만 — 통신 없음
      }
      if (req.method === 'POST' && route === '/registries/remove') {
        const b = await readBody(req);
        return sendJson(res, 200, core.registryRemove({ id: b.id }));
      }
      if (req.method === 'POST' && route === '/registries/refresh') {
        const b = await readBody(req);
        // git clone(외부 통신, 사용자 트리거). 실패(네트워크 불가·repo 없음 등)는
        // 아래 공통 catch가 일반 에러 응답(500 {error})으로 표면화한다.
        return sendJson(res, 200, await core.registryRefresh({ id: b.id }));
      }
      if (req.method === 'GET' && route === '/registries/updates') {
        // git ls-remote 로 업데이트 확인. 통신 실패는 core가 항목별 error로
        // 담아 반환한다(throw 안 함) → 그대로 전달.
        return sendJson(res, 200, await core.registryCheckUpdates());
      }
      if (req.method === 'GET' && route === '/registries/collect-status') {
        // F2-3: 시작 훅이 kick한 증분 수집 진행 상태({running,total,done,failed,errors}).
        return sendJson(res, 200, core.registryCollectStatus());
      }

      // --- 플레이그라운드 API (추천→미리보기→적용, core 호출만) ---
      if (req.method === 'GET' && route === '/playground/catalog') {
        return sendJson(res, 200, core.pgCatalog());
      }
      if (req.method === 'GET' && route === '/playground/skill/wizard') {
        return sendJson(res, 200, core.pgSkillWizard());
      }
      if (req.method === 'POST' && route === '/playground/skill/recommend') {
        const b = await readBody(req);
        const q = b.query || core.pgAnswersToQuery(b.answers || {});
        return sendJson(res, 200, core.pgRecommendSkills(q, b.opts));
      }
      if (req.method === 'POST' && route === '/playground/skill/preview') {
        const b = await readBody(req);
        return sendJson(res, 200, core.pgPreviewSkill(b.id));
      }
      if (req.method === 'POST' && route === '/playground/skill/adopt') {
        const b = await readBody(req);
        return sendJson(res, 200, core.pgAdoptSkill({ id: b.id, resolution: b.resolution, newName: b.newName }));
      }
      if (req.method === 'POST' && route === '/playground/agent/recommend') {
        const b = await readBody(req);
        return sendJson(res, 200, core.pgRecommendForRole(b.role, b.opts));
      }
      if (req.method === 'POST' && route === '/playground/agent/compose') {
        const b = await readBody(req);
        return sendJson(res, 200, core.pgComposeAgent({ roleText: b.role, pickedIds: b.pickedIds, name: b.name }));
      }
      if (req.method === 'POST' && route === '/playground/agent/preview') {
        const b = await readBody(req);
        return sendJson(res, 200, core.pgPreviewAgent(b.neutral));
      }
      if (req.method === 'POST' && route === '/playground/agent/adopt') {
        const b = await readBody(req);
        return sendJson(res, 200, core.pgAdoptAgent({ neutral: b.neutral, resolution: b.resolution, newName: b.newName }));
      }

      // --- Phase 2: 사용량 + 자기 점검 API (core 호출만) ---
      if (req.method === 'GET' && route === '/usage') {
        // 사용량 = 스킬 호출 "횟수"(신호 B, Claude 세션 로그). 본문 없이 이름·횟수·시각만.
        return sendJson(res, 200, core.usageStats());
      }
      if (req.method === 'GET' && route === '/synclog') {
        return sendJson(res, 200, core.syncLog()); // 마지막 push/review 시각
      }
      if (req.method === 'POST' && route === '/review') {
        const b = await readBody(req);
        return sendJson(res, 200, core.review({ dryRun: !!b.dryRun }));
      }
      if (req.method === 'GET' && route === '/pending') {
        return sendJson(res, 200, { proposals: core.pending() });
      }
      if (req.method === 'POST' && route === '/approve') {
        const b = await readBody(req);
        return sendJson(res, 200, core.approveProposal(b.id));
      }
      if (req.method === 'POST' && route === '/reject') {
        const b = await readBody(req);
        return sendJson(res, 200, core.rejectProposal(b.id));
      }
      if (req.method === 'POST' && route === '/pin') {
        const b = await readBody(req);
        return sendJson(res, 200, b.pinned === false ? core.unpin(b.id) : core.pin(b.id));
      }
      if (req.method === 'POST' && route === '/archive') {
        const b = await readBody(req);
        core.archiveItem(b.id);
        return sendJson(res, 200, { ok: true, id: b.id });
      }
      if (req.method === 'POST' && route === '/restore') {
        const b = await readBody(req);
        return sendJson(res, 200, core.restoreItem(b.id));
      }

      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
  });

  // 127.0.0.1에만 바인딩 → 외부 노출 금지
  server.listen(port, '127.0.0.1', () => {
    console.log(`AI-Agent Dashboard: http://127.0.0.1:${port}  (Ctrl+C로 종료)`);
    // 시작 훅(F2-4): 비차단 백그라운드로 1회 실행. 실패해도 서버는 정상 기동(에러는 상태로만).
    //  ① 레지스트리 증분 수집 kick(캐시 없는 것만 clone — collectMissing이 판정).
    //  ② 프로젝트 재스캔 + 신규만 adopt(이미 등록돼 있어도 새로 발견분을 병합).
    // 근거: D28 "앱 실행=사용자 트리거" → 시작 시 네트워크 수집 허용. 자동 폴링/스케줄은 없음.
    startupHook();
  });
  return server;
}

// 시작 훅 본체 — 서버 기동을 막지 않도록 await하지 않고 fire-and-forget으로 돌린다.
function startupHook() {
  // ① 레지스트리 증분 수집(비동기·비차단). 실패는 collectStatus의 errors로만 남는다.
  Promise.resolve()
    .then(() => core.registryCollectMissing())
    .catch(() => { /* 전체 실패도 서버 기동엔 영향 없음 — 상태(collect-status)로만 노출 */ });

  // ② 프로젝트 재스캔 + 신규만 adopt(기존 projectsEnsureScanned 확장: 이미 등록돼 있어도 병합).
  //    스캔은 동기 디스크 읽기지만 예외가 서버 기동을 막지 않도록 방어.
  try {
    const scan = core.projectsScan(); // 기본 루트(모드별) — 후보만
    core.projectsAdopt({ candidates: scan.candidates }); // 신규(미등록)만 병합, 기존은 skip
  } catch { /* 스캔/병합 실패도 서버 기동엔 영향 없음 */ }
}

module.exports = { start };
