# 사용량 로그(신호 B) 출처 검증 보고 (공식 문서 + 실기기)

목적: 대시보드는 작업을 수행하지 않고 "바깥에서 관찰"만 하므로 사용량을 직접 알 수 없다.
그래서 신호로 추정한다 — **A(편집/변경: git+mtime, 견고)** + **B(실제 호출: 세션 로그/telemetry 파싱, best-effort)**.
이 문서는 **B의 출처(세 도구의 세션 로그·telemetry 위치/형식)를 추정 없이 공식 문서로 확정**한다.
각 항목은 **확인한 URL → 그 안에서 본 문장(verbatim 인용) → 그래서 정한 방향** 순으로 기록한다.
보안 원칙: 로그 파일의 **"내용"은 절대 열지 않는다**(대화·코드·개인정보 가능). 위치/존재만 확인.
(검증일: 2026-06-30)

---

## 0. 핵심 원칙 — B는 best-effort, 실패 시 A로 폴백

- **A(편집/변경 신호: git diff + 파일 mtime)** 가 1차 사용량 신호다. 항상 존재하고 형식이 안정적이라 **견고(robust)** 하다.
- **B(실제 호출 신호: 세션 로그/telemetry 파싱)** 는 "특정 skill/agent가 실제로 호출됐는가"를 보강하는 **best-effort** 신호다.
- B가 실패하는 경우(telemetry 꺼짐, 파일 부재, 내부 JSONL 포맷이 버전 변경으로 깨짐 등)에는 **조용히 A로 폴백**한다. B의 부재가 "사용량 0"을 뜻하지 않는다.
- **우선순위 규칙:** 구조화된 telemetry/metric이 **켜져 있으면 그쪽을 우선** 사용한다(structured, 안정적). 켜져 있지 않을 때만 transcript를 **방어적으로 파싱**한다(fragile). telemetry는 세 도구 모두 **기본 opt-in(꺼짐)** 이므로 양쪽 모두 대비해야 한다.

---

## 1. Claude Code

### (1) 위치 / 형식

- **URL:** https://code.claude.com/docs/en/sessions
- **확인 문장(verbatim 인용):**
  - "By default, transcripts are stored as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric characters replaced by `-`."
  - "Each line is a JSON object for a message, tool use, or metadata entry."
  - 보관 기간/위치 변경: "Change the 30-day retention | `cleanupPeriodDays` | `settings.json`", "Move storage off `~/.claude` | `CLAUDE_CONFIG_DIR` | Environment variable"
- **방향:** 세션 transcript = `~/.claude/projects/<인코딩된 작업경로>/<세션id>.jsonl`. 각 줄(line)이 message / tool use / metadata 중 하나인 JSONL(JSON Lines). 인코딩 규칙은 "작업 디렉토리 경로의 비영숫자 문자를 `-` 로 치환".
  - ⚠ `~/.claude/history.jsonl` 은 위 sessions 문서 페이지에서 **verbatim으로 확인되지 않음**. 본문은 transcript 저장 경로로 `~/.claude/projects/<project>/<session-id>.jsonl` 만 명시한다. → `history.jsonl` 경로는 **미확인**으로 둔다(추정 금지).

### (2) "특정 skill/agent가 호출됐다"를 식별하는 방법

- transcript JSONL의 각 줄 중 **"tool use" 엔트리**가 도구 호출 단위다("Each line is a JSON object for a message, **tool use**, or metadata entry"). 따라서 skill/agent 호출은 해당 tool-use 라인의 도구 이름/입력으로 식별해야 한다.
- ⚠ **단, 정확한 필드 이름/스키마는 공식 문서에 명세되어 있지 않다.** 문서는 "internal to Claude Code"라고 명시(아래 (3) 참조)하므로, 어떤 JSON 키로 skill/agent 이름이 들어오는지는 **이 문서 범위에서 미확인**이다. 실제 키 매핑이 필요하면 별도 검증 필요.
- **권장 안정 인터페이스:** 문서는 스크립트가 세션 데이터를 다룰 때 transcript 직접 파싱 대신 안정 인터페이스를 쓰라고 안내한다 — `/export`, hooks/status line이 받는 `transcript_path`, `claude -p --output-format json|stream-json`, Agent SDK. (B를 구현한다면 가능하면 이 인터페이스 경유가 더 안전.)

### (3) 안정성 평가 — ⚠ 깨지기 쉬움(transcript 직접 파싱)

- **확인 문장(verbatim 인용):** "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release. To build on session data, use `/export` or the [script interfaces] instead."
- **평가:** 공식적으로 **"내부 형식이고 버전마다 바뀌며, 직접 파싱하는 스크립트는 어느 릴리스에서나 깨질 수 있다"** 는 명시적 경고가 있다. → **fragile**. structured telemetry/metric 대안은 sessions 문서에 없으므로(없을 때 방어적 파싱), 직접 파싱은 **방어적으로 + 실패 시 A 폴백** 전제로만 사용.

---

## 2. Codex (OpenAI)

### (1) 위치 / 형식

- **URL(세션 위치):** https://developers.openai.com/codex/cli/features
- **확인 문장(verbatim 인용):**
  - "You can copy the ID from the picker, `/status`, or the files under `~/.codex/sessions/`."
  - "Codex stores your transcripts locally so you can pick up where you left off instead of repeating context."
- **URL(보관 설정·로그 디렉토리):** https://developers.openai.com/codex/config-reference
- **확인 문장(verbatim 인용):**
  - `history.persistence`: "Control whether Codex saves session transcripts to history.jsonl."
  - `history.max_bytes`: "If set, caps the history file size in bytes by dropping oldest entries."
  - `log_dir`: "Directory where Codex writes log files; defaults to `$CODEX_HOME/log`. Setting this explicitly also enables the opt-in plaintext TUI log, `codex-tui.log`, in that directory."
- **방향:**
  - 세션 transcript = `~/.codex/sessions/` 아래 파일(세션 ID로 식별). 보관 토글 = `history.persistence`, 크기 상한 = `history.max_bytes`(가장 오래된 항목부터 드롭). 별도 history 파일은 `history.jsonl` 로 저장(`history.persistence` 설명에 명시).
  - 로그 디렉토리 = `log_dir`, 기본값 = `$CODEX_HOME/log`(즉 기본 `~/.codex/log`). 명시 설정 시 plaintext TUI 로그 `codex-tui.log` 가 그 디렉토리에 활성화(opt-in).
  - ⚠ `~/.codex/sessions/.../rollout-*.jsonl` 라는 **정확한 `rollout-*.jsonl` 파일명 패턴**은 위 공식 페이지들에서 **verbatim으로 확인되지 않음**(문서는 "files under `~/.codex/sessions/`"까지만 명시). → 파일명 패턴은 **미확인**으로 둔다(작업 디렉토리에서 ls로 존재만 확인했고 — 아래 4절 — 파일명 내부 패턴은 내용 미열람 원칙상 단정 안 함).
  - ⚠ `history.jsonl` 의 **전체 경로(`~/.codex/history.jsonl`)** 도 config-reference 본문에 경로 형태로 verbatim 명시되진 않음(`history.jsonl` 파일명만 확인). `log_dir` 기본이 `$CODEX_HOME/log` 인 점으로 보아 `CODEX_HOME`(기본 `~/.codex`) 하위로 추정되나, 경로 자체는 추정이므로 단정하지 않음.
  - 비영속 옵션: `--ephemeral`(세션 rollout 파일을 디스크에 남기지 않음) — features 문서/CLI 안내에서 확인.

### (2) "특정 skill/agent가 호출됐다"를 식별하는 방법 — 구조화 telemetry 우선

- **URL(OpenTelemetry):** https://developers.openai.com/codex/config-advanced
- **확인 문장(verbatim 인용):**
  - "Disabled by default; opt in via `[otel]`"
  - 이벤트(도구 호출 식별 핵심): `codex.tool_decision`(승인/거부 + 결정 출처 from config vs user), `codex.tool_result`(duration, success, output snippet), 그리고 도구 호출 이벤트 `codex.tool.call`. 추가로 `codex.api_request`, `codex.sse_event`, `codex.user_prompt`(prompt는 기본 redacted), `codex.conversation_starts`.
  - exporter: `otlp-http`, `otlp-grpc`.
- **방향:**
  - **OTEL이 켜져 있으면 그쪽 우선.** 도구(=skill/agent로 이어지는 호출)는 `codex.tool.call` / `codex.tool_decision` / `codex.tool_result` 이벤트로 **구조화되어** 나온다 → skill/agent 호출 식별에 가장 신뢰 가능한 출처.
  - OTEL이 꺼져 있으면(기본값) → `~/.codex/sessions/` transcript를 방어적으로 파싱.
  - ⚠ "어떤 필드에 skill/agent 이름이 들어가는가"의 **정확한 attribute 키 매핑은 이 문서 범위에서 미확인**(이벤트 이름과 대표 필드만 확인). tool_result/tool.call 이벤트의 정확한 도구명 필드는 별도 검증 필요.

### (3) 안정성 평가 — telemetry는 안정/transcript는 깨지기 쉬움(둘 다 대비)

- **OTEL 이벤트(`codex.tool.*`)**: structured telemetry → **안정적(robust)**. 단 **기본 opt-in(꺼짐)** 이라 실기기에서 꺼져 있을 가능성 높음 → 켜져 있을 때만 활용.
- **`~/.codex/sessions/` transcript / `history.jsonl`**: 내부 transcript 형식. Codex 공식 문서에 Claude Code 같은 "버전마다 깨질 수 있다"는 **명시적 경고 문구는 확인되지 않았으나**, 내부 transcript를 직접 파싱하는 것은 일반적으로 **fragile**로 간주(방어적 파싱 + A 폴백 전제).
- **결론:** OTEL 켜짐 → 1순위(structured). OTEL 꺼짐 → transcript 방어적 파싱(best-effort), 실패 시 A 폴백.

---

## 3. Gemini CLI

### (1) 위치 / 형식

- **URL:** https://geminicli.com/docs/cli/session-management/
- **확인 문장(verbatim 인용):**
  - "Sessions are stored in `~/.gemini/tmp/<project_hash>/chats/`, where `<project_hash>` is a unique identifier based on your project's root directory."
  - 보관 기간: "The default policy is to **retain sessions for 30 days**." / `maxAge`: "(string) Duration to keep sessions (for example, "24h", "7d", "4w"). Sessions older than this are deleted. Defaults to `"30d"`."
- **방향:** 세션 채팅 history = `~/.gemini/tmp/<project_hash>/chats/`(project_hash = 프로젝트 루트 기준 고유 식별자). 기본 보관 30일(`maxAge` 기본 `"30d"`).
  - ⚠ chats/ 안 파일의 **정확한 파일 형식(JSON/JSONL 여부)** 은 해당 페이지에서 **verbatim 명시되지 않음** → 형식은 **미확인**(추정 금지).

### (2) "특정 skill/agent(=tool)가 호출됐다"를 식별하는 방법 — 구조화 telemetry 우선

- **URL:** https://geminicli.com/docs/cli/telemetry/
- **확인 문장(verbatim 인용):**
  - metric 카운터: "`gemini_cli.tool.call.count` - Counts tool calls. Attributes: `function_name` (string), `success` (boolean), `decision` (string: "accept", "reject", "modify", or "auto_accept"), `tool_type` (string: "mcp" or "native")"
  - per-호출 로그 이벤트: "`gemini_cli.tool_call` - Emitted for each tool (function) call. Attributes: `function_name` (string), `function_args` (string), `duration_ms` (int), `success` (boolean), `decision` (string: ...), `error` (string, optional), `error_type` (string, optional), `prompt_id` (string)"
  - 로컬 로그 설정: `{ "telemetry": { "enabled": true, "target": "local", "outfile": ".gemini/telemetry.log" } }`
- **방향:**
  - **telemetry가 켜져 있으면 그쪽 우선.** 도구 호출 식별 핵심 필드 = **`function_name`**(어떤 tool이 호출됐는지) + `decision` + `success`.
    - 호출 **횟수 집계**가 목적이면 metric 카운터 `gemini_cli.tool.call.count`(by `function_name`)가 가장 직접적.
    - 호출 **개별 기록**(인자/소요시간/성공여부)이 필요하면 로그 이벤트 `gemini_cli.tool_call` 사용.
  - 로컬 타깃이면 telemetry가 **`.gemini/telemetry.log`** 로 출력(opt-in). telemetry 꺼져 있으면 → `~/.gemini/tmp/.../chats/` transcript 방어적 파싱.

### (3) 안정성 평가 — telemetry는 안정/transcript는 깨지기 쉬움(둘 다 대비)

- **telemetry(metric `gemini_cli.tool.call.count` / log `gemini_cli.tool_call`)**: 이름·attribute가 공식 문서에 명세된 **structured telemetry → 안정적(robust)**. 단 "`enabled` 기본 `false`" → **기본 opt-in(꺼짐)**. 켜져 있을 때만 활용.
- **`~/.gemini/tmp/.../chats/` transcript**: 형식이 문서에 명세되지 않음(미확인) → 직접 파싱은 **fragile**(방어적 파싱 + A 폴백 전제).
- **결론:** telemetry 켜짐 → 1순위(structured, `function_name`로 식별). telemetry 꺼짐 → chats transcript 방어적 파싱(best-effort), 실패 시 A 폴백.

---

## 4. 실기기 확인 (존재만 — 내용 미열람, 보안 원칙 준수)

`ls`/존재 체크만 수행했고, **로그 파일의 내용은 일절 열지 않았다.**

| 경로 | 결과 |
|---|---|
| `~/.claude/projects` | **존재** |
| `~/.claude/history.jsonl` | **존재** (문서상 경로는 미확인이나 실기기엔 파일 존재) |
| `~/.codex/sessions` | **존재** |
| `~/.codex/log` | **존재** |
| `~/.gemini/tmp` | **존재** |

→ 세 도구 모두 **세션 로그 디렉토리/파일이 실재**한다. 단, telemetry는 모두 기본 opt-in이라 켜져 있는지 여부는 (내용 미열람 원칙상) 이 문서에서 단정하지 않는다.

---

## 5. 종합 — B 신호원 비교표

| 도구 | 세션 transcript 위치 | 구조화 telemetry(켜짐 시 우선) | skill/agent 호출 식별 | transcript 안정성 |
|---|---|---|---|---|
| **Claude Code** | `~/.claude/projects/<인코딩경로>/<세션id>.jsonl` (JSONL, 줄=message/tool use/metadata) | (sessions 문서엔 metric/telemetry 없음) | tool-use 라인 (필드명 미확인) | ⚠ **fragile** — 공식 경고: "internal … changes between versions … can break on any release" |
| **Codex** | `~/.codex/sessions/` (+ `history.jsonl`, `log_dir`=`$CODEX_HOME/log`) | **OTEL `[otel]` (기본 꺼짐)**: `codex.tool.call` / `codex.tool_decision` / `codex.tool_result` | OTEL 이벤트(필드 매핑 일부 미확인) / transcript | ⚠ fragile(명시 경고는 미확인) |
| **Gemini CLI** | `~/.gemini/tmp/<project_hash>/chats/` (기본 30일, 형식 미확인) | **telemetry(기본 꺼짐)**: metric `gemini_cli.tool.call.count`, log `gemini_cli.tool_call` (key: `function_name`) | telemetry `function_name` ← **가장 명확** | ⚠ fragile(형식 미명세) |

- **가장 안정적인 B 신호원:** **Gemini CLI의 structured telemetry**(metric `gemini_cli.tool.call.count` + log `gemini_cli.tool_call`)와 **Codex의 OTEL `codex.tool.*` 이벤트** — 둘 다 공식 문서에 이벤트/필드가 명세된 structured telemetry라 가장 신뢰 가능. **단 둘 다 기본 opt-in(꺼짐)** 이므로 실기기에서 꺼져 있으면 사용 불가.
- **Claude Code**: 구조화 telemetry 대안이 sessions 문서에 없고, transcript는 **공식적으로 "버전마다 깨질 수 있다"** 고 경고됨 → B 중 가장 취약. 가능하면 `/export`·`transcript_path`·`-p --output-format json` 등 안정 인터페이스 경유 권장.

### 미확인 항목(정직 표기 — 추정 금지)

1. **Claude Code `~/.claude/history.jsonl`** — sessions 공식 페이지에서 verbatim 미확인(실기기엔 파일 존재). transcript 경로만 문서 확인됨.
2. **Claude Code tool-use 라인의 정확한 JSON 키**(skill/agent 이름이 어느 필드인지) — "internal" 명시로 문서 미명세 → 미확인.
3. **Codex `rollout-*.jsonl` 정확한 파일명 패턴** — "files under `~/.codex/sessions/`"까지만 공식 확인, `rollout-*.jsonl` 명명은 verbatim 미확인.
4. **Codex `history.jsonl` 전체 경로(`~/.codex/history.jsonl`)** — 파일명만 확인, 경로는 추정(미단정).
5. **Codex OTEL `codex.tool.*` 이벤트의 도구명 attribute 키** — 이벤트 이름·대표 필드만 확인, 정확한 키 매핑 미확인.
6. **Gemini CLI chats/ 파일 형식(JSON/JSONL)** — session-management 페이지에서 형식 verbatim 미명세 → 미확인.

### 최종 원칙 재확인

> **B(세션 로그/telemetry)는 best-effort 보강 신호다. structured telemetry가 켜져 있으면 우선 사용, 없으면 transcript를 방어적으로 파싱하되, 어느 단계든 실패하면 조용히 A(git+mtime)로 폴백한다. B의 부재가 사용량 0을 의미하지 않는다.**
