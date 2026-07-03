'use strict';
// 프로젝트(저장소) 레지스트리 + "최초 1회" 디스크 스캔 (T1).
//
// 설계 원칙(사용자 결정): 디스크 스캔은 최초 1회(또는 사용자가 명시적으로 재스캔을
// 눌렀을 때)만 실행한다. 평소에는 projects.json에 저장된 목록(list)만 쓴다.
// 자동/백그라운드 스캔은 없다.
//
// ★ 보안 가드:
//  - scan()은 디렉토리 "이름/존재"만 본다. 어떤 파일의 내용도 읽지 않는다
//    (readdir/stat 계열만 사용 — fs.readFile 금지).
//  - 심볼릭 링크는 따라가지 않는다(무한 루프 방지).
//  - 모델 홈 자체(~/.claude·~/.codex·~/.agents 등)는 프로젝트가 아니므로 후보 제외.
//    (~/.gemini는 지원 중단 후에도 방어적으로 제외 목록에 유지.)
//  - EXCLUDE_DIRS와 숨김 디렉토리('.'로 시작)에는 하위 진입하지 않는다
//    (마커 존재 확인용 stat은 허용).

const fs = require('fs');
const os = require('os');
const path = require('path');
const paths = require('./paths');

// 프로젝트로 인정하는 마커 — 존재만 확인 (0번 검증 문서의 모델별 프로젝트 위치 기준)
// gemini 지원 중단(D31)으로 GEMINI.md/.gemini 마커 제거 — 2모델 체제.
const MARKERS = ['.claude', 'CLAUDE.md', 'AGENTS.md', '.agents', '.codex'];

// 하위 진입 금지 디렉토리 (성능·안전 — 진입만 금지, 마커 stat은 별개)
const EXCLUDE_DIRS = [
  'node_modules', '.git', 'Library', '.Trash', '.cache', '.npm', '.nvm',
  '.vscode', '.cursor', 'Applications', 'Music', 'Movies', 'Pictures',
];

// AAD(이 앱) 저장소 루트. paths가 아는 이 저장소 위치와 동일(cli/의 상위).
const AAD_ROOT = path.resolve(__dirname, '..');

// child가 parent(자기 자신 포함) 하위 경로인지 — 심볼릭/상대 판단 없이 명시적 문자열 경계 검사.
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// (실버그 방지) AAD 저장소의 fixtures/·.dummy/ 하위는 스캔 후보에서 제외한다.
//   과거 레지스트리에 이 앱 자신의 fixtures/projects/*가 프로젝트로 등록되는 사고가 있었다.
//   fixtures/·.dummy/는 D37(더미 모드 제거)로 삭제됐지만, 과거 체크아웃/잔여 폴더 방어용으로 유지.
function isAadInternalPath(dir) {
  const abs = path.resolve(dir);
  return isInside(abs, path.join(AAD_ROOT, 'fixtures')) || isInside(abs, path.join(AAD_ROOT, '.dummy'));
}

// 도구 홈 절대 경로 집합 — 스캔 후보에서 제외할 대상
function toolHomeSet() {
  const h = os.homedir();
  return new Set([
    path.join(h, '.claude'),
    path.join(h, '.codex'),
    path.join(h, '.gemini'),
    path.join(h, '.agents'),
  ]);
}

// 폴더에 존재하는 마커 목록. lstat으로 "존재"만 확인한다(내용 안 읽음).
function markersOf(dir) {
  const found = [];
  for (const m of MARKERS) {
    try {
      fs.lstatSync(path.join(dir, m));
      found.push(m);
    } catch {
      // 없음 — 통과
    }
  }
  return found;
}

// rootDir부터 트리를 내려가며 MARKERS 중 하나라도 있는 폴더를 후보로 수집한다.
//  - 후보 발견 시 그 폴더 하위로는 더 내려가지 않는다(중첩 프로젝트는 1차 범위 밖).
//  - 홈 디렉토리 자체는 후보로 삼지 않는다(홈의 .claude 등은 프로젝트 마커가 아니라
//    글로벌 도구 홈이므로) — 하위 탐색은 계속한다.
//  - 반환: [{ root, markers: [...] }]
function scan(rootDir, { maxDepth = 4 } = {}) {
  const found = [];
  const toolHomes = toolHomeSet();
  const home = os.homedir();
  const scanRootAbs = path.resolve(rootDir);
  // 사용자가 명시적으로 AAD 내부 경로를 루트로 지정한 경우만 예외 — 평소(홈 스캔)에는
  // AAD 내부 잔여 폴더를 만나면 그 후보만 제외한다(스캔 오염 방지).
  const scanRootIsAadInternal = isAadInternalPath(scanRootAbs);

  function walk(dir, depth) {
    if (toolHomes.has(dir)) return; // 도구 홈 자체는 프로젝트가 아님
    // AAD 자신의 fixtures/·.dummy/ 하위는 실제 스캔 후보에서 제외(스캔 오염 방지).
    if (!scanRootIsAadInternal && isAadInternalPath(dir)) return;
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch {
      return; // 접근 불가/없음 — 조용히 건너뜀
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return;

    if (dir !== home) {
      const markers = markersOf(dir);
      if (markers.length > 0) {
        found.push({ root: dir, markers });
        return; // 후보 발견 — 하위 진입 중단
      }
    }

    if (depth >= maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 권한 없음 등 — 조용히 건너뜀
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue; // 심볼릭 링크 안 따라감
      if (e.name.startsWith('.') || EXCLUDE_DIRS.includes(e.name)) continue; // 진입 금지
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  walk(path.resolve(rootDir), 0);
  return found;
}

// projects.json 읽기. 없거나 깨졌으면 기본값 {version:1, projects:[]}.
function load() {
  const file = paths.projectsFile();
  if (!fs.existsSync(file)) return { version: 1, projects: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.projects)) return { version: 1, projects: [] };
    return { version: data.version || 1, projects: data.projects };
  } catch {
    return { version: 1, projects: [] };
  }
}

// projects.json 쓰기 (paths.projectsFile 위치 — 모드별 canonical에 자동 격리).
// 레지스트리 객체({version, projects}) 또는 프로젝트 배열 둘 다 받는다.
function save(reg) {
  const data = Array.isArray(reg) ? { version: 1, projects: reg } : reg;
  const file = paths.projectsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

// 수동 등록: 존재하는 디렉토리 + 마커 1개 이상 확인, 중복(root)이면 무시.
function add(root) {
  const abs = path.resolve(root);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new Error('경로가 존재하지 않습니다: ' + abs);
  }
  if (!st.isDirectory()) throw new Error('디렉토리가 아닙니다: ' + abs);
  const markers = markersOf(abs);
  if (markers.length === 0) {
    throw new Error('프로젝트 마커(' + MARKERS.join('/') + ')가 없습니다: ' + abs);
  }
  const reg = load();
  if (reg.projects.some((p) => p.root === abs)) {
    return { added: false, reason: 'duplicate', root: abs };
  }
  const entry = { root: abs, markers, added_at: new Date().toISOString(), source: 'manual' };
  reg.projects.push(entry);
  save(reg);
  return { added: true, project: entry };
}

// 등록 해제 (root 절대경로 기준).
function remove(root) {
  const abs = path.resolve(root);
  const reg = load();
  const before = reg.projects.length;
  reg.projects = reg.projects.filter((p) => p.root !== abs);
  if (reg.projects.length === before) return { removed: false, root: abs };
  save(reg);
  return { removed: true, root: abs };
}

// 등록된 프로젝트 배열.
function list() {
  return load().projects;
}

// 프로젝트 root가 디스크에 실제로 존재하는 디렉토리인지(내용은 읽지 않음 — stat만).
//  접근 불가/없음/디렉토리 아님 → false. 심볼릭 링크는 대상 존재 여부로 판단(statSync).
function rootExists(root) {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

// 디스크에서 사라진 프로젝트(root가 더 이상 존재하지 않음)를 레지스트리에서 제거한다.
//  - stat만 사용(존재 확인) — 어떤 파일도 열지 않는다(보안 가드 유지).
//  - 반환: { removed: [root...], remaining: N }.
function prune() {
  const reg = load();
  const removed = [];
  const kept = [];
  for (const p of reg.projects) {
    if (rootExists(p.root)) kept.push(p);
    else removed.push(p.root);
  }
  if (removed.length > 0) {
    reg.projects = kept;
    save(reg);
  }
  return { removed, remaining: kept.length };
}

// scan() 결과를 레지스트리에 병합. 이미 등록된 root는 건너뛴다(source:'scan').
function adoptScan(candidates) {
  const reg = load();
  const known = new Set(reg.projects.map((p) => p.root));
  const adopted = [];
  for (const c of candidates || []) {
    if (!c || !c.root || known.has(c.root)) continue;
    const entry = {
      root: c.root,
      markers: Array.isArray(c.markers) ? c.markers : [],
      added_at: new Date().toISOString(),
      source: 'scan',
    };
    reg.projects.push(entry);
    known.add(c.root);
    adopted.push(entry);
  }
  if (adopted.length > 0) save(reg);
  return { adopted: adopted.length, total: reg.projects.length };
}

module.exports = { MARKERS, EXCLUDE_DIRS, scan, load, save, add, remove, list, adoptScan, rootExists, prune };
