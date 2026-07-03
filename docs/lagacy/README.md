# Legacy — 이전 결정 기준의 문서 보관소

현재 프로젝트 상태(2모델 · 4뷰 · 디자인 v2)와 **맞지 않는 과거 시점의 문서**를 모아둔 곳이다.
역사·근거 추적용으로만 보존하며, **현행 기준 문서가 아니다.** 현행 문서는 `docs/` 최상위
(guide · architecture · decision · security · verification)를 본다.

| 위치 | 내용 | 왜 여기 있나 |
|---|---|---|
| `plan/plan1.md` | 1단계 작업 지시서 (초기 기획) | **3모델(Claude·Codex·Gemini) 시대** 기준 — D31로 Gemini 중단 |
| `plan/plan2.md` | 2단계 지시서 (사용량 + 자기 점검) | 자기 점검(제안/승인) UI는 제거됨 — 사용량은 B신호(D33)로 재설계 |
| `presentation.md` | 임원 발표용 슬라이드 프롬프트 | 과거 시점(3모델·구 화면) 기준 |
| `design/` | 구 디자인 프롬프트·시안(v1)·예시 이미지 | **디자인 v2(D35)** 로 대체 — 현행 권위는 `docs/design/AAD-Redesign-standalone.html` |
| `verification/agent-concept-reverification.md` | Gemini 서브에이전트 공식 지원 재검증(F0) | D31(Gemini 중단)로 결론이 무효화 — 역사 기록으로만 보존 |
| `archive/dev_log/` | 초기 개발 세션 로그·기록 | 개발 이력 |
| `archive/session-dump-2026-07-02.txt` | 세션 덤프 | 개발 이력 |

> 각 문서가 어떤 결정으로 대체됐는지는 [`docs/decision/decision.md`](../decision/decision.md)의 D31~D36 참고.
