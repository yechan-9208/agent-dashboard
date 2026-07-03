---
description: AAD 대시보드 서버를 켜고 브라우저로 엽니다
disable-model-invocation: true
allowed-tools: Bash(bash ${CLAUDE_PLUGIN_ROOT}/scripts/*)
---

AAD(AI-Agent Dashboard) 서버를 실행한다.

다음 명령을 그대로 실행하라:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/plugin-serve.sh"
```

(개발 repo에서 직접 이 커맨드를 쓰는 경우 `CLAUDE_PLUGIN_ROOT`가 비어 있어도 스크립트가 스스로 repo 루트를 찾아 동작한다.)

실행이 끝나면 스크립트가 출력한 대시보드 URL(예: `http://127.0.0.1:4319`)을 사용자에게 그대로 알려주라. 이미 실행 중이면 그 안내도 함께 전달하라. 실패하면 출력에 나온 로그 경로를 사용자에게 안내하라.
