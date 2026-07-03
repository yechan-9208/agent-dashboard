# 보안 점검 결과 & 가드레일

기준 문서: [`security.md`](security.md). 이 프로젝트가 **시크릿 바로 옆 디렉토리를 스캔**하므로,
설계·구현 단계에서 지켜야 할 규칙과 점검 결과를 여기 정리한다. 마일스톤마다 아래
**자가 점검 체크리스트**를 다시 돌리고 결과를 갱신한다.

최근 점검일: **2026-06-30** / 결과: **현재 준수 ✅**

**슬라이스 1(지시문 트랙) 자가 점검 통과 (2026-06-30):**
- 개발은 `fixtures/`의 더미 파일로만 진행, 실제 개인 파일 미접근.
- canonical git 추적 파일 = `.gitignore` + `instructions/instr-global.{md,meta.json}` 뿐 (시크릿·배포본·세션로그 미추적 확인).
- PI 게이트 동작 확인: 더미 이메일 감지 시 CLI는 종료코드 2로 차단, 서버는 HTTP 409 반환, `--pi-ack mask`로 `****` 마스킹 확인.
- 모든 쓰기는 미리보기(diff)→`--apply` 2단계, 덮어쓰기 전 `backups/<타임스탬프>/`에 백업.

**Phase 3(분류·스토어·플레이그라운드) 자가 점검 통과 (2026-06-30):**
- 개발·검증 전부 **더미 모드**(검증 로그에서 `mode=dummy / realAllowed=false` 반복 확인). 실제 개인 파일 미접근.
- **서브에이전트 코드 가드 준수(D13 재발 방지):** 독립 작업(diff/search/태그모델)·엔진(playground)·배선을 서브에이전트로 분담하되, **각 프롬프트에 보안 클로즈**(더미 전용·`AAD_ALLOW_REAL` 금지·실제 설정파일 열기 금지·배정 파일만·`mode.js`/`paths.js` 가드 불변)를 명시. 통합 시 **mtime로 배정 외 파일(특히 가드) 미변경 확인** — 배선 에이전트는 `cli/` 한 줄도 안 건드림.
- **새 쓰기 경로 없음:** 스토어/플레이그라운드 적용은 전부 기존 `skillPush`/`agentPush` 경유 → 모드 가드·백업·`synclog` 자동 상속. 미리보기는 canonical 미기록(읽기/렌더만). 실제 CLI 실행은 미구현(`playground.tryRun`은 `realAllowed()` 게이트+throw).
- **카탈로그는 정적·로컬:** `catalog/catalog.json`(외부 통신 0). 본문은 더미 안전 콘텐츠라 PI 위험 낮음(PI 게이트는 사용자 실제 파일 import 전용으로 유지).
- 거부목록 패턴이 추적/커밋되지 않음 재확인(`.dummy/canonical` ls-files clean). 원격 push 없음.
- **차용 출처·라이선스:** 레퍼런스 비교 반영분은 코드 복사가 아닌 **개념 차용**(다른 스택). 출처 = `other_github/skills-manage`(**Apache-2.0**), `skills-manager2`(**MIT**) → 산출물 NOTICE/주석에 표기 권장.

---

## 1. security.md 항목 대비 점검

| 보안 항목(금지) | 이 프로젝트에서의 위험 | 현재 상태 |
|---|---|---|
| 사내 제품 소스·하드웨어 제어 코드 | 회사 레포의 프로젝트 지시문(CLAUDE/AGENTS.md)에 사내 정보가 있을 수 있음 | 현재 스캔 안 함. 스캔 시 PI 게이트 적용 |
| 고객·입찰·계약 등 영업비밀 | 지시문/세션 로그에 섞일 수 있음 | canonical 미반영, 로그 본문 미수집 |
| API 키·비밀번호·토큰·`.env` 등 시크릿 | 스캔 대상 폴더 옆에 인증 파일 존재(아래) | **거부목록으로 차단** |
| 고객·임직원 개인정보 | Gemini 계정정보·세션 내용 | **거부목록 + PI 게이트** |

| 보안 항목(권장) | 적용 방식 |
|---|---|
| 민감하지 않은 대표 자료·가명/더미 사용 | 데모·테스트는 더미 항목으로. 사내 비밀 든 지시문은 가명 권장 |
| 검증 안 된 외부 AI에 사내 자료 금지 | **Cowork(=AI)가 스캔하면 그 내용이 AI 컨텍스트에 들어감** → 사내 비밀 든 항목은 PI 게이트에서 사용자 확인 |
| 제출 전 금지항목 혼입 확인 후 공유 | 원격 push 전 점검(현재 슬라이스는 로컬 전용이라 미해당) |
| AI 출력 검증 | 변환 결과는 항상 dry-run diff로 사람이 확인 후 적용 |

## 2. 환경에서 실제로 확인된 "시크릿 인접 파일" (거부목록 근거)

읽기 전용 확인 결과, 스캔 대상 폴더 옆에 다음이 존재한다(**내용은 열지 않았음**):

- 🔴 인증정보: `~/.codex/auth.json`, `~/.gemini/oauth_creds.json`
- 🟡 계정/개인정보: `~/.gemini/google_accounts.json`, `~/.gemini/google_account_id`
- 🟡 DB/상태: `~/.codex/*.sqlite` (goals/logs/memories/state), `~/.codex/sqlite/`, `~/.codex/memories`
- 🟡 세션/이력: `~/.codex/sessions/`, `~/.codex/archived_sessions/`, `~/.codex/session_index.jsonl`, `*/history.jsonl`, `~/.claude/projects/*/*.jsonl`, `~/.gemini/tmp/*/chats/`
- ⚠️ 검토 필요: `~/.gemini/settings.json`(API 키 포함 가능) → 스캔 대상 아님(지시문/skill/agent만 봄)

## 3. 강제 가드레일 (구현에 반영)

**(1) 화이트리스트 스캔만** — 아래만 읽는다. 그 외 경로는 쳐다보지 않는다.
- 지시문: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` + 프로젝트별 동일 파일
- skill: `~/.claude/skills/`, `~/.claude/plugins/*/skills/`, `~/.codex/skills/`, (Gemini skill 위치는 0번에서 확인)
- agent: `~/.claude/agents/`, `~/.codex/agents/`, `~/.gemini/agents/` + 프로젝트별

**(2) 거부목록 + canonical `.gitignore`** — 2번의 파일/패턴은 절대 수집·커밋 금지:
```
auth.json
oauth_creds.json
google_accounts.json
google_account_id
*.sqlite
*.sqlite-shm
*.sqlite-wal
sessions/
archived_sessions/
*history.jsonl
*.session
.env
*.key
*.pem
```

**(3) 개인정보 확인 게이트 (D7)** — 스캔한 항목 본문에서 개인정보/시크릿 의심 패턴
(이메일·전화·주민번호 형태·토큰/키 형태·`secret`/`password` 키워드 등)을 만나면,
**canonical 반영·AI 처리 전에 멈추고 사용자에게 확인**한다(가명 대체 / 제외 / 그대로 중 선택).

**(4) 로컬 전용** — canonical git은 로컬에만. 원격 push는 회사/개인 계정 확인 후 별도 승인(D5).

**(5) Phase 2 호출 로그** — 사용량은 **호출 횟수만** 집계. 세션 로그 본문은 저장·표시·커밋하지 않는다.

**(6) 실데이터 개발 전환 (2026-07-02 오후 지시, D24 — 같은 날 오전의 "더미 전용" 지시를 대체)** —
더미와 실데이터의 개발 sync 불일치 때문에, **개발·검증은 실제 로컬을 대상으로** 한다(개발 명령에
`AAD_ALLOW_REAL=1` 사용 허용). 더미 fixtures는 더 이상 관리하지 않는다(파일은 잔존, 격리 테스트용).
단 아래는 **불변**:
- 🔒 거부목록 절대 접근 금지(auth.json/oauth_creds.json/*.sqlite/sessions//history.jsonl/.env/*.key/*.pem).
- 🔒 **대화·보고·로그에 실제 파일 본문·개인정보·토큰을 싣지 않는다** — 이름/개수/경로/구조 요약만, 필요 시 마스킹.
- 🔒 화이트리스트(skill/agent/지시문)만 스캔.
- 🔒 **실제 홈에 대한 쓰기 테스트 금지** — 적용(push/apply/adopt/sync) 실행은 사용자 몫(백업+2단계 유지).
  에이전트 쓰기 검증은 scratchpad 격리 홈(`AAD_FIXTURES`/`AAD_CANONICAL` 오버라이드)에서만.
- 🔒 네트워크 호출은 **사용자 트리거 동작에서만**(레지스트리 새로고침/업데이트 버튼 — 자동 폴링 없음). `AAD_ALLOW_NET` 옵트인은 D25로 제거됨. canonical git 로컬 전용. `mode.js` 코드 가드는 앱 안전장치로 유지.

## 3.5. 인시던트 기록 & 강제 가드 (2026-06-30)

- **인시던트:** Phase 2 telemetry 서브에이전트가 "더미만" 지시를 어기고 실제 모드로 `~/.claude/CLAUDE.md` 등을 `canonical/`(+git 히스토리)로 pull. 로컬 전용이라 외부 유출 없음. 서브에이전트가 실제 지시문을 컨텍스트로 읽음.
- **조치:** `canonical/` git 재초기화(실제 데이터·히스토리 제거) + **실제 모드 옵트인 가드**(`AAD_ALLOW_REAL=1` 없으면 실제 모드 전환 불가).
- **교훈(강제 규칙):**
  - 🔒 **실제 데이터 접근은 코드 가드로 강제** — 서브에이전트/헤드리스/실수가 실제 모드로 못 들어간다. 옵트인은 사용자가 직접 켤 때만(`AAD_ALLOW_REAL=1`).
  - 🔒 **서브에이전트 실행 시 보안 지시를 코드로 보장** — 프롬프트 지시에만 의존하지 않는다.
  - 🔒 더미 전용 canonical(`.dummy/canonical`)과 실제 canonical(`canonical/`)을 분리 관리.

## 4. 마일스톤 자가 점검 체크리스트 (매번 재실행)

- [ ] 새로 추가한 스캔 경로가 **화이트리스트 안**인가?
- [ ] canonical `.gitignore`가 거부목록을 모두 막는가? (`git -C canonical status`로 시크릿 미추적 확인)
- [ ] PI 게이트가 의심 항목에서 실제로 멈추는가?
- [ ] 데모/테스트에 실제 사내 자료 대신 더미를 썼는가?
- [ ] 원격으로 나가는 동작이 있는가? 있다면 계정 확인 + 사용자 승인 받았는가?
- [ ] AI(나)가 읽은 내용에 사내 비밀이 섞이지 않았는가?

---

**(7) 더미/데모 모드 제거 (2026-07-03, D37)**
사용자 결정("이제는 바로 실제 파일 기준 · 데모 모드도 없애자")으로 `cli/mode.js`(AAD_ALLOW_REAL
옵트인 게이트)·`fixtures/`·`.dummy/`·`/mode` 라우트·demo 스크립트를 전부 제거했다. 위 기록들에
나오는 "더미 모드 전용" 검증 규칙은 **"격리 환경 전용"으로 대체**된다 — 쓰기 검증은
`AAD_CANONICAL`/`AAD_BACKUPS`를 임시 폴더로 돌린 상태 + 임시 포트에서만 하고, 실제 파일 안전은
안전 흐름(미리보기→적용 2단계 + 자동 백업)과 시크릿 거부목록(불변)이 담당한다.
