# agent 트랙 0번 검증 보고 (공식 문서 + 실기기)

목적: agent 변환(트랙 B)을 만들기 전에, 세 도구의 **실제 agent 파일 포맷**을 추정 없이 확인한다.
각 항목은 **확인한 URL → 그 안에서 본 문장(인용) → 그래서 정한 방향** 순으로 기록한다.
(검증일: 2026-06-30)

---

## 1. Claude Code

- **URL:** https://code.claude.com/docs/en/sub-agents
- **확인 문장(인용):**
  - "Subagents are defined in **Markdown files with YAML frontmatter**."
  - 위치 표: "`.claude/agents/` | Current project", "`~/.claude/agents/` | All your projects", "Plugin's `agents/` directory | Where plugin is enabled"
  - "identity comes only from the **`name`** frontmatter field"
  - "The `--agents` flag accepts JSON with the same frontmatter fields as file-based subagents: `description`, `prompt`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, … **Use `prompt` for the system prompt, equivalent to the markdown body in file-based subagents.**"
  - tools 예시: `"tools": ["Read", "Grep", "Glob", "Bash"]`
  - 빌트인: Explore / Plan / General-purpose (+ statusline-setup, claude-code-guide)
- **방향:** `.md` + YAML frontmatter, **본문 = system_prompt**. 핵심 필드 = `name, description, tools, model`. (tools는 PascalCase 이름)

## 2. Gemini CLI

- **URL:** https://geminicli.com/docs/core/subagents/
- **확인 문장(인용):**
  - "The file **MUST start with YAML frontmatter** enclosed in triple-dashes `---`. **The body of the markdown file becomes the agent's System Prompt.**"
  - 위치: `~/.gemini/agents/*.md` (user), `.gemini/agents/*.md` (project)
  - 필드: `name`(slug, 필수), `description`(필수), `kind`, `tools`(array; 와일드카드 `*`, `mcp_*`), `mcpServers`, `model`, `temperature`, `max_turns`, `timeout_mins`
  - tools 예시 이름: `read_file`, `grep_search`, `run_shell_command`
  - 빌트인: codebase_investigator / cli_help / generalist / browser_agent
- **방향:** Claude와 **거의 동일** 구조(.md + frontmatter, 본문=system_prompt). 차이 = tools 이름이 snake_case + 와일드카드, 추가 필드(temperature/max_turns/timeout_mins).

## 3. Codex (OpenAI) — ⚠ 아웃라이어

- **URL:** https://developers.openai.com/codex/subagents
- **교차검증:** https://simonwillison.net/2026/Mar/16/codex-subagents/ , https://codex.danielvaughan.com/2026/04/27/codex-cli-custom-agent-definitions-toml-specialised-subagents/ (둘 다 TOML 확인)
- **확인 문장(인용):**
  - "To define your own custom agents, **add standalone TOML files** under `~/.codex/agents/` for personal agents or `.codex/agents/` for project-scoped agents."
  - 예시 파일명: "`.codex/agents/pr-explorer.toml`"
  - 시스템 프롬프트 필드: **`developer_instructions`** — "Core instructions that define the agent's behavior."
  - 옵션 키: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`, `nickname_candidates`
  - tools: **에이전트별 tools 필드가 없음** (도구는 부모 세션/`mcp_servers`로 상속)
  - 빌트인: default / worker / explorer
- **방향:** `.toml` 포맷. **system_prompt → `developer_instructions`**, `model → model`. **`tools`는 Codex에 대응 필드가 없으므로 변환 시 "손실(⚠)"로 표시.**

## 4. 실기기 확인 (존재만 — 내용 미열람, D9)

- `~/.claude/agents/` : **비어 있음**
- `~/.codex/agents/` : `README.md`, `domain-flow-code-review-agent.md` → **둘 다 `.md`라 Codex 네이티브 agent가 아님**(스펙은 `.toml`). 비표준 파일로 간주·스킵.
- `~/.gemini/agents/` : **비어 있음**
- → 현재 기기엔 "정식 agent"가 사실상 없음. 그래서 개발·검증은 **더미 agent 픽스처**로 진행한다.

## 5. 결론 — 변환 설계(요약)

| 구분 | Claude | Gemini | Codex |
|---|---|---|---|
| 파일 | `.md` + frontmatter | `.md` + frontmatter | **`.toml`** |
| system_prompt | 본문 | 본문 | **`developer_instructions`** |
| name/description | frontmatter | frontmatter | TOML 키 |
| model | `model` | `model` | `model` |
| tools | `Read,Grep,…`(array) | `read_file,…`(array, 와일드카드) | **없음 → 손실** |

- **Claude ↔ Gemini**: 거의 복사 수준(+tools 이름 매핑).
- **Codex**: TOML로 별도 렌더 + `developer_instructions` 매핑 + **tools 손실 표시**.
- **확정된 tool 매핑**: `Read↔read_file`, `Bash↔run_shell_command`, `Grep↔grep_search`. 그 외(`Glob`, `WebSearch` 등)는 이번 문서에서 **미확인** → 추측하지 말고 "미확인"으로 둔다.

## 6. plan 가정 대비 정정 사항

- plan은 Codex 시스템 프롬프트 필드를 `instructions`로 적었으나 → 실제는 **`developer_instructions`**.
- plan 중립 스키마는 `tools[]`를 세 도구 모두에 매핑 가능하다고 가정 → 실제 **Codex는 에이전트별 tools가 없어** Claude↔Gemini 간에만 매핑, Codex行은 손실.
- plan 초안 tool 매핑의 Gemini Grep 후보 `search_files` → 공식 예시는 **`grep_search`**.
