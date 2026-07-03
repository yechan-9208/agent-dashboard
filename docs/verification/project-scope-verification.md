# 0번 검증 — 프로젝트(저장소) 레벨 skill / agent / 지시문 위치 (2026-07-02)

> 프로젝트 스코프 기능 구현 전, 세 도구의 **프로젝트 레벨** 공식 위치·포맷을 웹 공식 문서로 확인한 보고서.
> 방법: 웹 공식 문서만 확인(로컬 `~/.claude`·`~/.codex`·`~/.gemini` 미접근). 미확인 항목은 추측하지 않고 "문서에 없음"으로 표기.

---

## 1. Claude Code (code.claude.com/docs)

**프로젝트 레벨 스킬** → **확인됨** (`<project>/.claude/skills/<skill-name>/SKILL.md`)
- 근거: https://code.claude.com/docs/en/skills — "Where skills live" 표: "Project | `.claude/skills/<skill-name>/SKILL.md` | This project only"
- 우선순위(주의, 에이전트와 반대): "When skills share the same name across levels, **enterprise overrides personal, and personal overrides project**." (동일 이름이면 enterprise > personal(유저) > **project**)
- 중첩 지원: "Skills also load from nested `.claude/skills/` directories below your working directory." + 시작 디렉토리부터 레포 루트까지 상위 방향도 스캔.
- 표준: Agent Skills 오픈 표준(agentskills.io)을 따름. `.claude/commands/`는 스킬로 통합됨.

**프로젝트 레벨 서브에이전트** → **확인됨** (`<project>/.claude/agents/*.md`)
- 근거: https://code.claude.com/docs/en/sub-agents — 위치 표: "`.claude/agents/` | Current project | 3" / "`~/.claude/agents/` | All your projects | 4" (숫자 낮을수록 우선 → **프로젝트가 유저를 이김**)
- "Subagents are Markdown files with YAML frontmatter."
- CWD에서 레포 루트까지 모든 `.claude/agents/` 스캔(이름 충돌 시 CWD에 가까운 정의 우선, v2.1.178+).

**프로젝트 지시문 CLAUDE.md** → **확인됨** (`./CLAUDE.md` **또는** `./.claude/CLAUDE.md`)
- 근거: https://code.claude.com/docs/en/memory — "A project CLAUDE.md can be stored in either `./CLAUDE.md` or `./.claude/CLAUDE.md`."
- 하위 디렉토리 CLAUDE.md는 해당 디렉토리 파일을 읽을 때 on-demand 로드. 상위 트리는 위로 걸어 올라가며 전부 로드·연결(override 아님, concatenate).
- 추가: `CLAUDE.local.md`(gitignore 대상), `.claude/rules/*.md`(paths frontmatter로 경로 스코프), `@path` import. "Claude Code reads `CLAUDE.md`, **not** `AGENTS.md`."

**플러그인의 프로젝트 레벨 설치** → **확인됨 (단, 디렉토리 방식이 아니라 `.claude/settings.json` 설정 방식)**
- 근거: https://code.claude.com/docs/en/discover-plugins — "**Project scope**: … adds the plugin to `.claude/settings.json`"
- `<project>/.claude/plugins/` 디렉토리는 **문서에 없음**. 플러그인 본체는 `~/.claude/plugins/cache`.

## 2. OpenAI Codex CLI (developers.openai.com/codex)

**프로젝트 지시문 AGENTS.md** → **확인됨** (`<repo-root>/AGENTS.md` + 하위 디렉토리 + `AGENTS.override.md`)
- 근거: https://developers.openai.com/codex/guides/agents-md — "Starting at the project root (typically the Git root), Codex walks down to your current working directory. In each directory along the path, it checks for `AGENTS.override.md`, then `AGENTS.md`" / CWD에 가까운 파일 우선. 글로벌은 `~/.codex/AGENTS.md`가 먼저 로드.
- agents.md 표준(https://agents.md/): 패키지별 중첩 AGENTS.md, 가장 가까운 파일 우선. 지원 도구에 Codex·Gemini CLI 명시.

**프로젝트 레벨 스킬** → **확인됨** (`.agents/skills` 계열) / **`.codex/skills`는 문서에 없음**
- 근거: https://developers.openai.com/codex/skills — 공식 위치 표: `$CWD/.agents/skills`, `$CWD/../.agents/skills`, `$REPO_ROOT/.agents/skills`(레포 레벨), `$HOME/.agents/skills`(유저), `/etc/codex/skills`(시스템)
- agentskills 오픈 표준 기반. 이름 중복 시 명시적 override 계층 **없음**("both can appear in skill selectors").

**프로젝트 레벨 에이전트 정의(.toml)** → **확인됨** (`<project>/.codex/agents/*.toml`)
- 근거: https://developers.openai.com/codex/subagents — "add standalone TOML files under `~/.codex/agents/` for personal agents or **`.codex/agents/` for project-scoped agents**."
- 캐비앳: openai/codex 이슈 #14579 — 프로젝트 config의 agent role spawn 구현 편차 보고. 대시보드는 공식 문서 경로(`.codex/agents/`) 기준 파싱이 안전.

## 3. Gemini CLI (github.com/google-gemini/gemini-cli / geminicli.com)

**프로젝트 지시문 GEMINI.md** → **확인됨** (워크스페이스 + 상위 + 하위 JIT 계층 로딩)
- 근거: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/gemini-md.md — 워크스페이스와 상위에서 GEMINI.md 탐색(글로벌은 `~/.gemini/GEMINI.md`); 도구가 파일 접근 시 해당 디렉토리 JIT 스캔.
- 파일명 변경 가능: `context.fileName` 속성 — 예시 `["AGENTS.md", "CONTEXT.MD", "GEMINI.md"]`.

**프로젝트 레벨 스킬** → **확인됨** (`.gemini/skills/` **또는** `.agents/skills/` 별칭)
- 근거: https://geminicli.com/docs/cli/skills/ — "Located in `.gemini/skills/` or the `.agents/skills/` alias. Workspace skills are shared with your team via version control."
- 우선순위: Built-in < Extension < User < **Workspace**(최우선). 같은 계층에서는 `.agents/skills/` 별칭이 `.gemini/skills/`보다 우선. Agent Skills 표준 준수.

**프로젝트 레벨 서브에이전트** → **확인됨** (`.gemini/agents/*.md`)
- 근거: https://github.com/google-gemini/gemini-cli/blob/main/docs/core/subagents.md — "1. **Project-level:** `.gemini/agents/*.md` … 2. **User-level:** `~/.gemini/agents/*.md`" / YAML frontmatter 필수, 본문 = System Prompt.
- 이름 충돌 시 project vs user 우선순위: **문서에 없음**(미규정으로 표기할 것). 기본 활성(`enableAgents`로 비활성 가능).

## 4. Cross-tool 표준 (agentskills)

**프로젝트 레벨 `.agents/skills/` 규정** → **스펙 본문에는 없음 / 구현 가이드에 '관례(convention)'로 확인됨**
- 스펙(https://agentskills.io/specification): SKILL.md 형식만 정의, 저장 위치 규정 없음.
- 구현 가이드: "`.agents/skills/` paths have emerged as a widely-adopted convention … **the specification does not mandate where skill directories live**."
- 이름 충돌 관례: "project-level skills override user-level skills" — 단 Claude Code 스킬은 문서상 반대(personal > project)이므로 도구별로 다르게 표기해야 함.
- 보안 권고: "Consider gating project-level skill loading on a trust check" (프로젝트 레벨 스킬은 신뢰 확인 후 로드 권장).

---

## 요약 표 (도구 × 종류 × 프로젝트 레벨 경로)

| 도구 | 지시문 | 스킬 | 에이전트 | 비고 |
|---|---|---|---|---|
| **Claude Code** | `./CLAUDE.md` 또는 `./.claude/CLAUDE.md` | `.claude/skills/<name>/SKILL.md` — 충돌 시 **personal > project** | `.claude/agents/*.md` — 충돌 시 **project > user** | 플러그인은 `.claude/settings.json` 설정(디렉토리 없음) |
| **Codex CLI** | `AGENTS.md` (루트→CWD 하향 병합, override 우선) | `$REPO_ROOT/.agents/skills` 등 — `.codex/skills` **문서에 없음** | `.codex/agents/*.toml` | 스킬 override 계층 미규정 |
| **Gemini CLI** | `GEMINI.md` (workspace+상위+하위 JIT) | `.gemini/skills/` 또는 `.agents/skills/` 별칭 — **workspace > user** | `.gemini/agents/*.md` | 에이전트 충돌 우선순위 미규정 |
| **agentskills 표준** | — | `.agents/skills/`는 관례(스펙 규정 아님) | — | SKILL.md 형식만 규정 |

## 구현 시사점

1. 세 도구 모두 프로젝트 레벨 skill/agent/지시문이 공식 확인됨 — **전부 구현 대상 가능**.
2. 스킬 공통분모는 `.agents/skills/`(Codex 공식·Gemini 별칭·관례)이지만 **Claude만 `.claude/skills/` 사용**.
3. 이름 충돌 우선순위는 도구마다 다름(Claude 스킬은 personal>project로 특이; Gemini 에이전트·Codex 스킬은 미규정) → 대시보드 '우선순위' 표기는 도구별 문서 값 그대로, 미규정은 '미규정'으로.
4. (보안) agentskills 가이드도 프로젝트 레벨 스킬은 **신뢰 확인 후 로드**를 권고 — AAD의 등록제(사용자가 등록한 프로젝트만 스캔) 설계와 정합.
