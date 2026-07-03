# 기본 레지스트리(스킬 repo) 큐레이션 출처·검증

**목적**: AI-Agent Dashboard 스토어의 "퍼블리셔 카드"(퍼블리셔별 N skills · M repos)를 채우기 위한 기본 레지스트리 데이터.

## 출처 (유일 소스)

- **파일**: `/Users/won-yechan/other_github/skills-manage/src/data/officialSources.ts`
- **라이선스**: Apache License 2.0 (`skills-manage/LICENSE`)
- **NOTICE 차용 표기**: `skills-manage — Copyright 2026 iamzhihuix` (`skills-manage/NOTICE`).
  이 저작권/NOTICE는 Apache-2.0 조건에 따라 차용 시 유지한다.
- **정적 스냅샷**: 본 데이터는 위 파일에 하드코딩된 정적 스냅샷을 포팅한 것이다.
  **skills.sh 실시간 스크래핑이 아니다**(robots 문제 없음). 파일 상단 주석상 데이터 자체는
  "skills.sh/official" 목록에서 큐레이션된 것으로 기재되어 있으나, 우리는 이를 재수집하지 않고 정적 파일만 포팅했다.
- **발명·추측 금지**: officialSources.ts에 없는 repo·숫자·URL은 넣지 않았다. 이 파일이 유일한 소스다.

## 정직 표기 (중요)

- `skillCountCurated` / `totalSkills` / recommended의 downloadUrl 등 모든 수치·경로는 **큐레이션 시점 스냅샷**이다.
- **실제 repo 존재 여부·기본 브랜치·실제 SKILL.md clone 수는 새로고침(`AAD_ALLOW_NET`) 시점에 검증되어야 하며, 큐레이션 수치와 다를 수 있다.**
- 브랜치는 소스에 정보가 없어 관례상 `main`으로 채웠다(스팟체크한 3개는 실제 `main` 확인). 다른 repo의 실제 기본 브랜치는 미확인이므로 clone/fetch 시 재확인 필요.
- MiniMax(`MiniMax-AI/skills`)는 소스에서 `totalSkills: 0`(빈/미수집)이지만 소스에 존재하므로 그대로 포팅했다. 표시/필터링은 SKC1·UI 판단.

## 스팟체크 (전수검증 아님 — WebFetch로 3개만)

| repo | 결과 | 기본 브랜치 |
|------|------|-------------|
| `anthropics/skills` | **확인됨** (200, 정상 렌더, 157k stars) | main |
| `github/awesome-copilot` | **확인됨** (200, 정상 렌더, 36k stars) | main |
| `microsoft/azure-skills` | **확인됨** (200, 정상 렌더, "Official agent plugin ... Azure scenarios") | main |

- 나머지 repo는 **미확인**(스냅샷 신뢰, 새로고침 시 검증). 열지 못한 repo가 있으면 위 표에 "미확인"으로 남긴다(현재 스팟체크 3개는 모두 확인됨).

## 포팅 요약

- **퍼블리셔**: 70개 (`OFFICIAL_PUBLISHERS` 전부)
- **총 repo**: 78개 (Anthropic이 9 repos로 최다, 나머지는 대체로 1 repo/퍼블리셔)
- **태그**: 10종 (`SkillTag` + `TAG_LABELS`; 라벨은 한국어+영어. 원본 zh 라벨은 한국어로 대체)
- **추천 스킬**: 22개 (`RECOMMENDED_SKILLS` 전부; name/description/publisher/repoFullName/tags/downloadUrl 그대로)

### 상위 퍼블리셔(totalSkills 기준, 목업 카드 대조용)

| 퍼블리셔 | slug | totalSkills | repos |
|----------|------|-------------|-------|
| Microsoft | microsoft | 404 | 1 |
| GitHub | github | 331 | 1 |
| Anthropic | anthropics | 289 | 9 |
| Sentry | getsentry | 244 | 1 |
| Vercel Labs | vercel-labs | 214 | 1 |
| Firecrawl | firecrawl | 168 | 1 |
| PostHog | posthog | 137 | 1 |
| Vercel | vercel | 120 | 1 |
| OpenAI | openai | 118 | 1 |
| MiniMax | MiniMax-AI | 0 | 1 |

(전체 70개는 `catalog/default-registries.json` 참조.)

## 산출물 (배정 파일 4개)

1. `catalog/default-registries.json` — v2, `publishers[]` → `repos[]` 그룹핑 스키마.
2. `catalog/skill-tags.json` — v1, 태그 10종(ko/en).
3. `catalog/recommended-skills.json` — v1, 추천 스킬 22개.
4. `docs/verification/skill-registries-verification.md` — 본 문서.

## SKC1 구현 참고 — 스키마 요약

### default-registries.json (v2, 스키마 변경됨)
v1(평면 `registries[]`, 3개)에서 **구조가 바뀐다**. v2는 다음 형태:

```jsonc
{ "version": 2, "note": "...",
  "publishers": [
    { "id": "anthropics",          // 안정 슬러그(= slug 소문자)
      "name": "Anthropic",
      "slug": "anthropics",        // GitHub org
      "totalSkills": 289,          // 스냅샷 합계(참고용)
      "repos": [
        { "id": "anthropics-skills",              // owner-repo 슬러그(안정)
          "name": "anthropics/skills",            // owner/repo (아래 주의 참조)
          "url": "https://github.com/anthropics/skills",
          "branch": "main",                       // 관례값, 미확인 다수 → clone 시 재확인
          "official": true,
          "skillCountCurated": 18 }               // 스냅샷 수, 실제 clone 수와 다를 수 있음
        // ... 한 퍼블리셔가 여러 repo면 여기에 나열(Anthropic=9)
      ] }
    // ... 70개 퍼블리셔
  ] }
```

- **registry.js 파싱 변경 필요**: 기존 v1은 최상위 `registries[]`를 읽었다. v2는 `publishers[]`를 순회하며 각 `p.repos[]`를 개별 레지스트리(clone 대상)로 펼쳐야 한다. 기존 개별 repo가 읽던 필드(`id`,`name`,`url`,`official`)는 각 repo 객체에 유지되어 있으니, repo 레벨에서 그대로 사용 가능.
- **주의 — `name` 의미 변경**: repo의 `name`은 "owner/repo" 문자열이다(v1의 "Anthropic Skills" 같은 표시명이 아님). 표시용 이름이 필요하면 publisher `name`을 쓰거나 별도 가공.
- **id 안정성**: publisher `id`=slug 소문자, repo `id`=owner-repo(슬래시→하이픈). 안정 슬러그이므로 상태 키로 사용 가능.
- **skillCountCurated / totalSkills는 참고용**. 실제 스킬 수는 clone 후 유효 SKILL.md(frontmatter name/description) 개수로 산출.
- **branch 하드코딩 금지**: 대부분 미확인이라 `main`으로 채움. fetch 시 실제 기본 브랜치 확인 권장.
- **빈 repo 처리**: `MiniMax-AI/skills`는 `skillCountCurated: 0`. clone 결과 0개일 수 있음(정상).

### skill-tags.json (v1)
`tags[]` = `{ key, ko, en }`. key는 recommended-skills의 `tags[]`와 조인 키.

### recommended-skills.json (v1)
`skills[]` = `{ name, description, publisher, repoFullName, tags[], downloadUrl }`.
- `tags[]`는 skill-tags.json의 `key`를 참조.
- `downloadUrl`은 `raw.githubusercontent.com/<repo>/main/<name>/SKILL.md` 형태의 스냅샷 경로. 실제 존재는 새로고침 시 검증(404 가능).
- `repoFullName`으로 default-registries의 repo(`name`)와 조인 가능.
