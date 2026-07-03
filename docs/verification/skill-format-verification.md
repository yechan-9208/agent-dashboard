# skill 트랙 0번 검증 보고 (공식 문서 + 실기기)

목적: skill 변환(트랙 A)을 만들기 전에, 세 도구의 **실제 SKILL.md 포맷·위치**를 추정 없이 확인한다.
각 항목은 **확인한 URL → 그 안에서 본 문장(인용) → 그래서 정한 방향** 순으로 기록한다.
(검증일: 2026-06-30)

---

## 0. Agent Skills 표준 (공통 베이스)

세 도구 모두 이 오픈 표준을 따른다고 명시하므로, 먼저 공통 기준을 고정한다.

- **URL:** https://agentskills.io/specification
- **확인 문장(인용):**
  - "A skill is a directory containing, at minimum, a `SKILL.md` file." (디렉토리 구조: `SKILL.md`(필수) + `scripts/`/`references/`/`assets/`(옵션))
  - "The `SKILL.md` file must contain YAML frontmatter followed by Markdown content."
  - frontmatter 표: **`name`(Yes)** = "Max 64 characters. Lowercase letters, numbers, and hyphens only. Must not start or end with a hyphen."; **`description`(Yes)** = "Max 1024 characters. Non-empty. Describes what the skill does and when to use it."
  - 옵션 필드: `license`(No), `compatibility`(No), `metadata`(No, "Arbitrary key-value mapping"), **`allowed-tools`(No)** = "Space-separated string of pre-approved tools the skill may use. (Experimental)"
  - "Must match the parent directory name" (name = 부모 디렉토리명과 일치)
  - "The Markdown body after the frontmatter contains the skill instructions. There are no format restrictions."
- **방향:** 공통 스키마 = **`<skill-name>/SKILL.md`** (디렉토리 + YAML frontmatter `name`/`description` + 마크다운 본문). 본문 = skill 지시문. 이게 세 도구의 최소공통분모이고, 변환 중립 스키마의 기준점.

---

## 1. Claude Code

- **URL:** https://code.claude.com/docs/en/skills
- **확인 문장(인용):**
  - "Claude Code skills follow the [Agent Skills](https://agentskills.io) open standard ... Claude Code extends the standard with additional features like invocation control, subagent execution, and dynamic context injection."
  - 위치 표:
    - Personal | `~/.claude/skills/<skill-name>/SKILL.md` | "All your projects"
    - Project | `.claude/skills/<skill-name>/SKILL.md` | "This project only"
    - **Plugin | `<plugin>/skills/<skill-name>/SKILL.md` | "Where plugin is enabled"**
    - Enterprise | (managed settings)
  - 명령어 이름 규칙: "Skill directory under `~/.claude/skills/` or `.claude/skills/` → Directory name" / "Plugin `skills/` subdirectory → Directory name, namespaced by plugin (`my-plugin/skills/review/SKILL.md` → `/my-plugin:review`)"
  - frontmatter 표(전부 옵션, `description`만 권장). 표준 외 **Claude 고유 메타**:
    - `name` = "Display name shown in skill listings. Defaults to the directory name."
    - `when_to_use`, `argument-hint`, `arguments`
    - **`disable-model-invocation`** = "Set to `true` to prevent Claude from automatically loading this skill. Use for workflows you want to trigger manually with `/name`."
    - `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`
    - **`context`** = "Set to `fork` to run in a forked subagent context.", `agent`, `hooks`, `paths`, `shell`
  - 동적 컨텍스트: "The `` !`<command>` `` syntax runs shell commands before the skill content is sent to Claude."
- **방향:** 표준 그대로(`<name>/SKILL.md` + frontmatter `name`/`description` + 본문). **위치는 ~/.claude/skills/ (개인) / .claude/skills/ (프로젝트) / 플러그인의 skills/ 서브디렉토리** 3종. Claude 고유 메타(`disable-model-invocation`, `context`, `model`, `allowed-tools` 등)는 다른 도구로 변환 시 **손실/주석화** 대상. name은 옵션(없으면 디렉토리명).

## 2. Codex (OpenAI)

- **URL:** https://developers.openai.com/codex/skills
- **확인 문장(인용):**
  - 위치(전부 `.agents/skills`): "For repositories, Codex scans `.agents/skills` in every directory from your current working directory up to the repository root." + User `"$HOME/.agents/skills"` + Admin `"/etc/codex/skills"` + System(빌트인).
  - **⚠ `~/.codex/skills`는 공식 문서에 없음** — 문서가 명시하는 user 경로는 오직 `$HOME/.agents/skills`.
  - 파일 구조: 표준과 동일 — `SKILL.md`(required) + `scripts/`/`references/`/`assets/`(옵션) + **`agents/openai.yaml`(옵션)**.
  - frontmatter: "The `SKILL.md` file must include frontmatter with `name` and `description`."
  - 고유 메타 파일: "The `agents/openai.yaml` file can configure: `display_name`, `short_description`, icon paths, `brand_color`, `default_prompt`, invocation policy via `allow_implicit_invocation`, and tool `dependencies`."
- **방향:** 표준 SKILL.md 그대로(+`name`/`description` 필수). **위치 = `~/.agents/skills/` (user, 공식) / `.agents/skills/` (repo).** Claude/Gemini와 달리 메타가 frontmatter가 아니라 **별도 `agents/openai.yaml` 파일**로 분리됨 → 변환 시 Codex 메타는 frontmatter가 아닌 이 파일로 가야 함(이번 단계에선 미구현, "선택" 취급).

## 3. Gemini CLI — ✅ plan의 "위치 미확인"을 확정 해소

- **URL:** https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/skills.md , https://geminicli.com/docs/cli/skills/ , https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/creating-skills.md
- **교차근거:** Gemini CLI v0.23.0 릴리스에서 "Agent Skills Preview"로 도입됨(github.com/google-gemini/gemini-cli discussion #16084).
- **확인 문장(인용):**
  - 4-tier 발견 위치(낮은→높은 우선순위): Built-in → Extension → **User: `~/.gemini/skills/` 또는 `~/.agents/skills/` 별칭** → **Workspace: `.gemini/skills/` 또는 `.agents/skills/` 별칭**.
  - "Within the same tier (user or workspace), the `.agents/skills/` alias takes precedence over the `.gemini/skills/` directory."
  - "If multiple skills share the same name, the version from the higher-precedence location is used."
  - 발견 깊이: "`SKILL.md` is discovered either at the root of the skills directory (`.gemini/skills/SKILL.md`) or one directory deep (`.gemini/skills/<skill-name>/SKILL.md`)."
  - frontmatter(creating-skills.md): `name` = "A unique identifier for the skill. This should match the directory name." / `description` = "**CRITICAL.** ... how Gemini decides when to use the skill. Be specific about the tasks it handles and the keywords that should trigger it." (그 외 `license`/`allowed-tools` 등은 이 가이드에 **미기재**.)
  - 활성화: "The `SKILL.md` body and folder structure is added to the conversation history." (본문 = 지시문, system prompt에 주입)
- **방향:** **Gemini CLI는 skill을 공식 지원하며, 위치는 `~/.gemini/skills/` (user) / `.gemini/skills/` (project)이고 `~/.agents/skills/`·`.agents/skills/` 별칭을 같은 tier에서 우선한다.** 포맷은 표준 SKILL.md(`name`/`description` 필수, 본문=지시문). 문서화된 Gemini 고유 frontmatter 메타는 사실상 없음(`name`/`description`만). → Claude ↔ Gemini는 **거의 복사 수준**(Claude 고유 메타만 떨굼).

## 4. 실기기 확인 (존재만 — 내용 미열람, D9 준수)

이름/존재만 확인했고 어떤 SKILL.md 파일도 열지 않았다.

- `~/.claude/skills/` : **비어 있음**(개인 skill 없음).
- `~/.claude/plugins/` 직속에는 `<plugin>/skills/`가 **없음**. 실제 플러그인 skill은:
  - `~/.claude/plugins/cache/<plugin>/<plugin>/<ver>/skills/` (예: understand-anything, honcho)
  - `~/.claude/plugins/marketplaces/<marketplace>/plugins/<plugin>/skills/` (예: claude-plugins-official 산하 skill-creator, hookify, plugin-dev 등 다수; honcho)
  - → **문서가 말하는 "`<plugin>/skills/`"의 실제 실현 경로는 cache/marketplaces 하위**라서, 단순히 `~/.claude/plugins/*/skills`만 글롭하면 못 찾는다(스캔 경로 정정 필요).
- `~/.codex/skills/` : **존재 + 다수 디렉토리 보유**(`0-skill-maker`, `0-code-check-hook`, `gh-address-comments`, `github-account-guard` 등). **⚠ 공식 문서엔 없는 경로** → 아래 6절 플래그.
- `~/.agents/skills/` : **존재**(`find-skills`). Codex/Gemini 공용 별칭 경로가 실제로 쓰이고 있음.
- `~/.gemini/skills/` : 해당 경로 자체는 **현재 비어 있음/미존재**. 단, `~/.gemini` 하위에서 발견된 `skills/` 디렉토리는 전부 **Antigravity IDE 계열**(`~/.gemini/config/plugins/*/skills`, `~/.gemini/antigravity-ide/plugins/*/skills`, `~/.gemini/extensions/Stitch`)이며 **Gemini CLI 네이티브 user-skills 경로(`~/.gemini/skills/`)가 아님** → 혼동 주의(아래 6절 플래그).

## 5. 결론 — 변환 설계(요약표)

| 도구 | skill 위치(공식) | 포맷 | 도구별 메타 |
|---|---|---|---|
| **Claude Code** | `~/.claude/skills/` (개인), `.claude/skills/` (프로젝트), 플러그인 `skills/` | `<name>/SKILL.md` + YAML frontmatter + 본문 | frontmatter에 다수: `disable-model-invocation`, `user-invocable`, `context:fork`/`agent`, `model`, `effort`, `allowed-tools`, `paths`, `hooks` 등 |
| **Codex** | `~/.agents/skills/` (user), `.agents/skills/` (repo), `/etc/codex/skills` (admin) | `<name>/SKILL.md` + frontmatter(`name`/`description`) + 본문 | **frontmatter 밖** 별도 `agents/openai.yaml`: `display_name`, `short_description`, `brand_color`, `default_prompt`, `allow_implicit_invocation`, `dependencies` |
| **Gemini CLI** | `~/.gemini/skills/` (user), `.gemini/skills/` (project), `~/.agents/skills/`·`.agents/skills/` 별칭(동 tier 우선) | `<name>/SKILL.md`(또는 디렉토리 루트 직속) + frontmatter(`name`/`description`) + 본문 | 문서화된 고유 frontmatter 메타 **없음**(`name`/`description`만) |

- **공통(표준)**: 셋 다 `<name>/SKILL.md` + frontmatter `name`/`description` + 마크다운 본문. → **중립 스키마 = { name, description, body }**.
- **Claude → Gemini**: 거의 복사. Claude 고유 frontmatter 메타(`disable-model-invocation` 등)는 Gemini에 대응 없음 → **손실(드롭)**.
- **Claude → Codex**: 본문/`name`/`description`은 복사. Claude 고유 메타는 frontmatter로 못 넘김 → Codex는 `agents/openai.yaml`로 분리해야 하나 매핑 1:1 아님 → 이번 단계 **미구현(선택)**, 손실 표시.
- **`~/.agents/skills/` 별칭**: Codex(공식 user 경로)와 Gemini(별칭, 우선)가 **공유** → 한 번 쓰면 두 도구가 같이 읽음. 동기화 시 충돌/중복 발견 주의.

### "미확인(추측 금지)" 항목
- Codex `agents/openai.yaml`의 키별 정확한 스키마/필수 여부, Claude 메타 → openai.yaml 필드 1:1 매핑: **미확인** → 변환 미구현, "선택"으로 둔다.
- Gemini SKILL.md의 표준 외 옵션 메타(`license`/`allowed-tools`/`metadata`) 실제 인식 여부: 공식 creating-skills 가이드엔 **미기재** → "미확인", 표준 베이스만 신뢰.

## 6. plan 가정 대비 불일치 플래그

1. **(가장 중요) Gemini skill 위치 "미확인" → 확정 해소.** plan은 Gemini skill 위치를 미확인으로 뒀으나, Gemini CLI는 v0.23.0부터 skill을 **공식 지원**하며 위치는 **`~/.gemini/skills/` (user) / `.gemini/skills/` (project)**, `~/.agents/skills/`·`.agents/skills/` 별칭(동 tier 우선). → Gemini를 변환 대상에 **정식 포함** 가능.
2. **Claude 플러그인 skill의 실제 경로.** 문서 표기는 `<plugin>/skills/`지만, 실기기에선 `~/.claude/plugins/cache/.../skills` 와 `~/.claude/plugins/marketplaces/.../plugins/<plugin>/skills` 하위에 존재. → 대시보드 스캐너가 `~/.claude/plugins/*/skills`만 보면 **놓침**. cache/marketplaces 경로까지 글롭해야 함.
3. **Codex skill 위치.** 공식 문서가 말하는 user 경로는 `~/.agents/skills/`인데, **실기기엔 `~/.codex/skills/`가 실재하고 다수 skill 보유**. 둘 중 무엇을 canonical로 볼지 결정 필요 — 공식은 `~/.agents/skills/`이나 실사용 자산은 `~/.codex/skills/`에 있음. (현 버전 Codex가 `~/.codex/skills/`도 읽는지는 문서상 **미확인** → 둘 다 스캔 후보로 두고 정직하게 표기.)
4. **Codex 메타 위치.** plan이 Codex 메타를 frontmatter로 가정했다면 정정: Codex 고유 메타는 frontmatter가 아니라 **별도 `agents/openai.yaml`** 파일.
5. **`~/.agents/skills/` 공유 별칭.** Codex와 Gemini가 같은 경로를 공유 → "도구별 분리" 가정이 깨질 수 있음. 동기화 설계 시 이 별칭의 중복 노출을 고려.
