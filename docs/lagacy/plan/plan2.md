# AI-Agent Dashboard — Claude Cowork 작업 지시서
## 2단계: 사용량 추적 + 자기 점검 유지보수

**(전제)** 1단계(canonical 저장소 + CLI + 얇은 로컬 서버 + 대시보드)가 이미 구축돼 있다.
2단계는 그 위에 **사용량 추적**과, **사용량·편집 패턴 기반 유지보수 제안(자기 점검)** 을 더한다.
1단계에서 각 canonical 항목에 남겨둔 `id`·메타데이터를 그대로 활용한다.

**핵심 철학 두 가지**
- 이 대시보드는 작업을 직접 수행하는 에이전트가 아니라 **바깥에서 관찰**한다. 그래서 "사용량"을 직접 알 수 없고, 관찰 가능한 신호로 추정한다.
- **어떤 변경도 자동 적용하지 않는다.** 전부 제안 → diff → 명시적 승인을 거친다.

---

## 0. 가장 먼저 할 일 — 호출 로그 탐색 (추정 금지)

B 신호(실제 호출 로그)를 만들기 전에, 각 CLI가 로컬 **어디에** 세션 로그를 남기고 **형식이 무엇인지** 기기에서 직접 확인하고, 참고한 공식 문서 링크를 보고하라. (1단계 0번과 동일 원칙)

- **Claude Code**: `~/.claude/projects/<인코딩된-경로>/<세션id>.jsonl`(메시지·도구 호출이 한 줄씩 담긴 전체 transcript) + `~/.claude/history.jsonl`(세션 전반의 슬래시 커맨드 기록).
  **주의: 이 JSONL 항목 형식은 Claude Code 내부 형식이라 버전이 바뀌면 직접 파싱이 깨질 수 있다(공식 문서 경고). 방어적으로 파싱하고, 형식을 못 알아보면 B를 건너뛰고 A로 폴백하라. 가능하면 `/export`나 안정적 인터페이스를 우선 검토.**
- **Codex**: 세션 transcript(rollout)이 `~/.codex/sessions/.../rollout-*.jsonl`에 저장되고(보관은 `history.persistence`·`history.max_bytes`로 조절), 로그는 `~/.codex/log`(`log_dir`). 추가로 OpenTelemetry 로그 export(opt-in)로 도구 호출/결과 이벤트를 받을 수 있다.
- **Gemini CLI**: 세션이 `~/.gemini/tmp/<project_hash>/chats/`에 저장된다(기본 30일 보관, 설정 가능). 또한 OpenTelemetry로 **도구 호출 수 카운터(`gemini_cli.tool.call.count`)와 도구 호출별 로그**를 제공한다(로컬 파일 `.gemini/telemetry.log`, opt-in).

> **호출 신호 팁**: 구조화된 telemetry/metric(예: Gemini의 `gemini_cli.tool.call.count`, Codex의 OTel 도구 이벤트)이 켜져 있으면 transcript 파싱보다 안정적이다. 각 도구의 telemetry 지원 여부를 확인해, 있으면 그쪽을 우선 쓰고 없을 때만 transcript를 방어적으로 파싱하라. 단 telemetry는 보통 opt-in이라 꺼져 있을 수 있으니 둘 다 대비.

**참고 공식 문서:**
- Claude Code 세션 저장: https://code.claude.com/docs/en/sessions
- Codex 세션 transcript/보관 설정: https://developers.openai.com/codex/config-reference
- Codex OTel 로그 export: https://developers.openai.com/codex/config-advanced
- Codex 세션 resume(로컬 저장 확인): https://developers.openai.com/codex/cli/features
- Gemini CLI 세션 관리(저장 위치): https://geminicli.com/docs/cli/session-management/
- Gemini CLI telemetry(도구 호출 metric/log): https://geminicli.com/docs/cli/telemetry/

**보고할 때 반드시 포함:**
- 확인 결과 표(각 도구의 로그 위치·형식).
- **참고한 공식 문서 링크 목록** — 어떤 항목을 어느 URL에서 확인했는지 매칭.
- 각 도구에서 "특정 skill/agent가 호출됐다"를 **어떻게 식별**할지(필드/패턴). 불확실하면 내게 물어라.

---

## 1. 사용량 신호 모델 (A + B)

두 신호를 합쳐 항목별 telemetry를 만든다. **신호 출처를 항상 함께 기록**한다(투명성).

**A) 편집/변경 — backbone, 견고 (항상 사용 가능)**
- canonical git 이력: 각 항목을 건드린 커밋 → `churn_count`, `last_changed`.
- 배포본 mtime: 각 도구에 배포된 사본의 최종 수정 시각.

**B) 실제 호출 — best-effort 보강**
- 0번에서 확인한 세션 로그를 파싱해 각 skill/agent의 호출 횟수 → `invocation_count`, `last_invoked`.
- **방어적 원칙**: 형식이 바뀌어 파싱이 실패해도 **도구가 죽거나 telemetry가 오염되면 안 된다.** 실패 시 그 도구의 B를 조용히 건너뛰고 A만 쓴다.

telemetry 사이드카(또는 중앙 DB) 예시:
```json
{
  "<item-id>": {
    "churn_count": 7, "last_changed": "2026-06-20T...",          // A
    "invocation_count": 31, "last_invoked": "2026-06-28T...",     // B (best-effort)
    "signal_sources": ["git", "mtime", "claude:transcript"],
    "state": "active", "pinned": false
  }
}
```
대시보드는 각 수치가 **A에서 왔는지 B에서 왔는지 구분해 표시**한다(B는 깨질 수 있으므로).

---

## 2. 기능 — 사용량 telemetry + 노후화 단계

- 항목별 사용량(A+B) 표시. **"활동" = `max(last_changed, last_invoked)`** 로 정의한다(편집이든 호출이든 활동으로 침).
- 결정론적 상태 전이(LLM 없이): `active` → `stale`(기본 30일 무활동) → `archived`(기본 90일 무활동). **임계값은 설정 가능.**
- archive는 canonical의 archive 영역으로 이동(**복구 가능**), **삭제 금지**. 이력은 git이 보존.
- 대시보드: 사용량·상태 배지, **최근 미사용(LRU) 목록**.
- `pin`한 항목은 자동 전이에서 제외.

---

## 3. 기능 — 중복/유사 항목 통합·새 버전 제안

- 겹치는 항목 탐지(특히 skill, agent도): **1차는 휴리스틱**(이름 유사, description·본문 텍스트 유사도). 더 똑똑한 판단이 필요하면 **LLM 통합 패스를 옵션으로**(기본 꺼짐).
- 대시보드는 **자동 병합하지 않고 제안만**: "X·Y가 겹친다 → umbrella Z로 통합할래? / 둘 다 유지?"
- **자기 점검 트리거(재해석)**: 한 항목의 churn·사용량이 높으면 → "새 버전으로 올릴래? / reference로 분리할래? / 통합할래?" 를 제안.
- **버전**: "새 버전" 제안을 채택하면 canonical 항목의 version을 올리고, 이전 버전은 git 이력(또는 라벨)로 보존한다.

---

## 4. 기능 — 자동 업데이트 제안 (항상 승인 staging)

- 점검 패스가 실행 가능한 항목을 찾으면(stale→archive, 중복→통합, churn→새 버전), **staged 변경**으로 만든다(적용하지 않음).
- 대시보드: **대기 중 변경 목록 + 각 변경의 diff** → 사용자가 승인/거절.
- 승인 → CLI가 적용(1단계 안전장치 동일: 배포본 백업, canonical git 커밋). 거절 → 폐기.
- **자동 적용 절대 없음. 전부 staging.**
- canonical을 바꾸는 승인이 일어나면, 영향받는 배포본을 **"drift"로 표시**해 사용자가 1단계 `push`로 재동기화할 수 있게 한다(두 단계는 조합 가능해야 한다).

---

## 5. 기능 — 주기 점검 패스 + 리포트

- `review` 명령(+대시보드 버튼): telemetry 재계산 → 상태 전이 → 중복 탐지 → 제안 생성, 그리고 **리포트(`run.json` + `REPORT.md`)** 작성.
- 트리거: **수동(CLI/버튼) + 선택적 스케줄.** 서버는 떠 있을 때만 도니, 스케줄은 macOS `launchd`/cron이 `review`를 주기 실행(예: 주 1회). 원하면 유휴 조건도 둘 수 있다.
- `--dry-run`: 리포트만, staging 없음. 일반 실행: 제안을 staging.
- 리포트는 canonical 저장소에 git으로 남겨 **라이브러리 변화 이력을 감사 가능**하게 한다(= 시간에 따른 "내가 뭘 작업했는지"도 보임).

---

## 6. 안전장치 (1단계에서 이어짐)

- 모든 변경: 제안 → diff → 명시적 승인. **자동 적용 없음.**
- archive 우선(삭제 금지), git 이력, 배포본 덮어쓰기 전 백업.
- **B(로그 파싱)는 best-effort** — 도구를 죽이거나 telemetry를 오염시키지 말 것. 실패 시 A로 폴백.
- `pin`으로 보호. 서버는 `127.0.0.1` 전용, 외부 노출 금지.

---

## 7. 산출물

- **CLI 확장**: `review`(분석+리포트+staging), 사용량 조회(`usage`/`stats`), `pin`/`unpin`, `archive`/`restore`, 대기 변경 `pending`/`approve`/`reject`.
- **얇은 서버 확장**: 위 명령용 엔드포인트(여전히 CLI 호출만, 로직 중복 금지).
- **대시보드 확장**: 사용량·상태 뷰(LRU 포함), 제안 인박스, 대기 변경 diff + 승인/거절, 리포트 뷰.
- **도구별 호출 로그 파서**(방어적·best-effort) + 신호 출처(A/B) 표시.
- README 갱신, 0번 호출 로그 탐색 보고서.

---

## 8. 범위 밖 / 주의

- 대시보드가 **직접 에이전트/작업을 수행하지 않는다.**
- **어떤 것도 자동 적용하지 않는다.**
- **B는 항상 선택적·degradable.** A만으로도 전체 기능이 동작해야 한다.

---

## 9. 작업 방식

- 0번(호출 로그 탐색) → 보고 → 내 확인 후 구현 시작.
- 예상과 다른 게 나오면 임의로 결정하지 말고 물어라.
- 파괴적 동작(파일 덮어쓰기/삭제/archive)은 항상 백업·미리보기·명시적 승인을 거친다.