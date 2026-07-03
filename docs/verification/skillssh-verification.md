# skills.sh 디스커버리 — 0번 검증 (구현 전 실측)

- **검증일**: 2026-07-02
- **방법**: 공개 웹 읽기(`curl` + WebFetch)만. 앱 미실행, `AAD_ALLOW_*` 미설정, 사용자 `~/.claude` 등 미접근.
- **정직성 표기**: 각 항목에 `[확인됨]` / `[불확실]` / `[실측 불가]`.
- **관련 산출물**: `fixtures/skillssh/leaderboard-sample.json`, `fixtures/skillssh/search-sample.json` (둘 다 실측 캡처).

---

## 1. 엔드포인트 생존 `[확인됨]`

| URL | 결과 | 반환 형식 |
|---|---|---|
| `https://skills.sh/` | HTTP 200 | **HTML** (Next.js App Router). 리더보드 데이터가 페이지 내 RSC 스트림에 임베드됨 |
| `https://skills.sh/trending` | HTTP 308 → `https://www.skills.sh/trending` (200) | HTML (apex→www 캐노니컬 리다이렉트일 뿐, 별도 페이지 구조 동일) |
| `https://skills.sh/hot` | HTTP 308 → `https://www.skills.sh/hot` (200) | HTML |
| `https://skills.sh/api/search?q=code&limit=5` | HTTP 200 | **순수 JSON** (`application/json`) |
| `https://skills.sh/api/leaderboard`, `/api/skills`, `/api/trending`, `/api/hot` | **404** | — 공개 JSON 리더보드 엔드포인트는 **존재하지 않음** |

- `/`, `/trending`, `/hot`은 모두 사람이 보는 HTML 페이지. 리더보드 JSON을 직접 주는 API는 없음.
- `/api/search`만 유일한 순수 JSON API.

## 2. 현재 응답 구조 / 스키마 `[확인됨]`

### 2-a. 리더보드(`/` 홈) — RSC 임베드, `__NEXT_DATA__` 아님 `[확인됨]`

manager2가 말한 고전 `__NEXT_DATA__` `<script>`는 **없다**. 현재는 Next.js App Router라
`self.__next_f.push([1, "..."])` 형태의 **RSC 스트리밍 청크**에 데이터가 들어있다.
리더보드 배열은 클라이언트 컴포넌트의 `initialSkills` prop으로 임베드된다.

실측한 항목 스키마(정규화 전 원본):
```json
{
  "source": "vercel-labs/skills",   // GitHub org/repo (두 세그먼트)
  "skillId": "find-skills",          // 스킬 식별자 (':' 포함 가능, 예 "react:components")
  "name": "find-skills",             // 표시명 (보통 skillId와 동일)
  "installs": 2294978,               // 누적 설치수
  "weeklyInstalls": [113924, ... 8개], // 8주치 배열 (UI의 "8W activity" 스파크라인)
  "isOfficial": true                 // 선택 필드: 공식/벤더 repo에만 true, 아니면 필드 자체 생략
}
```
- 홈에서 **약 600개** 항목이 한 번에 임베드됨(전체 리더보드가 페이지에 실려 옴).
- manager2 스키마와 차이 **`[확인됨]`**:
  - `id` 필드가 리더보드 payload에는 **없다**(검색 API에서만 합성됨).
  - `installs`는 그대로 존재(= 다운로드/설치수).
  - `source`는 `org/user` 단독이 아니라 **`org/repo` 두 세그먼트**다. (manager2가 "source(=GitHub org/user)"라 본 건 부정확.)
  - 신규 필드: `weeklyInstalls`(8원소), `isOfficial`(선택).
- `[불확실]` `weeklyInstalls` 8개 원소의 시간 순서(최신-우선 vs 과거-우선), 그리고 원소 합이 `installs`와 일치하지 않음 — 의미 미확정. 정렬/표시에 쓰지 말 것.

### 2-b. 검색 `/api/search` — 순수 JSON `[확인됨]`

실측 응답(`fixtures/skillssh/search-sample.json`에 원본 보관):
```json
{
  "query": "code",
  "searchType": "fuzzy",
  "skills": [
    { "id": "agentspace-so/runcomfy-agent-skills/codex-pet",
      "skillId": "codex-pet", "name": "codex-pet",
      "installs": 294787, "source": "agentspace-so/runcomfy-agent-skills" }
  ],
  "count": 5,
  "duration_ms": 451
}
```
- 항목 필드: `id`, `skillId`, `name`, `installs`, `source`. **`weeklyInstalls`·`isOfficial`은 검색 결과엔 없음**(리더보드 전용).
- **`id = source + "/" + skillId` = `org/repo/skillId`** 형태로 검색 API가 합성해 준다. `[확인됨]`
- `limit`: `limit=300`→300개 반환, `limit=500`→여전히 200(하드캡 미관측). `[확인됨]`
- 빈/1글자 `q` → **HTTP 400** `{"error":"Query must be at least 2 characters"}`. `[확인됨]`

## 3. GitHub repo 해석 가능성 `[확인됨 — 단, 서브경로는 CLI 위임]`

- **repo URL**: `source`가 그대로 `org/repo`이므로 `https://github.com/{source}` / `https://github.com/{source}.git`로 **확실히 만들 수 있다.** 상위 항목 4개(`vercel-labs/skills`, `anthropics/skills`, `microsoft/azure-skills`, `agentspace-so/runcomfy-agent-skills`) 모두 GitHub API에서 HTTP 200으로 실재 확인. `[확인됨]`
- **skillId → repo 내 하위 폴더**: 규칙이 **repo마다 다르다**. `[확인됨 — 통일 규칙 없음]`
  - `anthropics/skills`, `vercel-labs/skills`: 스킬이 `skills/{skillId}/`에 위치(예 `skills/frontend-design`, `skills/find-skills`).
  - `mattpocock/skills`: `skills/` 대신 카테고리 폴더(`engineering/`, `personal/` …)로 분류 — `skills/{skillId}` 규칙 **깨짐**.
  - `agentspace-so/runcomfy-agent-skills`, `google-labs-code/stitch-skills`: 최상위 `skills/` 폴더가 **아예 없음**.
  - ⇒ "무조건 `skills/{skillId}`를 clone/추출"하는 규칙은 **틀린다.**
- **실제 설치 메커니즘(핵심)** `[확인됨]`: skills.sh 상세 페이지는 모든 레이아웃의 스킬에 대해 아래 명령을 그대로 안내한다.
  ```
  npx skills add https://github.com/{source} --skill {skillId}
  ```
  즉 **하위 경로 탐색은 `skills` npm CLI(`vercel-labs/skills`, npm 패키지명 `skills`, latest 1.5.14, "The open agent skills ecosystem")가 담당**한다. 레이아웃이 제각각이어도 `source`(repo) + `skillId`만 있으면 이 CLI가 알아서 폴더를 찾는다.
  - 레이아웃이 다른 3개 repo 상세 페이지에서도 동일 형식 확인:
    `npx skills add https://github.com/mattpocock/skills --skill grill-me`,
    `npx skills add https://github.com/agentspace-so/runcomfy-agent-skills --skill codex-pet`.

## 4. 안정성 평가 `[확인됨 / 일부 불확실]`

- **공식/문서화 API 여부** `[확인됨: 비공식/미문서]`: `/api/search`는 동작하지만 **문서화되지 않았고, robots.txt가 명시적으로 차단**한다.
  실측 `robots.txt`:
  ```
  User-Agent: *
  Allow: /
  Disallow: /internal/
  Disallow: /debug-security/
  Disallow: /search
  Disallow: /api/
  Sitemap: https://www.skills.sh/sitemap.xml
  ```
  ⇒ `/api/`와 `/search`는 **크롤 금지 대상**. 우리가 쓰려는 `/api/search`가 여기 걸린다.
- **rate limit** `[불확실]`: 응답에 `RateLimit-*`·`Retry-After` 헤더 없음. 명시적 한도는 미관측이나, **없다고 보장 못 함**(비공식 API라 예고 없이 차단·변경 가능).
- **캐시** `[확인됨]`: `/api/search` 응답 `Cache-Control: public, max-age=0, must-revalidate` — 서버측 캐시 신호 사실상 없음. 우리 쪽에서 자체 캐시 TTL을 둬야 함.
- **취약 지점** `[확인됨]`:
  1. 홈 리더보드는 `__NEXT_DATA__`가 아니라 RSC(`self.__next_f`) 청크 파싱 필요 → Next 버전 업 시 포맷 변동 위험 큼.
  2. `/api/search`는 robots.txt 차단 + 비공식 → 언제든 스키마/경로/차단 정책 변경 가능.
  3. `skillId`에 `:` 등 특수문자 포함 가능 → URL 인코딩·경로 처리 주의.

## 5. 라이선스 / 출처 표기 `[불확실 / 실측 불가]`

- skills.sh 자체의 데이터 재사용 라이선스·ToS 문구는 이번 조사에서 확정 인용 못 함. `[실측 불가]`
- 각 스킬의 라이선스는 **원본 GitHub repo**를 따른다(예: `microsoft/azure-skills`엔 `LICENSE` 파일 존재). 설치·표시 시 **repo 링크와 출처(`source`)를 노출**하는 게 안전. robots.txt가 `/api/` 크롤을 막는 만큼, 대량·자동 폴링은 피하고 사용자 트리거 기반 호출 + 캐시 권장.

---

## SK1 구현 권고 (바로 사용 가능)

1. **1차 엔드포인트**: 검색은 `GET https://skills.sh/api/search?q={q}&limit={n}`(순수 JSON, `q`는 2글자 이상). 리더보드/인기목록은 **JSON API가 없으므로** `https://skills.sh/`(또는 `/trending`,`/hot`) HTML을 받아 `self.__next_f` RSC 청크에서 `initialSkills` 배열을 파싱. robots.txt가 `/api/`·`/search`를 막으므로 **자동 폴링 금지·사용자 트리거 + 저빈도**로만.
2. **파싱**: 리더보드는 `\"source\":...\"skillId\":...\"installs\":N,\"weeklyInstalls\":[...]...` 정규식/청크 파싱(오프라인 fixture `fixtures/skillssh/leaderboard-sample.json`로 테스트). 검색은 `response.skills[]`를 그대로 매핑. 스키마 정규화 시 `id` 부재(리더보드)·`weeklyInstalls`/`isOfficial` 부재(검색)를 optional로.
3. **repo 해석**: repo URL = `https://github.com/{source}(.git)`. 하위 폴더는 **`skills/{skillId}` 가정 금지** — 레이아웃이 repo마다 다르다. 설치는 우리 git clone 경로 재사용하되 실제 스킬 디렉터리 탐색은 `source`+`skillId` 기반으로 CLI(`npx skills add https://github.com/{source} --skill {skillId}`) 동작을 참고(=repo 클론 후 `skillId`로 폴더를 검색·매칭하는 로직 필요, 단순 하위경로 조인 X).
4. **캐시 TTL 제안**: 서버 캐시 신호가 `max-age=0`이라 자체 캐시 필수. 리더보드 6~24h, 검색 5~15분 정도 TTL 권장(비공식 API 부하·차단 리스크 완화).
5. **취약 지점 요약**: (a) RSC 포맷은 Next 업글 시 깨질 수 있음 — 파싱 실패 시 graceful degrade, (b) `/api/`는 robots 차단·비공식 → 차단/스키마 변경 대비 fixture 기반 테스트 + 실패 격리, (c) `skillId` 특수문자 인코딩 주의.
