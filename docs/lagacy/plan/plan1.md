# AI-Agent Dashboard — Claude Cowork 작업 지시서
## 1단계: 모델 Sync + 대시보드

너는 macOS 로컬 환경에서 동작하는 **AI 에이전트 설정 동기화 대시보드**를 만든다.
나는 Claude Code, OpenAI Codex, Google Gemini CLI 세 도구를 함께 쓰는데, 각 도구의
skill / agent(subagent) / 지시문 파일이 위치와 포맷이 달라서 한 도구에서 만든 걸
다른 도구에서 못 쓰는 불편이 있다. 이걸 한곳에서 보고 동기화하는 게 목표다.

---

## 0. 가장 먼저 할 일 — 실제 환경 탐색 (추정 금지)

본격 구현 전에, 아래 **두 출처를 모두 확인**하고 결과를 보고하라.

1. **내 실제 macOS 파일 시스템을 직접 검사** — 존재하는 디렉토리·파일을 열어 구조를 확인.
2. **각 도구의 최신 공식 문서를 직접 확인** — 경로·포맷이 빠르게 바뀌므로, 아래 경로/포맷 정보(2026년 6월 기준 조사 결과)를 그대로 믿지 말고 현재 공식 문서로 다시 확인하라. (시작점은 2번 섹션의 공식 문서 링크. 거기서 최신 페이지로 따라가라.)

추정하지 말고 위 두 출처로 확인한 뒤 진행하라. 특히 아래는 **반드시 직접 확인**:

- Gemini CLI의 **skill** 디렉토리 정확한 위치
- Codex **agent(.toml)** 의 실제 스키마/필드 (공식 문서가 "포맷이 진화 중"이라고 명시함)
- 각 도구의 **내장 도구(tool) 이름** 목록 — 특히 Codex
- 세 도구 각각의 실제 설치 여부와 설정 홈 디렉토리

**보고할 때 반드시 포함하라:**
- **확인 결과 표** — 기기에서 찾은 실제 경로/포맷.
- **참고한 공식 문서 링크 목록** — 어떤 항목을 어느 URL에서 확인했는지 매칭해서 적어라. 출처를 밝혀 내가 직접 검증할 수 있게 한다.
- 조사 결과(이 문서)와 다른 점. 불일치가 있으면 내게 질문한 뒤 다음 단계로 넘어가라.

---

## 1. 핵심 설계 결정 (이미 확정됨)

- **동기화 구조**: canonical source(중앙 원본) 1벌을 두고 → 각 도구로 **복사 + 변환(copy & transform)**.
  심볼릭 링크 아님. 도구별 사본을 생성·관리한다.
- **MVP 범위**: "보기"와 "sync"를 **둘 다** 1단계에 포함.
- **대상**: skill, agent(subagent), 지시문 파일(CLAUDE.md / AGENTS.md / GEMINI.md).
  슬래시 커맨드는 이번 범위에서 **제외**.
- **OS**: macOS.
- **아키텍처: CLI 코어 + 얇은 로컬 서버(click-bridge)**. 네 부분으로 구성한다:
  (1) **git으로 버전 관리되는 canonical 폴더**(중앙 저장소).
  (2) **CLI 도구** — 스캔·변환·sync·import·drift 계산 등 **모든 로직의 단일 소스**.
  (3) **얇은 로컬 HTTP 서버** — `127.0.0.1`에만 바인딩. 로직을 새로 구현하지 말고, 엔드포인트가 CLI 하위 명령을 그대로 실행해 결과(diff 포함)를 돌려주는 **다리** 역할만 한다.
  (4) **대시보드(HTML)** — 이 서버가 제공하고, 버튼이 엔드포인트를 호출한다.
  무거운 백엔드/외부 노출 서버는 만들지 마라. 서버가 떠 있지 않아도 읽기 전용 보기는 동작하도록(정적 빌드) 만든다.
- **언어**: 자유. 마크다운/TOML 변환·템플릿에는 Python(pyyaml, tomllib/tomli-w, jinja2)이 편하다. Node·Go도 무방.
- **UI 외형**: 대시보드 HTML의 스타일은 별도로 Claude Design으로 만들 예정이므로, 너는 **데이터를 채우는 HTML 템플릿 + 동작하는 기능**까지만. 화려한 스타일링보다 구조·정확성에 집중.
- **로컬 전용**: 어떤 데이터도 외부로 전송하지 않는다.

---

## 2. 대상 파일 위치 (확인 후 사용 — 0번에서 검증할 것)

| 타입 | Claude Code | Codex (OpenAI) | Gemini CLI |
|---|---|---|---|
| skill | `~/.claude/skills/`, `<repo>/.claude/skills/` | `~/.codex/skills/` 또는 `<repo>/.agents/skills/` *(둘 중 어느 쪽인지 확인)* | **확인 필요** (예상: `~/.gemini/` 하위) |
| agent | `~/.claude/agents/*.md`, `<repo>/.claude/agents/*.md` | `~/.codex/agents/*.toml` | `~/.gemini/agents/*.md`, `<repo>/.gemini/agents/*.md` |
| 지시문 | `~/.claude/CLAUDE.md` + 프로젝트 `CLAUDE.md` | `~/.codex/AGENTS.md` + 프로젝트 `AGENTS.md` | `~/.gemini/GEMINI.md` + 프로젝트 `GEMINI.md` |

참고 공식 문서:
- Claude subagents: https://code.claude.com/docs/en/sub-agents
- Codex subagents: https://developers.openai.com/codex/subagents
- Codex AGENTS.md: https://developers.openai.com/codex/guides/agents-md
- Gemini subagents: https://geminicli.com/docs/core/subagents/
- Agent Skills 표준: https://agentskills.io/specification

---

## 3. Canonical 저장소 설계

별도의 중앙 저장소를 **git 저장소로** 만든다 (버전 관리·롤백·diff를 git이 그대로 제공):

```
~/ai-agent-dashboard/canonical/
├── skills/         # 표준 SKILL.md 폴더들 (이미 공통 표준이므로 그대로)
├── agents/         # 중립 스키마 파일들 (YAML 또는 JSON)
└── instructions/   # 일반 마크다운 (프로젝트/글로벌 단위)
```

- **skill의 canonical = 표준 `SKILL.md`** 자체. (agentskills.io 표준이 이미 세 도구 공통이라 별도 중립 포맷 불필요)
- **agent의 canonical = 중립 스키마**. 최소 필드:
  `name, description, system_prompt, model, tools[], mcp_servers[], (옵션) temperature, max_turns` + `source_notes`(원본 도구별 특이사항 보존용).
- **지시문의 canonical = 일반 마크다운** + 어느 스코프(글로벌/프로젝트)인지 메타.

각 canonical 항목에는 안정적인 `id`와 메타데이터(생성/수정 시각, 원본 출처 도구)를 남겨라.
(2단계에서 사용 빈도 추적을 붙일 수 있게 미리 식별자를 확보해 두는 것)

---

## 4. 변환 규칙 (트랙별)

### 트랙 A — skill
- canonical `SKILL.md` → 각 도구의 skill 위치로 **복사**.
- 핵심 본문(YAML frontmatter의 name·description + 마크다운 본문)은 **세 도구 동일**.
- 도구별 **메타데이터 확장만 오버레이**:
  - Claude: `context: fork`, `skills:`, `disable-model-invocation` 등 (필요 시)
  - Codex: `openai.yaml` 류 메타데이터 (실제 형식 확인)
  - Gemini: 해당 도구 고유 메타 (확인)
- 표준 코어를 깨지 않도록, 확장 필드는 항상 분리해서 관리.

### 트랙 B — agent (subagent)
중립 스키마 → **렌더러 3개**로 각 도구 포맷 생성:

- **Claude** (`.md`): YAML frontmatter(`name, description, tools, model`) + 본문 = system_prompt
- **Gemini** (`.md`): Claude와 거의 동일 구조 (frontmatter + 본문 = system_prompt)
- **Codex** (`.toml`): `instructions` 필드 = system_prompt, `model` 등 매핑 (실제 스키마 확인 후)

추가 처리:
- **도구 이름 매핑 테이블 적용** (아래 6번). 예: Claude `Read` ↔ Gemini `read_file`.
- **대응되는 도구·필드가 없으면** 변환 결과에 `⚠ 미지원/손실` 로 표시하고, 어떤 항목이 빠졌는지 사용자에게 보여줘라. 임의로 비슷한 걸 채워 넣지 말 것.
- Claude ↔ Gemini는 포맷이 거의 같으니 우선 정확히 맞추고, Codex(TOML)는 변환 + 손실 표시를 신중히.

### 트랙 C — 지시문 파일
- canonical 마크다운 → **파일명만 바꿔** 각 위치에 기록:
  `CLAUDE.md` / `AGENTS.md` / `GEMINI.md`.
- 글로벌/프로젝트 스코프를 구분해서 올바른 위치에 쓴다.

---

## 5. 대시보드 기능 (MVP)

대시보드는 `serve` 명령으로 띄운 **얇은 로컬 서버**(127.0.0.1)가 제공하며, 모든 버튼은 그 서버의 엔드포인트를 호출하고 서버는 해당 **CLI 하위 명령을 실행**해 결과를 돌려준다. 같은 CLI 명령은 터미널에서도 그대로 쓸 수 있어야 한다(서버는 다리일 뿐).

**보기(View)**
- 세 도구 × 세 타입의 모든 항목을 한 화면에 통합 표시. 각 항목이 **어느 도구에 존재/부재**인지, canonical과 **차이(drift)** 가 있는지 한눈에. skill/agent/지시문 필터.
- "새로고침" 버튼 → `status`(또는 `build`)를 호출해 현재 상태를 다시 읽는다.
- 서버가 떠 있지 않을 때를 대비해, `build`로 **읽기 전용 정적 HTML**도 생성 가능해야 한다(파일로 열기).

**Import (최초 채우기) — `pull`**
- 각 도구에 흩어져 있는 기존 항목을 canonical로 가져온다(역방향). 같은 이름이 여러 도구에 있으면 충돌을 보여주고 사용자가 선택하게 한다.

**Sync (클릭-투-싱크) — `push`**
- 항목·대상 도구 선택 후 **"미리보기" 클릭 → 서버가 `push --dry-run` 실행 → 변환 결과(diff)를 화면에 표시.**
- 사용자가 **"적용" 버튼을 한 번 더 눌러야** 서버가 실제 `push`를 실행한다. (미리보기 없이 바로 적용 금지)
- `status`로 canonical ↔ 배포본의 drift를 언제든 확인.

**안전장치 (중요)**
- canonical 쪽 이력·롤백은 **git이 담당**(commit/diff/revert).
- 각 도구에 **배포된 파일은 git 밖**이므로, 덮어쓰기 전 그 파일을 **백업**(예: 타임스탬프 백업 폴더)한 뒤 쓴다. 잘못 쓰면 백업에서 복구.
- 클릭이든 명령이든 **dry-run → diff → 명시적 적용**을 반드시 거쳐야 실제 파일에 반영된다.
- 서버는 `127.0.0.1`에만 바인딩하고 외부에 노출하지 않는다.

---

## 6. 도구 이름 매핑 (초안 — 0번에서 보강할 것)

세 도구의 내장 도구 이름이 다르다. 아래는 시작점이며, 각 도구 문서/기기에서 확인해 완성하라.
대응이 불확실하거나 없는 항목은 매핑하지 말고 "미확인/미지원"으로 둬라.

| 의미 | Claude | Gemini | Codex |
|---|---|---|---|
| 파일 읽기 | `Read` | `read_file` | *(확인)* |
| 파일 검색/패턴 | `Glob` | `glob` | *(확인)* |
| 내용 검색 | `Grep` | `search_files` | *(확인)* |
| 파일 쓰기/수정 | `Write`, `Edit` | *(확인)* | *(확인)* |
| 셸 실행 | `Bash` | *(확인)* | *(확인)* |
| 웹 검색 | `WebSearch` | `web_search` | *(확인)* |
| 웹 가져오기 | `WebFetch` | *(확인)* | *(확인)* |
| 와일드카드 | (해당 없음) | `*`, `mcp_*`, `mcp_<server>_*` | *(확인)* |

---

## 7. 산출물

- **CLI 도구** (`build`/`push`/`pull`/`status`/`serve` 등) + **얇은 로컬 서버(`serve`)** + **대시보드(HTML)** + **git으로 초기화된 canonical 저장소**.
- 실행 방법을 담은 `README` (의존성 설치, 각 명령 사용법, `serve`로 대시보드 띄우는 법, 정적 빌드로 여는 법).
- 명확한 코드 구조 (스캐너 / canonical 로직 / 변환 렌더러 / CLI / 얇은 서버 / 대시보드 분리). 서버는 CLI를 호출하는 **다리**일 뿐 로직을 중복 구현하지 않는다. `127.0.0.1` 전용, 외부 노출 금지.
- 0번 환경 탐색 결과 보고서.

---

## 8. 이번 범위 밖 (2단계에서 진행 — 지금 만들지 말 것)

- **사용 빈도 추적** 및 **자동 강화/버전 관리** (Hermes 스타일 self-improvement).
- 단, 위 3번처럼 **각 항목에 id·메타데이터를 남겨** 나중에 usage telemetry를 붙일 수 있게만 해 둘 것.

---

## 9. 작업 방식

- 0번(환경 탐색) → 보고 → 내 확인 후 본 구현 시작.
- 큰 결정(특히 확인 필요 항목에서 예상과 다른 게 나오면)은 임의로 정하지 말고 내게 물어봐라.
- 파괴적 동작(파일 덮어쓰기/삭제)은 항상 백업·미리보기·명시적 승인을 거친다.