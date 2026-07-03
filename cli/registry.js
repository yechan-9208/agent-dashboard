'use strict';
// 원격 레지스트리 코어 (스토어-R1) — 토큰 불필요 git clone 방식.
//
// ── 개념 차용(NOTICE) ──────────────────────────────────────────────
// 아래 두 오픈소스의 "개념"만 참고했다. 코드 복사가 아니라 아이디어 차용이며,
// 스택도 다르다(별도 구현):
//   - skills-manage  (Apache-2.0): 레지스트리 = GitHub 저장소 모델,
//       저장소 안 SKILL.md 레이아웃 3종(루트 / <dir>/SKILL.md / skills/**/SKILL.md).
//   - skills-manager2 (MIT):       git clone + 커밋 해시로 버전/업데이트 추적.
// ────────────────────────────────────────────────────────────────────
//
// 설계 원칙:
//  - 토큰 불필요: GitHub API 대신 공개 repo를 `git clone --depth 1`(rate limit 없음).
//    업데이트 감지는 `git ls-remote <url> HEAD`(1줄 통신).
//  - 저장소당 1회 clone → 그 안의 스킬 전부 카탈로그에 병합.
//  - 외부 통신은 사용자 트리거(새로고침/업데이트 버튼·CLI 명령)에서만 — 자동 폴링/백그라운드
//    fetch 없음(D14·D25). clone 대상은 등록된 레지스트리 URL만.
//  - git 실행은 execFile(비셸)만 사용(URL 인젝션 방지) + 타임아웃 + 등록된 URL만 대상.
//  - .git 폴더는 파싱 후 캐시에서 제거(용량·시크릿 위생).

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const matter = require('gray-matter');

const paths = require('./paths');

const GIT_TIMEOUT_MS = 30000; // git clone/ls-remote 타임아웃

// ── registries.json 읽기/쓰기 ────────────────────────────────────────
function load() {
  const file = paths.registriesFile();
  if (!fs.existsSync(file)) return { version: 1, registries: [], defaultsOverlay: {} };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.registries)) return { version: 1, registries: [], defaultsOverlay: {} };
    return {
      version: data.version || 1,
      registries: data.registries,
      // 기본(official) 레지스트리의 revision/last_refreshed 오버레이(번들 원본은 정적).
      defaultsOverlay: (data.defaultsOverlay && typeof data.defaultsOverlay === 'object') ? data.defaultsOverlay : {},
    };
  } catch {
    return { version: 1, registries: [], defaultsOverlay: {} };
  }
}

function save(reg) {
  // 병합 산출물이 실수로 저장되지 않도록, official(기본) 항목은 절대 registries.json에
  // 기록하지 않는다. defaultsOverlay(있으면)는 그대로 보존한다.
  const src = Array.isArray(reg) ? { version: 1, registries: reg } : (reg || {});
  const data = {
    version: src.version || 1,
    registries: (src.registries || []).filter((r) => !r.official),
  };
  if (src.defaultsOverlay && typeof src.defaultsOverlay === 'object') data.defaultsOverlay = src.defaultsOverlay;
  const file = paths.registriesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

// ── 기본(번들) 레지스트리 ────────────────────────────────────────────
// catalog/default-registries.json = 정적 번들(D16 철학). 절대 런타임에 쓰지 않는다.
// 없거나 깨져도 빈 배열로 폴백(사용자 것만 살아남는다).
function defaultRegistriesPath() {
  if (process.env.AAD_DEFAULT_REGISTRIES) return process.env.AAD_DEFAULT_REGISTRIES;
  // catalog.json과 같은 디렉토리에 둔다(catalogPath 기준).
  return path.join(path.dirname(paths.catalogPath()), 'default-registries.json');
}

// v2(publishers[]→repos[]) 우선 파싱, v1(평면 registries[]) fallback.
// 반환: repo 단위로 평탄화한 배열(각 항목이 clone 대상 레지스트리 1개).
//   { id, name(owner/repo), url, branch, official, publisher, publisherSlug, skillCountCurated }
function loadDefaults() {
  const file = defaultRegistriesPath();
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];

  // v2: publishers[] → repos[] 평탄화.
  if (Array.isArray(data.publishers)) {
    const out = [];
    for (const pub of data.publishers) {
      if (!pub || !Array.isArray(pub.repos)) continue;
      const publisher = pub.name || pub.slug || '';
      const publisherSlug = pub.slug || slugify(String(pub.id || pub.name || ''));
      for (const repo of pub.repos) {
        if (!repo || !repo.url || !repo.id) continue;
        out.push({
          id: String(repo.id),
          name: repo.name || ownerRepoOf(repo.url),
          url: String(repo.url),
          branch: repo.branch || 'main',
          official: true, // 기본은 항상 official
          publisher,
          publisherSlug,
          skillCountCurated:
            typeof repo.skillCountCurated === 'number' ? repo.skillCountCurated : null,
        });
      }
    }
    return out;
  }

  // v1 fallback: 평면 registries[].
  if (Array.isArray(data.registries)) {
    return data.registries
      .filter((r) => r && r.url && r.id)
      .map((r) => ({
        id: String(r.id),
        name: r.name || ownerRepoOf(r.url),
        url: String(r.url),
        branch: r.branch || 'main',
        official: true,
      }));
  }

  return [];
}

// URL 정규화(중복 제거 기준). slugify를 그대로 재사용 — 같은 repo면 같은 slug.
function normalizeUrl(url) {
  return slugify(url);
}

// ── 자동 카테고리화(fetch 시 태그 부여) ──────────────────────────────
// 데이터 원본(catalog/*.json)은 불변이며, 여기서는 "읽기"만 한다.
function catalogDir() {
  return path.dirname(paths.catalogPath());
}
function loadJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
// skill-tags.json → [{key, ko, en}]. 없으면 빈 배열(휴리스틱만 스킵).
let _tagDefsCache = null;
function loadTagDefs() {
  if (_tagDefsCache) return _tagDefsCache;
  const data = loadJsonSafe(path.join(catalogDir(), 'skill-tags.json'));
  _tagDefsCache = data && Array.isArray(data.tags) ? data.tags : [];
  return _tagDefsCache;
}
// recommended-skills.json → repo+name 매칭용 인덱스. 없으면 빈 맵.
let _recIndexCache = null;
function loadRecommendedIndex() {
  if (_recIndexCache) return _recIndexCache;
  const data = loadJsonSafe(path.join(catalogDir(), 'recommended-skills.json'));
  const map = new Map();
  if (data && Array.isArray(data.skills)) {
    for (const s of data.skills) {
      if (!s || !s.repoFullName || !s.name) continue;
      const key = String(s.repoFullName).toLowerCase() + ' ' + String(s.name).toLowerCase();
      map.set(key, Array.isArray(s.tags) ? s.tags.map((t) => String(t)) : []);
    }
  }
  _recIndexCache = map;
  return _recIndexCache;
}

// 유효한 태그 key 집합(skill-tags.json 기준). frontmatter 태그 필터에 쓴다.
function validTagKeys() {
  return new Set(loadTagDefs().map((t) => String(t.key)));
}

// 휴리스틱 키워드 → skill-tags key. name+description 문자열에서 매칭.
// 1차 소스는 skill-tags.json의 keywords 필드(카테고리 12종, v2). 아래 하드코딩은
// keywords 필드가 없는 옛 카탈로그를 위한 폴백(구 10종 키)일 뿐이다.
const TAG_KEYWORDS = {
  frontend: ['frontend', 'react', 'vue', 'css', 'tailwind', 'ui', 'ux', 'html', 'component', 'design system'],
  backend: ['backend', 'server', 'api', 'worker', 'serverless', 'edge function', 'runtime', 'microservice'],
  ecommerce: ['ecommerce', 'e-commerce', 'commerce', 'payment', 'checkout', 'stripe', 'shopify', 'cart', 'subscription'],
  app: ['app dev', 'mobile', 'flutter', 'react native', 'expo', 'android', 'ios', 'dart'],
  devops: ['devops', 'ci/cd', 'cicd', 'pipeline', 'terraform', 'infrastructure', 'deploy', 'kubernetes', 'docker', 'pulumi'],
  'ai-ml': ['ai', 'ml', 'machine learning', 'llm', 'langchain', 'model', 'transformer', 'huggingface', 'embedding', 'rag'],
  database: ['database', 'db', 'sql', 'postgres', 'postgresql', 'mysql', 'mongodb', 'redis', 'prisma', 'orm', 'migration', 'firestore'],
  security: ['security', 'secure', 'auth', 'authentication', 'authorization', 'oauth', 'sso', 'mfa', 'encryption', 'clerk', 'auth0'],
  testing: ['test', 'testing', 'monitor', 'monitoring', 'observability', 'tracing', 'logging', 'sentry', 'datadog', 'e2e'],
  docs: ['docs', 'documentation', 'design', 'figma', 'notion', 'diagram', 'writing'],
};

// name/description(+frontmatter tags/category)에서 skill-tags key 배열을 산출.
// 우선순위: (1) frontmatter tags/category 중 유효 key → (2) 휴리스틱 키워드.
// recommended-skills 오버라이드는 refresh()에서 repo+name 조인으로 별도 적용(최우선).
function categorize({ name, description, frontmatterTags, frontmatterCategory }) {
  const valid = validTagKeys();
  const out = [];
  const seen = new Set();
  const add = (k) => {
    const key = String(k).trim().toLowerCase();
    if (valid.has(key) && !seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  };

  // (1) frontmatter tags/category 중 유효 key.
  const fmRaw = []
    .concat(Array.isArray(frontmatterTags) ? frontmatterTags : frontmatterTags ? [frontmatterTags] : [])
    .concat(Array.isArray(frontmatterCategory) ? frontmatterCategory : frontmatterCategory ? [frontmatterCategory] : []);
  for (const t of fmRaw) add(t);
  if (out.length) return out;

  // (2) 휴리스틱: name+description 소문자에서 키워드/라벨을 "단어 경계"로 매칭.
  //     substring 매칭은 오탐이 많아(예: "plain"에 "ai") 단어 경계로 제한한다.
  const hay = (String(name || '') + ' ' + String(description || '')).toLowerCase();
  const hasWord = (needle) => {
    const n = String(needle).toLowerCase().trim();
    if (n.length < 2) return false;
    // needle이 여러 단어(공백/슬래시 포함)면 그대로 부분열, 단일 토큰이면 단어 경계.
    if (/[\s/]/.test(n)) return hay.includes(n);
    const re = new RegExp('(?:^|[^a-z0-9])' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[^a-z0-9]|$)');
    return re.test(hay);
  };
  const defs = loadTagDefs();
  for (const def of defs) {
    const key = String(def.key);
    const labels = [key, def.en, def.ko].filter(Boolean);
    const kws = (Array.isArray(def.keywords) && def.keywords.length ? def.keywords : TAG_KEYWORDS[key]) || [];
    const hit = labels.some((l) => hasWord(l)) || kws.some((kw) => hasWord(kw));
    if (hit) add(key);
  }
  return out;
}

// URL을 안정적인 슬러그 id로 정규화(중복 방지). 예:
//   https://github.com/foo/bar.git → github-com-foo-bar
//   git@github.com:foo/bar.git     → github-com-foo-bar
//   /tmp/local-repo                → tmp-local-repo
function slugify(url) {
  let s = String(url).trim();
  s = s.replace(/^https?:\/\//i, '').replace(/^ssh:\/\//i, '');
  s = s.replace(/^git@/i, '').replace(/:/g, '/'); // scp 형식 host:owner → host/owner
  s = s.replace(/\.git$/i, '');
  s = s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return s || 'reg';
}

// URL에서 owner/repo 형태 추정(source_ref 표기용). 못 구하면 슬러그 끝 2토막.
function ownerRepoOf(url) {
  let s = String(url).trim().replace(/\.git$/i, '');
  s = s.replace(/^https?:\/\/[^/]+\//i, ''); // https://host/ 제거
  s = s.replace(/^git@[^:]+:/i, ''); // git@host: 제거
  s = s.replace(/^ssh:\/\/[^/]+\//i, '');
  const parts = s.split('/').filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts.join('/') || slugify(url);
}

// 목록 — 기본(번들) + 사용자(registries.json) 병합.
//  - 기본은 official:true. 기본의 revision/last_refreshed는 registries.json의
//    defaultsOverlay[id]에서 오버레이(번들 원본은 정적 유지).
//  - 정규화 URL로 중복 제거: 사용자가 같은 url을 add했으면 기본 것을 유지(권장).
function list() {
  const user = load();
  const overlay = user.defaultsOverlay || {};
  const defaults = loadDefaults().map((d) => {
    const ov = overlay[d.id] || {};
    return {
      ...d,
      revision: ov.revision || null,
      last_refreshed: ov.last_refreshed || null,
    };
  });

  const seen = new Set(defaults.map((d) => normalizeUrl(d.url)));
  const out = [...defaults];
  for (const r of user.registries) {
    if (r.official) continue; // registries.json엔 기본이 없어야 하지만, 방어적으로 건너뜀
    const key = normalizeUrl(r.url);
    if (seen.has(key)) continue; // 기본과 같은 url → 기본 유지, 사용자 것 스킵
    seen.add(key);
    out.push({ ...r, official: false });
  }
  return out;
}

// ── 퍼블리셔 그룹핑(SKC1) ────────────────────────────────────────────
// 평탄화 기본 repos + 사용자 추가분 + 캐시(실제 항목 수)를 퍼블리셔 카드로 묶는다.
//   [{ name, slug, official, repoCount, totalSkillsCurated, actualSkillCount,
//      refreshedRepoCount, repos:[{id,name,url,curated,actual}] }]
//  - actualSkillCount: 캐시에 하나라도 있으면 Σ 실제 항목수, 없으면 null.
//  - 사용자 추가분은 {name:'사용자', slug:'user', official:false} 그룹으로.
function publishersList() {
  const entries = list(); // 평면(기본 + 사용자) — publisher/publisherSlug/branch/skillCountCurated 포함

  // repo id → 실제(캐시) 항목 수. 캐시 파일이 있으면 해당 repo는 "refreshed".
  const actualByRepo = new Map();
  for (const it of cachedItems()) {
    const rid = it.registry_id;
    if (!rid) continue;
    actualByRepo.set(rid, (actualByRepo.get(rid) || 0) + 1);
  }
  // 캐시 파일 존재 여부(0개짜리 repo도 refreshed로 카운트)로 refreshedRepoCount 산출.
  const refreshedRepoIds = new Set();
  try {
    const dir = paths.registryCacheDir();
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const m = /^registry-(.*)\.json$/.exec(f);
        if (m) refreshedRepoIds.add(m[1]);
      }
    }
  } catch {
    /* 캐시 디렉토리 없음 → refreshed 0 */
  }

  const groups = new Map(); // slug → 카드
  function ensureGroup(slug, name, official) {
    if (!groups.has(slug)) {
      groups.set(slug, {
        name,
        slug,
        official,
        repoCount: 0,
        totalSkillsCurated: 0,
        actualSkillCount: null,
        refreshedRepoCount: 0,
        repos: [],
        _totalSkillsOverride: null,
      });
    }
    return groups.get(slug);
  }

  // 퍼블리셔의 totalSkills(pub.totalSkills) 우선값을 별도로 뽑아 둔다.
  const pubTotals = new Map(); // slug → totalSkills
  const defaults = loadDefaultsRaw();
  for (const pub of defaults) pubTotals.set(pub.slug, pub.totalSkills);

  for (const r of entries) {
    const slug = r.official ? r.publisherSlug || 'official' : 'user';
    const name = r.official ? r.publisher || slug : '사용자';
    const g = ensureGroup(slug, name, !!r.official);
    g.repoCount += 1;
    const curated = typeof r.skillCountCurated === 'number' ? r.skillCountCurated : null;
    if (curated != null) g.totalSkillsCurated += curated;
    const actual = actualByRepo.has(r.id) ? actualByRepo.get(r.id) : refreshedRepoIds.has(r.id) ? 0 : null;
    if (actual != null) {
      g.actualSkillCount = (g.actualSkillCount || 0) + actual;
    }
    if (refreshedRepoIds.has(r.id)) g.refreshedRepoCount += 1;
    g.repos.push({ id: r.id, name: r.name, url: r.url, curated, actual });
  }

  // totalSkillsCurated = pub.totalSkills(있으면) 우선, 없으면 Σ skillCountCurated.
  const out = [];
  for (const g of groups.values()) {
    const pubTotal = pubTotals.get(g.slug);
    if (typeof pubTotal === 'number') g.totalSkillsCurated = pubTotal;
    delete g._totalSkillsOverride;
    out.push(g);
  }
  return out;
}

// default-registries.json의 publisher 원본(그룹 메타: totalSkills 등)만 뽑는다.
function loadDefaultsRaw() {
  const file = defaultRegistriesPath();
  const data = fs.existsSync(file) ? loadJsonSafe(file) : null;
  if (data && Array.isArray(data.publishers)) {
    return data.publishers.map((p) => ({
      slug: p.slug || slugify(String(p.id || p.name || '')),
      name: p.name || p.slug || '',
      totalSkills: typeof p.totalSkills === 'number' ? p.totalSkills : null,
    }));
  }
  return [];
}

// 등록만 — 통신하지 않는다(refresh에서 clone).
function add(url, { name } = {}) {
  if (!url || typeof url !== 'string') throw new Error('레지스트리 URL이 필요합니다');
  const trimmed = url.trim();
  const id = slugify(trimmed);
  const reg = load();
  // 사용자 목록 중복
  if (reg.registries.some((r) => r.id === id)) {
    return { added: false, reason: 'duplicate', id };
  }
  // 기본(번들)과 같은 url이면 이미 목록에 노출되므로 추가 거부(중복).
  const key = normalizeUrl(trimmed);
  const dup = loadDefaults().find((d) => normalizeUrl(d.url) === key);
  if (dup) {
    return { added: false, reason: 'duplicate-default', id: dup.id };
  }
  const entry = {
    id,
    name: name || ownerRepoOf(trimmed),
    url: trimmed,
    added_at: new Date().toISOString(),
  };
  reg.registries.push(entry);
  save(reg);
  return { added: true, registry: entry };
}

function remove(id) {
  // 기본(official) 레지스트리는 제거 거부 — 번들 정적이라 사용자가 지울 수 없다.
  if (loadDefaults().some((d) => d.id === id)) {
    return { removed: false, id, reason: 'default', message: '기본 레지스트리는 제거할 수 없습니다: ' + id };
  }
  const reg = load();
  const before = reg.registries.length;
  reg.registries = reg.registries.filter((r) => r.id !== id);
  if (reg.registries.length === before) return { removed: false, id };
  save(reg);
  // 캐시 파일도 정리(있으면).
  try {
    const cacheFile = registryItemsFile(id);
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  } catch {
    /* 캐시 삭제 실패는 치명적 아님 */
  }
  return { removed: true, id };
}

// 병합 목록에서 id→레지스트리 해석(기본도 refresh 가능하도록 list() 사용).
function findRegistry(id) {
  return list().find((r) => r.id === id) || null;
}

// ── git 실행(비셸) ──────────────────────────────────────────────────
function runGit(args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // 출력에 토큰류가 섞일 여지 없음(공개 repo·토큰 미사용). 메시지만 전달.
        const msg = (stderr || err.message || '').toString().trim();
        return reject(new Error('git ' + args[0] + ' 실패: ' + msg));
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

// ── 캐시 파일 위치 ───────────────────────────────────────────────────
function registryItemsFile(id) {
  return path.join(paths.registryCacheDir(), 'registry-' + id + '.json');
}
function cloneDir(id) {
  return path.join(paths.registryCacheDir(), 'clone-' + id);
}

// 디렉토리 재귀 삭제(내장 rmSync 사용, 없으면 무시).
function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Node 구버전 fallback: 실패 시 조용히 넘어감 */
  }
}

// ── SKILL.md 탐색(레이아웃 3종 — skills-manage 개념) ─────────────────
//  1) 루트: <clone>/SKILL.md
//  2) <dir>/SKILL.md  (1단계 하위 폴더 각각)
//  3) skills/**/SKILL.md (skills 디렉토리 아래 재귀)
// 반환: [{ skillMdPath, dirName }]  (dirName = 스킬 이름 추정 fallback)
function findSkillFiles(root) {
  const found = [];
  const seen = new Set();
  function push(p, dirName) {
    const abs = path.resolve(p);
    if (seen.has(abs)) return;
    seen.add(abs);
    found.push({ skillMdPath: abs, dirName });
  }

  // 1) 루트
  const rootSkill = path.join(root, 'SKILL.md');
  if (fs.existsSync(rootSkill)) push(rootSkill, path.basename(root));

  // 2) 1단계 하위 폴더의 SKILL.md
  let topEntries = [];
  try {
    topEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    topEntries = [];
  }
  for (const e of topEntries) {
    if (!e.isDirectory() || e.name === '.git') continue;
    const p = path.join(root, e.name, 'SKILL.md');
    if (fs.existsSync(p)) push(p, e.name);
  }

  // 3) skills/**/SKILL.md (재귀)
  const skillsRoot = path.join(root, 'skills');
  if (fs.existsSync(skillsRoot)) {
    walkForSkillMd(skillsRoot, push, 0);
  }
  return found;
}

function walkForSkillMd(dir, push, depth) {
  if (depth > 6) return; // 방어적 깊이 제한
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walkForSkillMd(full, push, depth + 1);
    } else if (e.isFile() && e.name === 'SKILL.md') {
      push(full, path.basename(dir));
    }
  }
}

// frontmatter에서 name/description/tags 추출(gray-matter). 실패해도 dirName fallback.
function parseSkillMd(skillMdPath, dirName) {
  let raw = '';
  try {
    raw = fs.readFileSync(skillMdPath, 'utf8');
  } catch {
    raw = '';
  }
  let data = {};
  try {
    data = matter(raw).data || {};
  } catch {
    data = {};
  }
  const name = (data.name && String(data.name).trim()) || dirName;
  const description = data.description ? String(data.description).trim() : '';
  let tags = [];
  if (Array.isArray(data.tags)) tags = data.tags.map((t) => String(t).trim()).filter(Boolean);
  else if (typeof data.tags === 'string') tags = data.tags.split(',').map((t) => t.trim()).filter(Boolean);
  // category는 문자열/배열 모두 허용(자동 카테고리화 입력).
  let category = [];
  if (Array.isArray(data.category)) category = data.category.map((t) => String(t).trim()).filter(Boolean);
  else if (typeof data.category === 'string') category = data.category.split(',').map((t) => t.trim()).filter(Boolean);
  return { name, description, tags, category, body: raw };
}

// ── refresh: clone → 파싱 → 캐시 저장 → registries.json 갱신 ──────────
async function refresh(id) {
  const registry = findRegistry(id);
  if (!registry) throw new Error('등록되지 않은 레지스트리입니다: ' + id);
  const url = registry.url;

  // ① 캐시 디렉토리에 clone(이미 있으면 삭제 후 재clone — 단순하게).
  //    branch 필드가 있으면 --branch로 지정(하드코딩 main 금지). 없으면 기본 브랜치.
  const dir = cloneDir(id);
  fs.mkdirSync(paths.registryCacheDir(), { recursive: true });
  rmrf(dir);
  const cloneArgs = ['clone', '--depth', '1'];
  if (registry.branch) cloneArgs.push('--branch', String(registry.branch));
  cloneArgs.push(url, dir);
  await runGit(cloneArgs);

  // 커밋 해시(revision) 확보.
  let revision = null;
  try {
    const r = await runGit(['rev-parse', 'HEAD'], { cwd: dir });
    revision = r.stdout.trim() || null;
  } catch {
    revision = null;
  }

  // ③ SKILL.md 탐색 + ④ frontmatter 파싱 + 자동 카테고리화.
  const sourceRef = ownerRepoOf(url);
  const repoFullName = registry.name || sourceRef; // owner/repo (v2 repo.name)
  const publisher = registry.publisher || null;
  const publisherSlug = registry.publisherSlug || null;
  const recIndex = loadRecommendedIndex();
  const skillFiles = findSkillFiles(dir);
  const items = [];
  for (const sf of skillFiles) {
    const parsed = parseSkillMd(sf.skillMdPath, sf.dirName);
    // ⑤ 자동 태그: recommended(repo+name) 우선 → frontmatter → 휴리스틱.
    let tags;
    const recKey = String(repoFullName).toLowerCase() + ' ' + String(parsed.name).toLowerCase();
    if (recIndex.has(recKey)) {
      // recommended-skills.json의 태그를 유효 key로만 채택(최우선).
      const valid = validTagKeys();
      tags = recIndex.get(recKey).map((t) => String(t).toLowerCase()).filter((t) => valid.has(t));
    } else {
      tags = categorize({
        name: parsed.name,
        description: parsed.description,
        frontmatterTags: parsed.tags,
        frontmatterCategory: parsed.category,
      });
    }
    // ⑥ 스키마 = 기존 catalog.json 항목 + registry 출처 메타 + 퍼블리셔/소스repo.
    items.push({
      id: 'reg-' + id + '-' + parsed.name,
      kind: 'skill',
      name: parsed.name,
      tags,
      description: parsed.description,
      official: true,
      source: 'registry',
      source_type: 'registry',
      source_ref: sourceRef,
      source_revision: revision,
      registry_id: id,
      publisher,
      publisherSlug,
      sourceRepo: repoFullName,
      body: parsed.body,
    });
  }

  // ⑥ .git 폴더 제거(용량·시크릿 위생) — 캐시엔 파싱된 결과만 남긴다.
  rmrf(dir);

  // 캐시 파일 저장.
  const cacheFile = registryItemsFile(id);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({ version: 1, registry_id: id, source_ref: sourceRef, revision, generated_at: new Date().toISOString(), items }, null, 2) + '\n',
    'utf8'
  );

  // revision·last_refreshed 갱신.
  //  - 사용자 레지스트리: registries.json의 항목에 직접 기록.
  //  - 기본(official) 레지스트리: registries.json의 defaultsOverlay[id]에 기록
  //    (default-registries.json 번들 원본은 절대 쓰지 않는다 — 정적 유지).
  const now = new Date().toISOString();
  const reg = load();
  const target = reg.registries.find((r) => r.id === id);
  if (target) {
    target.revision = revision;
    target.last_refreshed = now;
    save(reg);
  } else {
    reg.defaultsOverlay = reg.defaultsOverlay || {};
    reg.defaultsOverlay[id] = { revision, last_refreshed: now };
    save(reg);
  }

  return { id, url, revision, source_ref: sourceRef, count: items.length, cacheFile };
}

// 캐시된 레지스트리 항목 전부 로드(store.js 병합용). 없으면 빈 배열.
function cachedItems() {
  const dir = paths.registryCacheDir();
  if (!fs.existsSync(dir)) return [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^registry-.*\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(data.items)) out.push(...data.items);
    } catch {
      /* 깨진 캐시 파일은 건너뜀 */
    }
  }
  return out;
}

// ── collectMissing: 시작 시 증분 수집 (F2-3) ─────────────────────────
// 등록된 레지스트리 중 "캐시가 없는 것만" clone(refresh)한다. 이미 캐시된 것은
// git ls-remote HEAD 해시가 캐시(저장 revision)와 다를 때만 재수집한다.
//  - 78개 전부 매번 clone 금지 — 캐시 존재 + 해시 동일이면 skip.
//  - concurrency 기본 2(최대 3). 레지스트리별 실패는 error로 기록하고 계속(전체 중단 금지).
//  - 진행 상태를 모듈 내부 상태로 유지하고 collectStatus()로 조회한다.
//  - 외부 통신은 "앱 실행=사용자 트리거"(D28)로 간주해 시작 훅에서만 kick한다(자동 폴링 아님).

// 모듈 내부 진행 상태 (collectStatus()로 조회).
let _collectState = { running: false, total: 0, done: 0, failed: 0, errors: [] };

function collectStatus() {
  // 방어적 복사(호출자가 errors 배열을 변형하지 못하게).
  return {
    running: _collectState.running,
    total: _collectState.total,
    done: _collectState.done,
    failed: _collectState.failed,
    errors: _collectState.errors.map((e) => ({ name: e.name, message: e.message })),
  };
}

// 캐시 파일의 저장 revision(있으면). 없거나 깨지면 null.
function cachedRevision(id) {
  try {
    const file = registryItemsFile(id);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && data.revision ? String(data.revision) : null;
  } catch {
    return null;
  }
}

// 한 레지스트리가 "재수집이 필요한지" 판정.
//  - 캐시 파일 없음 → 무조건 필요(미수집).
//  - 캐시 있음 → ls-remote HEAD 와 저장 revision 비교. 다르면 필요, 같으면 skip.
//    (ls-remote 실패 시엔 보수적으로 skip — 이미 캐시가 있으므로 기존 것 유지.)
async function needsCollect(reg) {
  const file = registryItemsFile(reg.id);
  if (!fs.existsSync(file)) return true; // 미수집 → clone
  const localRev = cachedRevision(reg.id);
  if (!localRev) return true; // 캐시는 있으나 revision 미상 → 재수집
  const out = await runGit(['ls-remote', reg.url, 'HEAD']);
  const remoteRev = (out.stdout.trim().split(/\s+/)[0] || '') || null;
  if (!remoteRev) return false; // 원격 해시 못 구함 → 기존 캐시 유지(skip)
  return remoteRev !== localRev; // 변경됐을 때만 재수집
}

// 증분 수집 실행. concurrency 워커로 병렬 처리(기본 2, 최대 3).
// 이미 실행 중이면 현재 상태만 돌려준다(중복 kick 방지).
async function collectMissing({ concurrency = 2 } = {}) {
  if (_collectState.running) return collectStatus();
  const conc = Math.max(1, Math.min(3, Number(concurrency) || 2));

  const registries = list();
  _collectState = { running: true, total: registries.length, done: 0, failed: 0, errors: [] };

  let cursor = 0;
  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= registries.length) return;
      const reg = registries[idx];
      try {
        let needed;
        try {
          needed = await needsCollect(reg);
        } catch (e) {
          // ls-remote 등 통신 실패: 이 레지스트리만 실패로 기록하고 계속.
          _collectState.failed += 1;
          _collectState.errors.push({ name: reg.name || reg.id, message: e.message });
          _collectState.done += 1;
          continue;
        }
        if (needed) {
          await refresh(reg.id); // clone→파싱→캐시(기존 파이프라인 재사용, .git 제거 포함)
        }
        _collectState.done += 1;
      } catch (e) {
        // refresh(clone) 실패: 이 레지스트리만 실패로 기록하고 계속.
        _collectState.failed += 1;
        _collectState.errors.push({ name: reg.name || reg.id, message: e.message });
        _collectState.done += 1;
      }
    }
  }

  const workers = [];
  for (let i = 0; i < conc; i++) workers.push(worker());
  try {
    await Promise.all(workers);
  } finally {
    _collectState.running = false;
  }
  return collectStatus();
}

// ── checkUpdates: git ls-remote HEAD 로 저장 revision과 비교 ──────────
// 통신 실패는 error로 기록만 하고 throw로 전체를 중단하지 않는다.
async function checkUpdates() {
  const registries = list();
  const results = [];
  for (const r of registries) {
    try {
      const out = await runGit(['ls-remote', r.url, 'HEAD']);
      const remoteRev = (out.stdout.trim().split(/\s+/)[0] || '') || null;
      const update_available = !!r.revision && !!remoteRev && r.revision !== remoteRev;
      results.push({ id: r.id, remote_revision: remoteRev, local_revision: r.revision || null, update_available });
    } catch (e) {
      results.push({ id: r.id, error: e.message, update_available: false });
    }
  }
  return results;
}

module.exports = {
  load,
  save,
  list,
  publishersList,
  add,
  remove,
  refresh,
  checkUpdates,
  cachedItems,
  categorize,
  // F2-3: 시작 시 증분 수집 + 진행 상태 조회
  collectMissing,
  collectStatus,
  // 테스트/내부용 유틸
  slugify,
  ownerRepoOf,
  findSkillFiles,
  registryItemsFile,
  loadDefaults,
  defaultRegistriesPath,
};
