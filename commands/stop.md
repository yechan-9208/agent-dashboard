---
description: AAD 대시보드 서버를 종료합니다
disable-model-invocation: true
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/*)
---

AAD(AI-Agent Dashboard) 서버를 종료한다.

다음 명령을 그대로 실행하라:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-stop.sh"
```

(개발 repo에서 직접 이 커맨드를 쓰는 경우 `CLAUDE_PLUGIN_ROOT`가 비어 있어도 스크립트가 스스로 repo 루트를 찾아 동작한다.)

스크립트가 출력한 결과("서버를 껐습니다" 또는 "실행 중이 아닙니다")를 사용자에게 그대로 전달하라.
