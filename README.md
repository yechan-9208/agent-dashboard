# AI-Agent Dashboard (AAD)

> **Claude Code · OpenAI Codex** 두 모델의 skill / 지시문(instruction)이
> 내 컴퓨터 곳곳(홈 `~` + 각 프로젝트)에서 **서로 동기화돼 있는지 한눈에 보고, 한 번에 맞추는**
> **로컬 전용(127.0.0.1)** 대시보드.

두 CLI는 설정 파일의 위치와 포맷이 제각각이고, 같은 스킬이 홈(`~/.claude` 등)과 개별
프로젝트에 흩어져 산다. AAD는 **등록 없이 모든 경로를 자동으로 발견**해 두 모델에 걸친
**동기화 상태를 매트릭스**로 보여주고, 어긋난 곳은 기준 모델을 골라 **미리보기(diff) → 적용**
2단계로 맞춘다. 외부로는 아무것도 전송하지 않는다.

- **기능·사용 가이드:** [`docs/guide.md`](docs/guide.md)
- **모듈 구조·데이터 모델:** [`docs/architecture/structure.md`](docs/architecture/structure.md)
- **기술 선택과 근거:** [`docs/architecture/tech-stack.md`](docs/architecture/tech-stack.md)


## 실행 방법

```bash
/plugin marketplace add yechan-9208/agent-dashboard
/plugin install aad@aad
/aad:serve                               # 서버 실행 + 브라우저 자동 열기 (최초 실행 시 의존성 자동 설치)
/aad:stop                                # 서버 종료
```

백업(canonical)·프로젝트 목록·의존성은 플러그인 업데이트에도 살아남는 영속 폴더
`~/.claude/plugins/data/aad/`에 저장된다. 업데이트 배포는 `.claude-plugin/plugin.json`의
`version`을 올려서 push.

### 방법 2 — 직접 실행

```bash
npm install                    # 의존성 설치 (최초 1회, 2개뿐)
npm run serve                  # → http://127.0.0.1:4319
```

CLI로도 같은 기능을 쓸 수 있다:

```bash
node bin/aad.js matrix --kind skill    # 스킬 동기화 매트릭스
node bin/aad.js status                 # 지시문 상태
node bin/aad.js help                   # 전체 명령 목록
```

항상 **실제 내 파일**을 대상으로 동작하며, 첫 실행 시 홈(`~`)과 디스크의 프로젝트들을
자동으로 훑어 발견한다(등록 불필요). 모든 쓰기는 미리보기 → 적용 2단계 + 자동 백업.

---

## 폴더 구조

```
agent-dashboard/
├── bin/aad.js            # CLI 진입점 — 명령 파싱 후 cli/core.js 호출
├── cli/                  # ★ 모든 로직의 단일 소스 (core.js + 기능 모듈)
│   ├── core.js           #   명령 로직 집합점 — 데이터만 반환(출력 없음)
│   ├── security.js       #   🔒 시크릿 거부목록 (절대 읽지 않는 파일)
│   ├── paths.js          #   두 모델의 설정 경로 정의
│   ├── scanner.js        #   경로 자동 발견 (존재만 — 내용은 클릭 시에만)
│   ├── projects.js       #   프로젝트 레지스트리 (스캔·등록·정리)
│   ├── canonical.js      #   중앙 백업 저장소 읽기/쓰기
│   ├── transform/        #   모델별 포맷 변환 (instructions·skill·agent)
│   ├── diff.js           #   라인 diff + 좌우(side-by-side) 정렬
│   ├── backup.js         #   덮어쓰기 전 백업 + 복구
│   ├── usagelog.js       #   사용빈도 — Claude 세션 기록의 호출 횟수만 집계
│   └── …                 #   category·search·store·registry 등 (structure.md 참고)
├── server/serve.js       # 127.0.0.1 전용 얇은 HTTP 서버 — core 호출만
├── dashboard/            # 프런트엔드 SPA (빌드 없음 — 바닐라 JS)
│   ├── index.html        #   앱 셸 (사이드바 + 4뷰 섹션)
│   ├── app.js            #   해시 라우터 + fetch + 단일 클릭 위임
│   └── design-system.css #   디자인 시스템 v2 (Apple 스타일, D35)
├── canonical/            # 중앙 백업 (자체 git, 로컬 전용 — repo에 미포함)
├── catalog/              # 스토어 시드 데이터 (엔진 존치, UI 숨김)
├── .claude-plugin/       # 플러그인 배포 정의 (plugin.json + marketplace.json)
├── commands/             # 플러그인 슬래시 커맨드 (/aad:serve · /aad:stop)
├── scripts/              # 플러그인 실행 스크립트 (serve/stop 셸)
├── docs/                 # 문서 (아래 문서 맵)
└── package.json          # 의존성 2개: gray-matter · @iarna/toml
```

### 문서 맵 (`docs/`)

| 위치 | 내용 |
|---|---|
| [`guide.md`](docs/guide.md) | **기능·사용 가이드** — 시작점 |
| [`architecture/structure.md`](docs/architecture/structure.md) | 모듈 구조 · 데이터 모델 · API |
| [`architecture/tech-stack.md`](docs/architecture/tech-stack.md) | 언어·도구 선택과 **근거**(대화 기반) |
| [`decision/decision.md`](docs/decision/decision.md) | 결정 로그 D1~D36 (모든 "왜"의 원본) |
| [`security/`](docs/security/) | 보안 규칙 + 점검 결과(코드 가드) |
| [`design/`](docs/design/) | 현행 디자인 목업(AAD-Redesign, D35 권위 소스) |
| [`process/group-dev.md`](docs/process/group-dev.md) | "그룹개발" 방법론 (계획→위임→검증) |
| [`verification/`](docs/verification/) | "0번 검증" 보고서 — 구현 전 공식 포맷·실신호 확인 |
| [`plan/todo.md`](docs/plan/todo.md) | 남은 일 (에이전트 뷰 복원 조건 등) |
| [`lagacy/`](docs/lagacy/) | 이전 결정 기준의 과거 문서 보관소 (현행 아님) |

---

## 핵심 원칙

1. **로컬 전용.** 외부로 아무것도 전송하지 않는다. 서버는 `127.0.0.1`에만 바인딩.
2. **단일 로직 소스.** 모든 로직은 `cli/core.js` — 서버·CLI는 호출만 한다.
3. **안전 흐름.** 모든 쓰기는 미리보기(diff) → 명시적 적용 2단계 + 적용 전 자동 백업.
4. **시크릿 불가침.** 인증정보·DB·세션 로그 등 거부목록은 절대 스캔·수집·커밋하지 않는다.

**현재 노출 뷰:** 개요 · 지시문 · 스킬 · 사용량 — 2모델(Claude·Codex) 체제.
(에이전트·플레이그라운드·스토어는 엔진/CLI만 존치, UI 숨김 — [`docs/plan/todo.md`](docs/plan/todo.md))
