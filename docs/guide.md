# AI-Agent Dashboard — 기능 · 사용 가이드

이 문서는 AAD의 **전체 기능**과 **자세한 사용법**을 설명한다.
프로젝트 소개·폴더 역할은 루트 [`README.md`](../README.md), 내부 구조는
[`architecture/structure.md`](architecture/structure.md)를 참고.

## 목차
1. [무엇을 해결하나](#1-무엇을-해결하나)
2. [핵심 개념](#2-핵심-개념)
3. [데이터 모델](#3-데이터-모델)
4. [데이터 위치와 환경변수](#4-데이터-위치와-환경변수)
5. [기능 상세](#5-기능-상세)
6. [대시보드 4뷰 가이드](#6-대시보드-4뷰-가이드)
7. [CLI 레퍼런스](#7-cli-레퍼런스)
8. [서버 엔드포인트](#8-서버-엔드포인트)
9. [보안 모델](#9-보안-모델)
10. [개발·검증(그룹개발)](#10-개발검증그룹개발)

---

## 1. 무엇을 해결하나

Claude Code · Codex는 각자 **skill / agent / 지시문**을 다른 위치·다른 포맷으로 둔다.
그래서 한 도구에서 만든 설정을 다른 도구로 옮기려면 매번 손으로 변환해야 한다.

게다가 같은 스킬·에이전트가 홈(`~/.claude` 등)과 개별 프로젝트에 흩어져 살아서, "이게 두 모델에
다 있나? 프로젝트마다 버전이 갈리진 않았나?"를 파악하기 어렵다.

AAD는 **등록 없이 모든 경로(홈 + 디스크의 프로젝트)를 자동 발견**해, 항목별로 두 모델에 걸친
**동기화 상태를 매트릭스 표**로 보여준다(경로·이름·태그·claude·codex·동기화). 어긋난 곳은
기준 도구를 골라 **한 번에 맞춘다**. 중앙 저장소(canonical)는 이제 **백업/이력용**일 뿐 화면의
주인공이 아니다 — Sync는 그 백업을 경유해 도구 간 차이를 메운다. 모든 처리는 **로컬**에서만 일어난다.

**대상 3종:**
| 트랙 | 내용 | 각 도구 산출물 |
|---|---|---|
| 지시문(instruction) | 전역/프로젝트 지침 | `CLAUDE.md` · `AGENTS.md` |
| skill | 재사용 가능한 기능 묶음 | 표준 `SKILL.md`(두 모델 공통) |
| agent | 역할 정의(프롬프트+도구) | Claude `.md` · Codex `.toml` |

> 슬래시 커맨드는 대상에서 제외한다.

---

## 2. 핵심 개념

- **동기화 매트릭스(주 화면):** 항목(스킬/에이전트) × 두 모델의 교차표. 각 셀은 그 도구·경로에 항목이 있는지(그리고 내용이 같은지)를 보여주고, 마지막 **동기화** 열이 상태를 요약한다:
  - **동기화됨** — 두 모델(존재하는 것끼리) 내용이 모두 같음.
  - **일부 없음(partial)** — 일부 도구엔 있고 일부엔 없음.
  - **불일치(drift)** — 여러 곳에 있으나 내용이 서로 다름.
  - **단독(single)** — 한 곳에만 있음.
- **경로 자동 발견:** 등록 없이 홈(`~`)과 디스크의 프로젝트를 스캔해 각 경로의 스킬·에이전트를 모은다(스코프 = `global`/`project`). 화이트리스트·거부목록을 준수한다.
- **canonical (중앙 저장소 = 백업):** Sync·pull이 경유하는 백업/이력 저장소. 항목마다 안정적 `id` + 메타(시각, 출처 도구, scope, tags)를 가지며 자체 git으로 이력을 남긴다(로컬 전용). 이제는 상태 화면의 중심이 아니다.
- **Sync (한 번에 맞추기):** 어긋난 항목에서 **기준 도구를 선택** → 그 내용을 백업(canonical)으로 가져오고 → **다른 도구 위치로 내보내기**까지 한 동작으로 수행.
- **push / pull (수동):** canonical → 도구(복사+변환) / 도구 → canonical(import). 매트릭스 Sync가 이 파이프라인을 공유한다.
- **안전 흐름 (불변):** 어떤 쓰기든 **① 미리보기(diff) → ② 명시적 적용**. 적용 전 대상 파일을 **백업**하고, `synclog`에 시각을 남긴다.
- **손실 표시:** 도구 간 포맷 차이로 옮길 수 없는 항목(예: Codex는 agent별 `tools` 필드 없음)은 **⚠ 손실**로 항상 표면화한다. 임의로 채우지 않는다.

---

## 3. 데이터 모델

canonical 항목의 공통 메타:

```jsonc
{
  "id": "instr-claude-global",           // 안정적 식별자
  "type": "instruction | skill | agent",
  "scope": "global | project",
  "source_tool": "claude | codex",  // 처음 import된 출처
  "tags": ["review", "code"],            // 자유·다중 태그
  "created_at": "...", "updated_at": "..."
}
```

- **지시문:** 일반 마크다운 본문 + 메타.
- **skill:** 표준 `SKILL.md`(YAML frontmatter `name`·`description` + 본문) **그대로**. 두 모델 본문이 동일해 "복사"로 충분.
- **agent(중립 스키마):**
  ```yaml
  name: reviewer
  description: ...
  system_prompt: ...      # 본문/instructions로 렌더
  model: opus             # 추측 금지 — 모르면 null
  tools: [Read, Grep, Bash]   # 도구 이름 매핑 대상
  mcp_servers: [...]
  source_notes: ...       # 원본 도구 특이사항 보존
  ```

**변환 규칙 요약:**

| 트랙 | canonical | → 각 도구 | 손실 |
|---|---|---|---|
| 지시문 | 마크다운 | 파일명만 변경 | 없음 |
| skill | `SKILL.md` | 각 위치로 복사(+도구별 메타 오버레이) | 없음 |
| agent | 중립 스키마 | Claude `.md` · Codex `.toml`(`developer_instructions`) | **Codex는 tools 전부 손실**(⚠로 표면화) |

(Claude↔Gemini 도구 이름 매핑 `tool-map.js`는 Gemini 지원 중단(D31)과 함께 삭제됐다.)

---

## 4. 데이터 위치와 환경변수

항상 **실제 내 파일 기준**으로 동작한다(더미/데모 모드는 D37로 제거).

| 대상 | 기본 위치 | 오버라이드 |
|---|---|---|
| 모델 홈 | `~/.claude` · `~/.codex` · `~/.agents` (+발견된 프로젝트) | — |
| canonical(중앙 백업) | `<repo>/canonical/` (플러그인 실행 시 `~/.claude/plugins/data/aad/canonical`) | `AAD_CANONICAL` |
| 적용 전 백업 | `<repo>/backups/` (플러그인 실행 시 DATA 아래) | `AAD_BACKUPS` |
| 레지스트리 캐시 | `catalog/cache/` | `AAD_REGISTRY_CACHE` |
| 서버 포트 | 4319 | `--port` |

```bash
npm run serve        # http://127.0.0.1:4319 — 바로 실제 파일 기준
```

> 오버라이드 env는 **격리 테스트용**이다(개발·검증 시 실제 canonical/백업을 건드리지 않도록
> 임시 폴더로 돌림). 실제 파일에 대한 안전은 모드가 아니라 **안전 흐름**(미리보기→적용 2단계 +
> 자동 백업)과 시크릿 거부목록이 담당한다.

---

## 5. 기능 상세

### 5.1 지시문 트랙
전역/프로젝트 지침을 두 모델에 맞춰 동기화. 변환은 **파일명만** 바뀌므로 손실이 없다.
- `pull --from <도구>`: 해당 도구의 지시문을 canonical로 가져온다.
- `push --to <도구> [--apply]`: canonical을 해당 도구로. `--apply` 없으면 diff 미리보기만.

### 5.2 스킬 트랙
표준 `SKILL.md`를 각 도구 skill 위치로 복사. 스캔 위치는 0번 검증(D11)으로 확정:
Claude는 `~/.claude/skills` + 플러그인(`plugins/**/skills`), Codex는 자기 위치 + 공유 `~/.agents/skills`.
- `skill ls`: canonical·도구의 스킬 목록(비공식 위치는 "비공식"으로 표시).
- `skill pull --name <이름>` / `skill push --to <도구> --name <이름> [--apply]`.

### 5.3 에이전트 트랙
가장 복잡한 트랙. **중립 스키마**를 두 모델 포맷으로 렌더한다.
- Claude = `.md` + frontmatter(본문 = system_prompt).
- Codex = `.toml`, 시스템 프롬프트 = `developer_instructions`, **agent별 `tools` 필드 없음** → Codex로 변환 시 tools는 전부 손실.
- `agent ls` / `agent pull --from <도구> --name <이름>` / `agent push --to <도구> --name <이름> [--apply]`.
- push 미리보기는 **diff + 도구별 손실**을 함께 보여준다.

### 5.4 태그(분류)
항목을 **자유·다중 태그**로 분류. 프리셋(`code`/`review`/`docs`/`infra`/`etc`)은 고정 분류가 아니라 **자동완성 추천**으로만 쓴다. 태그 품질이 추천(플레이그라운드) 품질을 좌우한다.
- `tags ls`: 프리셋 + 사용 중인 커스텀 태그(빈도).
- `tags set --kind <skill|agent|instruction> --id <id> --tags a,b`: 항목에 태그 지정.

### 5.5 스토어 (번들 카탈로그 + 퍼블리셔 레지스트리) — **UI 숨김 · CLI 전용(D32)**
**번들 정적 카탈로그**(`catalog/catalog.json`)의 공식/추천 스킬·에이전트를 골라 **모든 도구에 한 번에 적용**.
여기에 더해 **퍼블리셔 레지스트리**(`catalog/default-registries.json`, 70여 퍼블리셔)에서 외부 공개 스킬을 가져올 수 있다 — **토큰 없이 공개 repo를 git clone**(`registry.js`, `--depth 1`)하고, 네트워크는 **사용자가 새로고침/가져오기를 누를 때만** 동작한다(자동 폴링 없음).
- `store ls [--q 검색어]` / `store show --id <id>`.
- `store preview --id <id>`: 도구별 diff(접기 텍스트) + 변환 손실 미리보기.
- `store apply --id <id> [--resolution skip|overwrite|rename] [--name X]`: 적용. 동명 canonical이 있으면 **충돌 안내**(덮어쓰기/건너뛰기/이름변경 중 선택).
- `registry ls` / `registry add --url <git-url>` / `registry refresh [--url ...]` / `registry updates` / `registry rm --url ...`: 레지스트리 관리(공식 시드는 삭제 거부). fetch 시 태그 분류(`skill-tags.json`) 자동 적용.

### 5.6 플레이그라운드 — **UI 숨김 · CLI 전용(D32)**
질문·역할을 입력하면 **추천 → 미리보기 → 적용** 흐름으로 스킬을 찾거나 에이전트를 조합한다. **LLM 없이 휴리스틱**(태그 매칭 + 텍스트 유사도), 디스크 쓰기 없음(적용 전까지).
- 갈래 A(스킬): `pg wizard`(질문 세트) → `pg skill reco [--tags a,b] [--text "..."]`(추천·점수·이유) → `pg skill preview --id <id>` → `pg skill adopt --id <id> [--resolution ...]`.
- 갈래 B(에이전트): `pg agent compose --role "..." --pick id1,id2 [--name X]`(스킬들을 에이전트로 조합 + 미리보기) → `pg agent adopt ...`(조합 후 바로 적용). `model`은 추측하지 않는다(null).

### 5.7 사용량 (Phase 2)
스킬을 **얼마나 자주 썼는지**를 **Claude 세션 기록의 호출 횟수**(B 신호, `usagelog.js`)로 집계한다 —
세션 transcript의 tool-use 라인에서 **이름·시각만** 추출(대화 본문 미저장·미표시, D8·D33). Codex 세션은
거부목록이라 제외한다. 대시보드 사용량 뷰는 3지표 카드(지난 1일/7일/사용 이력) + 5컬럼 표
(`이름·최근 사용·지난 1일·지난 7일·전체(막대)`) + 정렬 토글(최근/사용량 순)을 보여준다(D35).
- `usage`: 스킬별 사용빈도(`{day1, day7, total}`)·최근 사용 시각(`core.usageStats()`).
- 점검(review/pending/approve/reject/archive)·중복·노후화 **제안 엔진은 존치**하나 **UI에서는 제거**했다 — CLI로만 쓴다.

### 5.8 동기화 매트릭스 · 경로 자동 발견 (주 화면, D27)
스킬·에이전트를 **경로 × 두 모델** 매트릭스로 본다. 등록 없이 홈 + 디스크 프로젝트를 자동 발견한다.
- `matrix --kind <skill|agent>`: 매트릭스 출력(경로·이름·태그·claude·codex·동기화). 상태 = 동기화됨/일부 없음/불일치/단독.
- `sync --kind <skill|agent> --name <이름> [--base <도구>] [--apply]`: 어긋난 항목을 **기준 도구** 내용으로 맞춤. `--apply` 없으면 계획(무엇을 백업으로 가져오고 어디로 내보낼지)만 미리보기.
- `projects <ls|scan|add|rm|reset|prune>`: 발견된 프로젝트 목록(`ls` — 사라진 경로는 `[없음]` 표시)/재스캔(`scan [--adopt]`)/수동 등록/해제/초기화/정리(`prune` — 디스크에서 사라진 프로젝트만 목록에서 제거). 스캔은 존재/경로만 보고 내용은 열지 않는다(화이트리스트·거부목록 준수).

### 5.9 백업 · 복구 — **복구는 CLI 전용(UI 진입점 제거)**
모든 적용은 덮어쓰기 전에 타임스탬프 백업을 자동으로 남긴다(엔진 상시 동작). 복구는 CLI로만.
- `backups ls`: 백업 목록(대상·도구·시각). `backups restore --file <백업파일>`: 복구(경로 이탈·심볼릭 링크를 코드로 차단).

---

## 6. 대시보드 4뷰 가이드

`npm run serve` → `http://127.0.0.1:4319`. **디자인 시스템 v2**(D35, Apple 스타일 — 모델색 보라·청록와
상태색 초록·앰버·회색 분리): 사이드바(256px)는 접기 버튼 또는 좁은 화면(<1000px)에서 자동으로
**아이콘 레일**(68px)이 되고, 1000–1200px에서는 스킬 폴더 패널이 표 위로 스택된다(해시 라우팅, 라이트 고정).

노출 뷰는 **4개**다(에이전트·플레이그라운드·스토어는 숨김 — 아래 참고).

| # | 뷰 | 내용 |
|---|---|---|
| 1 | **개요(Overview)** | 실행형 배너(동기화 필요 N) · 4 스탯 카드 · **동기화 상태 분해 막대**(행 클릭 → 해당 필터로 이동) · 카테고리 TOP 5(미정 제외) · **최근 사용** · **모델 커버리지**(Claude/Codex/양쪽 보유 수). |
| 2 | **지시문** | CLAUDE.md ↔ AGENTS.md **좌우 비교 전용**. 배너에 **"다른 줄 N"** 요약. 같으면 단일 본문, 다르면 좌우 diff(다른 줄=앰버, 한쪽만=빗금, 문자 하이라이트). **쓰기 UI 없음** — 지시문은 보기만(사용자 결정). |
| 3 | **스킬** | **좌측 폴더 리스트**(배지=항목 수, 폴더 검색·경로 복사) + **우측 매트릭스 표** — 모델 셀은 중립 **✓/–**(모델색은 헤더·범례에만), 상태 배지 3종(동기화됨·불일치·단독), 불일치 행 연한 앰버. 태그 **다중 OR 필터**·"미정" 칩·검색·더보기(50행). 이름 클릭 → **중앙 모달 본문 뷰어**(단일/좌우 diff). 행별·배치 **Sync**(스코프 인지: 단독=복사, 불일치=세그먼트로 기준 선택). |
| 4 | **사용량** | 3지표 카드(지난 1일/7일/사용 이력) + 표 `이름·최근 사용·지난 1일·지난 7일·전체(막대)` + 정렬 토글(최근/사용량 순). Claude 세션 호출 횟수 기준(대화 내용 미열람). |

> **에이전트·플레이그라운드·스토어 뷰는 현재 숨김(D32).** 에이전트는 Codex가 에이전트별 `tools`를
> 지원하지 않아 100% 동기화가 안 되는 동안 숨긴다. 엔진·CLI(`aad agent…`, `aad pg…`, `aad store…`)와
> API는 그대로 동작한다. 해제 조건·재설계 계획: [`plan/todo.md`](plan/todo.md).

**공통 UI 동작:**
- 스킬 이름 클릭 → **중앙 모달**(scrim·ESC·바깥클릭 닫힘): 단일 본문 또는 좌우 diff(모델 탭). 파일 경로 복사.
- 적용은 항상 **미리보기 → 적용** 2단계. 이름 충돌 시 **충돌 모달**(덮어쓰기/건너뛰기/이름변경).
- 오류 시 화면이 죽지 않고 "이슈가 생겼다" 안내 + 재시도(D26). PI 모달·백업 모달·다크모드는 제거됨.

---

## 7. CLI 레퍼런스

```
aad status                                  두 모델의 지시문 존재/drift 요약

# 동기화 매트릭스 · 경로 자동 발견 (주 화면)
aad matrix   --kind <skill|agent>
aad sync     --kind <skill|agent> --name <이름> [--base <도구>] [--apply]
aad projects <ls | scan [--adopt] [--root <path>] | add --root <path> | rm --root <path> | reset | prune>

# 지시문
aad instr sync --base <claude|codex> [--apply]   # 기준 모델로 한 방 동기화 (--apply 없으면 diff 요약)
aad pull --from <claude|codex>
aad push --to   <claude|codex> [--apply]

# 에이전트
aad agent ls
aad agent pull --from <도구> --name <이름>
aad agent push --to   <도구> --name <이름> [--apply]

# 스킬
aad skill ls
aad skill pull --name <이름> [--source-id <소스>]
aad skill push --to <도구> --name <이름> [--apply]

# 태그 + 스토어
aad tags [ls]
aad tags set --kind <skill|agent|instruction> --id <id> --tags a,b
aad store ls [--q <검색>]
aad store show    --id <id>
aad store preview --id <id>
aad store apply   --id <id> [--resolution skip|overwrite|rename] [--name X]

# 외부 스킬 레지스트리 (토큰 없는 git clone)
aad registry ls
aad registry add     --url <git-url>
aad registry refresh [--url <git-url>]
aad registry updates
aad registry rm      --url <git-url>

# 백업 · 복구
aad backups ls
aad backups restore --file <백업파일>

# 플레이그라운드
aad pg wizard
aad pg skill reco   [--tags a,b] [--text "..."]
aad pg skill preview --id <id>
aad pg skill adopt   --id <id> [--resolution ...] [--name X]
aad pg agent compose --role "..." --pick id1,id2 [--name X]
aad pg agent adopt   --role "..." --pick id1,id2 [--name X] [--resolution ...]

# Phase 2: 사용량 + 자기 점검
aad usage
aad review [--dry-run]
aad pending
aad approve --id <id> | aad reject --id <id>
aad pin --id <id> | aad unpin --id <id>
aad archive --id <id> | aad restore --id <id>

# 서버
aad serve [--port 4319]
aad help
```

> `--apply`(또는 store/pg의 명시적 적용)가 있어야 실제 쓰기가 일어난다. 그 전에는 항상 diff 미리보기만.

---

## 8. 서버 엔드포인트

`serve.js`는 `127.0.0.1`에만 바인딩하고, 각 엔드포인트는 대응 `core.js` 함수를 **호출만** 한다.

| 메서드·경로 | 하는 일 |
|---|---|
| `GET /`, `/app.js`, `/design-system.css` | 대시보드 정적 자산 |
| `GET /overview` | 개요 뷰 데이터 |
| `GET /matrix?kind=` | 동기화 매트릭스(경로 자동 발견 포함) |
| `POST /sync/plan` · `POST /sync/apply` | 매트릭스 항목 동기화(계획/적용) |
| `GET /projects` · `POST /projects/scan` · `/projects/adopt` · `/projects/add` · `/projects/remove` · `/projects/reset` · `/projects/prune` | 프로젝트 발견·등록·정리(`prune`=사라진 폴더 제거) |
| `GET /instr/matrix` · `POST /instr/sync` | 지시문 3파일 비교 매트릭스 / 기준 모델 동기화(D30) |
| `GET /diff` · `POST /pull` · `POST /push` | 지시문 트랙 |
| `GET /agents/overview` · `/agents/diff` · `POST /agents/pull` · `/agents/push` | 에이전트 트랙 |
| `GET /skills/overview` · `/skills/diff` · `POST /skills/pull` · `/skills/push` | 스킬 트랙 |
| `GET /tags` · `POST /tags/set` | 태그 |
| `GET /store` · `/store/item` · `/store/preview` · `POST /store/apply` | 스토어 |
| `GET /publishers` · `/registries` · `/registries/updates` · `/registries/collect-status` · `POST /registries/add` · `/registries/refresh` · `/registries/remove` | 퍼블리셔·레지스트리(수집 상태는 D28 증분 수집) |
| `GET /backups` · `POST /backups/restore` | 백업 목록·복구 |
| `GET /item/content?kind=&name=&scope=&tool=` | 스킬/에이전트 **본문**(중앙 모달 뷰어용) |
| `GET /playground/catalog` · `/playground/skill/wizard` | 플레이그라운드(읽기) |
| `POST /playground/skill/recommend|preview|adopt` · `/playground/agent/recommend|compose|preview|adopt` | 플레이그라운드(동작) |
| `GET /usage` · `/synclog` · `/pending` · `POST /review` · `/approve` · `/reject` · `/pin` · `/archive` · `/restore` | Phase 2 |

`POST` 중 실제 쓰기(`push`/`apply`/`adopt`/`approve`/`archive` 등)는 전부 기존 guarded 경로를 거쳐 백업·synclog를 자동 상속한다.

---

## 9. 보안 모델

자세한 규칙은 [`security/security.md`](security/security.md)와 점검 결과 [`security/security-check.md`](security/security-check.md).

- **로컬 우선.** 상태 파악·동기화는 전부 로컬. 유일한 네트워크는 스토어 레지스트리 clone인데 **사용자 트리거에서만** 동작한다 — 새로고침/가져오기 버튼, 그리고 **앱 실행 시 1회 증분 수집**(D28: 실행 = 사용자 트리거, 미수집분만·자동 폴링 없음). `AAD_ALLOW_NET` 같은 별도 게이트는 D25로 제거. canonical git은 로컬(원격 push는 회사/개인 계정 확인 후 별도 승인).
- **스캔 화이트리스트만.** `skills/`·`agents/`·지정 지시문·플러그인 skills만 본다.
- **시크릿 거부목록(절대 수집·커밋 금지).** `auth.json`·`oauth_creds.json`·`*.sqlite`·`sessions/`·`history.jsonl`·`.env`·`*.key`·`*.pem` 등. canonical `.gitignore`로도 차단.
- **하이브리드 읽기(D9).** 존재/파일명만 자동 스캔, **내용·drift는 사용자가 클릭한 항목만** 읽는다.
- **PI 게이트 제거(D33).** 로컬 전용·본인 열람이라 본문 개인정보 확인 게이트는 없앴다. 시크릿 거부목록·화이트리스트는 그대로 강제된다.
- **충돌 해결.** 동명 canonical이 있으면 덮어쓰기/건너뛰기/이름변경을 사용자가 고른다.
- **쓰기 경로 단일화.** 모든 적용은 기존 push 파이프라인 경유 → 모드 가드·백업·synclog 자동 상속. 우회 쓰기 경로를 새로 만들지 않는다.

---

## 10. 개발·검증(그룹개발)

이 프로젝트는 **"그룹개발"** 방법론으로 개발한다 — 계획 → 서브에이전트 위임(독립=병렬) → **각 작업마다 `dev-verifier`** → **마지막에 `project-verifier`**. 검증 에이전트는 읽기 전용(Edit/Write 없음)이라 "판단만, 수정 안 함"이 도구 차원에서 강제된다.

- 방법론: [`process/group-dev.md`](process/group-dev.md)
- 검증 에이전트: `.claude/agents/dev-verifier.md`, `.claude/agents/project-verifier.md`
- 결정 로그: [`decision/decision.md`](decision/decision.md) (D20)
