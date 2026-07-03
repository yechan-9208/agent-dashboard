# 프로젝트 구조 (Structure)

AI-Agent Dashboard의 모듈 구조·데이터 모델·CLI/서버/대시보드 분리를 설명하는 **내부 설계도**다.
구현 언어는 **Node.js**. 핵심 원칙: **`cli/core.js`가 모든 로직의 단일 소스**이고, 서버는 core를
호출하는 **얇은 다리**일 뿐 로직을 중복 구현하지 않는다.

> 사용법·기능 관점 설명은 [`docs/guide.md`](../guide.md), 폴더 개요는 루트 [`README.md`](../../README.md).
> 이 문서는 "코드가 어떻게 나뉘어 있고 왜 그런가"에 집중한다.
> **현재 상태 기준**: 2모델(Claude·Codex) 체제. 아래 "주요 전환"의 D31~D36이 반영돼 있다.

### 주요 전환 (이 문서가 반영하는 최근 결정)
- **D31 — Gemini 지원 중단:** 2모델(Claude·Codex)만. `transform/tool-map.js` 삭제(Claude↔Gemini 이름 매핑 전용이었음).
- **D32 — 뷰 축소:** 대시보드는 **개요·지시문·스킬·사용량** 4뷰만 노출. 에이전트·플레이그라운드·스토어는 UI에서 숨김(엔진·CLI·API는 존치 — 복원 쉬움). 근거: 에이전트는 Codex의 tools 미지원으로 100% 동기화 불가(`docs/plan/todo.md`).
- **D33 — PI 게이트 제거:** 본문 개인정보 탐지·마스킹·확인 모달 삭제(로컬 전용·본인 열람이라 불필요). **시크릿 거부목록(`security.isDenied`)·스캔 화이트리스트는 유지.** 사용량은 파일 시각이 아니라 **Claude 세션 기록의 실제 호출 횟수**(B 신호)로 집계.
- **D35 — 디자인 시스템 v2:** Apple 스타일 목업(`docs/design/AAD-Redesign-standalone.html`) 전면 적용 — 모델색/상태색 분리, ✓/– 중립 마크, 아이콘 레일, 사용량 3지표 복원. dashboard/ 3파일만 변경(백엔드 무수정). §7 참고.
- **D36 — 프로젝트 정리(prune):** 등록됐지만 디스크에서 사라진 프로젝트를 제거하는 `POST /projects/prune`(+`GET /projects` `exists` 플래그, `aad projects prune`). 초기화(reset)와 달리 사라진 것만 지워 수동 등록분은 보존.

---

## 1. 디렉토리 레이아웃

```
agent-dashboard/
├── package.json              # 의존성: gray-matter, @iarna/toml (서버는 표준 http만)
├── bin/
│   └── aad.js                # CLI 진입점. 인자 파싱 → core 호출 → 콘솔 출력(로직 없음)
├── cli/                      # ★ 모든 로직의 단일 소스
│   ├── core.js               # 명령 로직 집합점. CLI·서버가 모두 여기만 호출. 데이터만 반환
│   ├── paths.js              # 두 모델의 경로 정의(항상 실제 파일 기준 — D37) + catalogPath()
│   ├── security.js           # 🔒 시크릿 거부목록(isDenied) 한곳 관리 (PI 탐지는 D33으로 제거)
│   ├── scanner.js            # 하이브리드 스캐너(D9): 존재만 자동, 내용은 클릭 시(거부목록 준수)
│   ├── canonical.js          # canonical 읽기/쓰기, id·메타·tags 부여
│   ├── transform/
│   │   ├── instructions.js   # 트랙 C: 지시문 (파일명만 변경 — CLAUDE.md/AGENTS.md)
│   │   ├── skill.js          # 트랙 A: SKILL.md 복사 (표준이라 두 모델 동일)
│   │   └── agent.js          # 트랙 B: 중립 스키마 → Claude .md / Codex .toml (tool-map.js는 D31로 삭제)
│   ├── diff.js               # LCS 라인 diff + hunk(3줄 문맥) + sideBySide(좌우 2열 정렬)
│   ├── backup.js             # 덮어쓰기 전 타임스탬프 백업 + 복구(화이트리스트 가드). UI 진입점은 없고 CLI로만
│   ├── synclog.js            # 마지막 push 시각 기록(자동 스케줄 없음)
│   ├── telemetry.js          # [P2] 편집 신호(A: git/mtime) + 결정론적 노후화 계산
│   ├── usagelog.js           # 사용빈도(B 신호): Claude 세션 기록의 스킬 호출 "횟수·시각만" 집계
│   ├── duplicate.js          # [P2] 중복/유사 탐지 휴리스틱(jaccard·텍스트 유사도)
│   ├── maintenance.js        # [P2] usage/review/제안 staging/archive — 자동 적용·삭제 없음
│   ├── category.js           # [P3] 태그 모델(자유·다중 + 12 카테고리 프리셋 + 레거시 매핑)
│   ├── search.js             # [P3] 점수 기반 목록 랭킹(스토어·추천 공용)
│   ├── store.js              # [P3] 번들 정적 카탈로그 로더(읽기 전용, 외부 통신 0)
│   ├── registry.js           # 외부 스킬 레지스트리 — 토큰 없는 git clone(공개 repo), 캐시, 증분 수집
│   ├── projects.js           # 홈+디스크 프로젝트 자동 발견(등록/초기화) + 스코프 부여
│   └── playground.js         # [P3] 추천→조합→미리보기 엔진(LLM·디스크 쓰기 없음) — UI 숨김(D32)
├── server/
│   └── serve.js              # 127.0.0.1 전용 얇은 서버. 엔드포인트 → core 함수 호출만
├── dashboard/
│   ├── index.html            # SPA 셸(.app/.sidebar/.main) + 중앙 모달 뷰어 + 좌우 diff. 스킬 = 매트릭스 표
│   ├── app.js                # 해시 라우터 + fetch + 단일 클릭 이벤트 위임(renderMatrix/renderSideBySide 등)
│   └── design-system.css     # 디자인 시스템(라이트 모드 고정)
├── canonical/                # 중앙 저장소 = 백업/이력. 자체 git(로컬 전용), .gitignore로 시크릿 차단
│   ├── instructions/  skills/  agents/  archive/
│   └── (+ .telemetry.json/.usage-events.json/.usage-scan.json/.sync-log.json 사이드카)
├── backups/                  # 적용 전 백업(런타임 생성, git 제외)
├── catalog/
│   ├── catalog.json          # 스토어 카탈로그(번들 정적, 모드 무관)
│   ├── default-registries.json  # 퍼블리셔 레지스트리 시드(70여 퍼블리셔)
│   ├── skill-tags.json       # 태그 분류 어휘(12 카테고리, fetch 시 자동 분류)
│   └── cache/                # 레지스트리 clone 런타임 캐시(git 제외)
├── .claude/                  # agents/(dev-verifier·project-verifier) + launch.json(aad)
└── docs/                     # 문서: guide.md + architecture/(structure·tech-stack) decision/ security/
                              #      design/(현행 목업) process/ verification/ plan/(todo)
                              #      + lagacy/(이전 결정 기준의 과거 문서 보관소 — 현행 아님)
```

## 2. 경로 시스템 (paths.js) — 항상 실제 파일 기준 (D37)

모든 경로는 `paths.js`를 거친다. 더미/데모 모드(`mode.js`)는 D37로 제거됐고,
격리가 필요한 곳(테스트·플러그인 영속화)은 **환경변수 오버라이드**로 저장 위치만 바꾼다:

| 대상 | 기본 | 오버라이드 |
|---|---|---|
| 모델 홈 | `~/.claude` `~/.codex` `~/.agents` + 발견된 프로젝트 | — |
| canonical | `<repo>/canonical/` | `AAD_CANONICAL` (플러그인: DATA 아래) |
| 백업 | `<repo>/backups/` | `AAD_BACKUPS` (플러그인: DATA 아래) |
| 레지스트리 캐시 | `catalog/cache/` | `AAD_REGISTRY_CACHE` |
| 사용빈도 세션 루트 | `~/.claude/projects` | `AAD_SESSIONS_ROOT` (usagelog 격리 테스트용) |
| 카탈로그 | `catalog/catalog.json` (정적 번들) | `AAD_CATALOG` |

- 실제 파일에 대한 안전은 모드가 아니라 **안전 흐름**(미리보기→적용 2단계 + 자동 백업)과 시크릿 거부목록(`security.js`)이 담당한다.
- **D24:** 개발·검증은 실제 로컬을 읽는 것은 허용하되, 대화·보고에 실제 파일 본문·개인정보·토큰을 싣지 않고, 실제 홈·실제 canonical에 쓰기 검사는 하지 않는다(쓰기 검증은 `AAD_CANONICAL`/`AAD_BACKUPS`를 임시 폴더로 돌린 격리 환경에서만).

## 3. canonical 데이터 모델

모든 항목은 **안정적 `id` + 공통 메타**를 가진다.

```jsonc
{
  "id": "instr-claude-global",
  "type": "instruction | skill | agent",
  "scope": "global | project",
  "source_tool": "claude | codex",
  "tags": ["review", "code"],          // [P3] 자유·다중 태그
  "created_at": "...", "updated_at": "..."
}
```

- **지시문:** 마크다운 본문 + 메타.
- **skill:** 표준 `SKILL.md`(frontmatter name·description + 본문) **그대로**. 도구별 확장 메타는 분리 보관.
- **agent(중립 스키마):** `name / description / system_prompt / model / tools[] / mcp_servers[] / source_notes`. `model`은 추측 금지(모르면 null).
- **사이드카(canonical 루트):** `.telemetry.json`(편집 신호·상태) · `.usage-events.json`(스킬별 호출 시각, 이름·시각만) · `.usage-scan.json`(세션 증분 스캔 커서) · `.proposals.json`(제안 staging) · `.sync-log.json`(마지막 동기화) · `categories.json`(커스텀 태그). **로그 본문은 저장하지 않는다 — 횟수·시각만.**
- canonical 변경은 로컬 git 커밋으로 이력을 남긴다. `gitCommit`은 **canonical 폴더 자체가 git 저장소일 때만** 커밋한다(상위 프로젝트 저장소 전체를 커밋하지 않도록 toplevel 가드).

## 4. 변환 규칙 (transform)

| 트랙 | canonical | → 각 모델 | 난이도 |
|---|---|---|---|
| C 지시문 | 마크다운 | `CLAUDE.md`/`AGENTS.md` (파일명만 변경) | 낮음 |
| A skill | `SKILL.md` | 각 skill 위치로 복사 | 낮음 |
| B agent | 중립 스키마 | Claude `.md`(frontmatter+본문) / Codex `.toml`(`developer_instructions`) | 중간 |

- **Codex tools 손실:** Codex는 에이전트별 `tools` 필드가 없어(0번 검증 D10) 변환 시 tools 전부가 **⚠ 손실**로 표시된다. 임의로 채우지 않는다. (Claude↔Gemini 이름 매핑 `tool-map.js`는 Gemini 중단 D31로 삭제.)
- 근거: [`verification/agent-format-verification.md`](../verification/agent-format-verification.md), [`verification/skill-format-verification.md`](../verification/skill-format-verification.md), (Gemini 시대 재검증은 [`lagacy/verification/`](../lagacy/verification/agent-concept-reverification.md)). skill 스캔 위치 정책은 decision.md D11.

## 5. 명령 흐름 (bin/aad.js → core.js)

`bin/aad.js`는 인자를 파싱해 core 함수를 호출하고 결과를 표로 출력할 뿐이다. 명령 전체 목록은
[`guide.md` §7](../guide.md#7-cli-레퍼런스). 그룹만 요약:

| 그룹 | 명령 | core 진입점(대표) |
|---|---|---|
| 상태 | `status` | `status()` |
| **매트릭스·동기화(D27)** | `matrix --kind` / `sync --kind --name [--base] [--scope] [--apply]` | `syncMatrix()` / `syncPlan()` · `syncApply()` |
| **프로젝트 발견** | `projects ls/scan/add/rm/reset/prune` | `projectsList/Scan/Adopt/Add/Remove()` · `projectsReset()` · `projectsPrune()` |
| 지시문 | `instr sync --base [--apply]` / `pull` / `push [--apply]` | `instrContent()`·`instrSync()` / `pull()` / `push()` |
| agent(엔진 존치) | `agent ls/pull/push` | `agentOverview()` / `agentPull()` / `agentPush()` |
| skill | `skill ls/pull/push` | `skillOverview()` / `skillPull()` / `skillPush()` |
| 태그 [P3] | `tags ls/set` | `tagSuggestions()` / `setItemTags()` |
| 스토어 [P3, UI 숨김] | `store ls/show/preview/apply` | `storeList/Item/Preview/Apply()` |
| 레지스트리 | `registry ls/add/refresh/updates/rm` | `registryList()` · `publishers()` / `registry*()` |
| 백업(CLI 전용) | `backups ls/restore` | `backupsList()` / `backupRestore()` |
| 플레이그라운드 [P3, UI 숨김] | `pg …` | `pg*` 래퍼 |
| 사용량 [P2] | `usage / review / pending / approve / reject / …` | `usageStats()` · `maintenance.js` 경유 |
| 서버 | `serve [--port 4319]` | `server/serve.js start()` |

- **안전 흐름(불변):** 모든 쓰기는 `미리보기(diff) → --apply(명시적)` 2단계. apply 전 백업, canonical 변경은 git 커밋, synclog 기록.
- **"모든 모델 적용"은 얇은 래퍼:** `skillPushAll`/`agentPushAll` = `paths.TOOLS` 루프로 기존 `skillPush`/`agentPush` 호출만(로직 중복 0).
- **충돌 해결:** 동명 canonical 존재 시 `{conflict:true, options:[overwrite|skip|rename]}`을 반환하고 사용자가 `--resolution`으로 고른다("특수응답→모달" 패턴).

## 5.5 동기화 매트릭스 · 경로 자동 발견 (D27 — 주 화면)

D27에서 화면의 중심이 "중앙 저장소 상태"에서 **"내 경로들이 서로 동기화됐는가"** 로 바뀌었다. 중앙 저장소는 백업/이력으로 남고, 사용자는 매트릭스만 본다.

- **경로 자동 발견(`projects.js`):** `scan(rootDir,{maxDepth})` = `readdir`/`lstat`만(내용 미열람), 마커(`.claude`/`CLAUDE.md`/`AGENTS.md`/`.agents`/`.codex`)로 후보 판별, `EXCLUDE_DIRS`·심볼릭 링크 미추적·홈 자기 자신 제외. **AAD 자신의 `fixtures/`·`.dummy/` 하위는 실제 스캔 후보에서 제외**(오염 방지). 등록 없이도 `syncMatrix`가 `projectsEnsureScanned()`로 최초 1회 자동 발견하고, `projectsReset()`으로 목록을 비우고 처음부터 다시 찾을 수 있다.
- **매트릭스(`core.syncMatrix({kind})`):** 발견된 모든 경로(스코프 `global`/`project`)의 항목을 이름 기준으로 모으고, **내용 해시**로 그룹핑해 동기화 상태를 판정한다:
  - `synced`(동기화됨) · `partial`(일부 없음) · `drift`(불일치) · `single`(단독). (2모델이라 partial은 사실상 single로 수렴.)
  - 반환: `{kind, autoScan, counts, rows:[{scope, name, tags, autoTags, tools:{claude,codex}, syncState, lastModified, …}]}`. 에이전트는 `agentNeutralKey`로 모델 차이를 정규화한 뒤 비교.
- **Sync(`syncPlan`/`syncApply`):** 어긋난 행에서 **기준 모델**을 골라 → canonical(백업)로 가져오고 → 다른 모델 위치로 내보낸다. 기존 `pull`+`push` 파이프라인을 경유(백업·synclog·모드 가드 자동 상속). **스코프 인지:** 행의 `scope`가 프로젝트면 그 프로젝트 폴더 안에서 맞춘다(push/pull에 projectRoot 전달, 등록 프로젝트만 허용).

## 6. 서버 (얇은 다리)

`serve.js`는 `127.0.0.1`에만 바인딩하고, 각 엔드포인트는 대응 core 함수를 호출만 한다.
전체 표는 [`guide.md` §8](../guide.md#8-서버-엔드포인트). 네임스페이스만 요약:

| 네임스페이스 | 라우트 |
|---|---|
| 정적 | `GET /` `/app.js` `/design-system.css` |
| 매트릭스·동기화(D27) | `GET /matrix?kind=` · `POST /sync/plan` `/sync/apply` (scope 전달) |
| 프로젝트 | `GET /projects`(각 항목에 `exists` 플래그) · `POST /projects/{scan,adopt,add,remove,reset,prune}` (`prune`=디스크에서 사라진 root만 제거) |
| 지시문 | `GET /instr/matrix` `/instr/content` · `POST /instr/sync` (+ 레거시 `/overview` `/diff` `/pull` `/push`) |
| 본문 뷰어 | `GET /item/content?kind=&name=&scope=&tool=` (contents 맵 + 좌우 sideBySide) |
| agent / skill | `GET /agents|skills/overview·diff` · `POST /agents|skills/pull·push` |
| 태그 · 스토어 | `GET /tags` `POST /tags/set` · `GET /store` `/store/item` `/store/preview` `POST /store/apply` |
| 레지스트리 | `GET /publishers` `/registries` `/registries/updates` `/registries/collect-status` · `POST /registries/{add,refresh,remove}` |
| 백업 | `GET /backups` · `POST /backups/restore` |
| 플레이그라운드 | `GET /playground/…` + `POST /playground/…` |
| 사용량 [P2] | `GET /usage`(=`usageStats` B신호) `/synclog` `/pending` + `POST /review` `/approve` `/reject` `/pin` `/archive` `/restore` |

- 시작 훅(`start()`): 레지스트리 증분 수집 + 프로젝트 재스캔을 **비차단 백그라운드**로 1회(실패해도 서버 기동엔 영향 없음).
- PI 게이트는 제거됨(D33) — 더 이상 409 PI 응답이 없다. 시크릿 거부목록은 `readItemContent` 안에서 여전히 강제.

## 7. 대시보드 (SPA) — 디자인 시스템 v2 (D35)

- **디자인 v2(D35):** Apple 스타일 목업(`docs/design/AAD-Redesign-standalone.html`)이 권위 소스. 핵심 원칙 = **모델색(Claude 보라 · Codex 청록)과 상태색(초록·앰버·회색)의 완전 분리**, 액션색은 파랑 하나, 매트릭스 셀은 중립 ✓/–(색점 없음), 이모지 아이콘 → SVG, 카드 16px·모달 18px·칩/버튼 pill.
- `index.html` = 앱 셸: `.sidebar`(AAD 로고 + 접기 + SVG `nav-item[data-view]` + 카운트 배지 + 연결/로컬 전용 푸터) + `.main`(스티키 블러 헤더 28px + `<section data-panel>`들). **반응형(데스크톱만)**: ≥1200 기본 · 1000–1200 폴더 패널 상단 스택 · <1000 사이드바 자동 **아이콘 레일**(68px). topnav(가로 메뉴)는 v2에서 제거. **라이트 모드 고정**.
- `app.js` = **해시 라우터**(`showView`/`ensureLoaded` — 뷰 첫 진입 시에만 로드) + **단일 `document` 클릭 위임**(모든 버튼은 `data-*` 속성으로 분기, 접두사 `mx-`/`store-`/`pg-` 등으로 충돌 방지). `fetchMatrix`는 in-flight/캐시를 공유해 개요·배지·뷰가 같은 응답을 재사용.
- **노출 4뷰:**
  - **개요:** 실행형 배너(동기화 필요 N → 주의 필터 이동) + 4스탯(전체/1일/7일/필요) + **동기화 상태 분해 막대**(행 클릭→필터) + 카테고리 TOP 5 막대(미정 제외) + **최근 사용** + **모델 커버리지**(전부 matrix rows·/usage 클라이언트 집계 — 백엔드 무변경).
  - **지시문:** CLAUDE.md ↔ AGENTS.md **좌우 비교 전용**(같으면 단일 본문, 다르면 `renderSideBySide` diff). 배너에 "다른 줄 N" 요약. diff 팔레트 = 다른 줄 앰버(#FBF3E0) · 한쪽만 빗금. 쓰기 UI 없음(지시문은 손대지 않음 — D35에서 재확인).
  - **스킬:** 좌측 폴더 리스트(배지=항목 수) + 우측 매트릭스 표(`renderMatrix`) — 셀 ✓/– 중립 마크, 상태 pill 배지(+dot), 불일치 행 앰버(#FCF8EE)·선택 행 파랑(#F2F7FE), 범례 줄(✓/–/모델색 사각점), 카테고리 다중 OR 필터·"미정" 칩, 이름 클릭 → **중앙 모달 본문 뷰어**(단일/좌우 diff), 행별·배치 Sync(스코프 인지).
  - **사용량:** 프라이버시 배너 + 3지표 카드(지난 1일/7일/사용 이력) + 정렬 토글(최근/사용량) + 5컬럼 표(이름·최근 사용·1일·7일·전체 막대, 0값 muted).
- **숨김 뷰(D32):** 에이전트·플레이그라운드·스토어 — `VIEW_META` 미등록 + nav 제거, 해시 접근 시 개요로 폴백. 엔진/CLI/API는 존치.
- **공통 컴포넌트:** 중앙 모달 뷰어(scrim·ESC·바깥클릭), 좌우 diff(`renderSideBySide` — 문자 하이라이트·빗금 채움·모델색 헤더), 동기화 모달(**기준 = 세그먼트 컨트롤** + 방향 라벨 + "로컬 파일에만 씁니다" 문구), 충돌 모달(overwrite/skip/rename), 배치 Sync, 토스트, 우아한 로딩·에러(크래시 대신 안내, D26). PI 모달·백업 모달·다크모드 토글은 제거됨.
- 모든 적용 버튼은 서버의 미리보기 응답을 먼저 보여주고, 한 번 더 눌러야 실제 쓰기(2단계 유지).

## 8. 사용빈도 신호 (usagelog.js + telemetry.js)

- **B 신호(사용빈도, `usagelog.js`):** Claude 세션 기록(`~/.claude/projects/*/*.jsonl`)의 tool-use 라인에서 **스킬 호출 이름·시각만** 추출한다(본문 비저장, D8). 방어적 파싱(깨진 줄 skip), 증분 스캔 커서, `.usage-events.json`에 스킬당 상한 1000 누적. `usageStats()`가 `{day1,day7,total}` + `lastUsed`로 매핑. Codex `sessions/`는 거부목록이라 제외 → "Claude 세션 기준" 명시. 로그 없거나 실패면 `source:'none'` + 0 폴백.
- **A 신호(편집, `telemetry.js`):** git/mtime 기반 노후화·churn 계산(내부 유지보수용). 사용량 화면은 B 신호를 쓴다.

## 9. 보안 위치

- 규칙·점검: [`security/security.md`](../security/security.md) + [`security/security-check.md`](../security/security-check.md). 결정 근거: [`decision/decision.md`](../decision/decision.md) D8·D9·D13·D24·D25·**D33**.
- `security.js`는 **시크릿 거부목록(`isDenied`)** 만 관리한다(auth.json·oauth_creds.json·*.sqlite·sessions/·history.jsonl·.env·*.key·*.pem·google_account). `scanner.js`·`projects.js`가 경로를 훑기 전에 필터링하고, `readItemContent`가 본문을 읽기 전에 거부목록을 검사한다.
- **PI 게이트 제거(D33):** 본문 개인정보 탐지·마스킹·확인 모달은 없앴다 — 로컬 전용·외부 통신 없음·본인 열람. 거부목록·화이트리스트는 그대로.
- **읽기 모델(D9 하이브리드):** 존재/파일명만 자동 스캔, 내용·drift는 사용자가 클릭한 항목만.
- **네트워크(D25):** 유일한 외부 통신은 레지스트리 git clone이며 **사용자 동작(앱 실행 포함, D28) 시에만**. `AAD_ALLOW_NET` 별도 게이트는 제거됨.
- 신규 쓰기 경로 금지 — 모든 적용은 기존 push 파이프라인 경유(모드 가드·백업·synclog 자동 상속).

## 10. 개발 프로세스

"그룹개발"(D20): 계획 → 서브에이전트 위임(보안 클로즈 포함, 모두 Opus 4.8) → 작업별 `dev-verifier` → 최종 `project-verifier`.
검증 에이전트는 Read/Grep/Glob/Bash만 가진다(수정 불가 = 판단만). 상세: [`process/group-dev.md`](../process/group-dev.md).

## 11. 다음 확장 지점

- **에이전트 뷰 복원:** Codex 서브에이전트 스펙 재검증 후 100% 왕복 변환이 가능해지면 에이전트·플레이그라운드 뷰 숨김 해제(`docs/plan/todo.md`).
- **Real Mode 실행:** 플레이그라운드 `tryRun`의 실제 headless 실행 + 샌드박스.
- **배포 형태:** 현재 브라우저 방식(D15). 필요 시 동일 UI를 Tauri 등으로 감싸 네이티브 앱화.
