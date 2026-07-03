# TODO

## 에이전트 동기화 — 100% 동기화 필요 (뷰 숨김 해제 조건)

**상태**: 보류 — 에이전트·플레이그라운드 뷰를 UI에서 숨김 (2026-07-02, D32)

**문제**: 현재 Claude ↔ Codex 에이전트 sync는 100% 동기화가 아니다.
- Codex는 에이전트별 `tools` 필드가 없어 Claude→Codex 변환 시 **tools가 전부 손실**된다.
- 내용 비교(`agentNeutralKey`)에 tools가 포함되므로, tools를 가진 에이전트는
  sync 직후에도 매트릭스에서 영원히 **"불일치(drift)"** 로 보인다.

**할 일**: 아래 공식 문서를 참고해 두 모델의 서브에이전트 스펙을 재검증하고,
100% 왕복(round-trip) 동기화가 가능한 변환 규칙을 다시 설계한다.
- Codex subagents: https://developers.openai.com/codex/subagents
- Claude Code sub-agents: https://code.claude.com/docs/en/sub-agents

**재설계 시 검토할 것**:
1. Codex 서브에이전트 스펙에 tools 상당 개념이 생겼는지(권한/도구 제한 필드) 확인.
2. 없다면: 비교 키에서 tools 제외("표현 가능한 범위까지 같으면 synced") + 손실 사유 명시 표시 중 택1.
3. 왕복 검증: claude→canonical→codex→canonical 재파싱 시 원본과 동일한지 자동 테스트.
4. 통과하면 에이전트 뷰·플레이그라운드 뷰 숨김 해제 (dashboard/index.html nav + app.js VIEW_META 복원).

**참고**: 엔진(cli/core.js `agentMatrix`·`syncApply`, `aad agent ...` CLI, `/matrix?kind=agent`)은
그대로 살아 있다 — UI만 숨겼다. 이전 검증 기록: `docs/lagacy/verification/agent-concept-reverification.md`.
