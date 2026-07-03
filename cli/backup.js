'use strict';
// 배포본은 git 밖이므로, 덮어쓰기 전에 타임스탬프 폴더로 백업한다.
// 잘못 쓰면 백업에서 복구할 수 있게 한다 (plan 안전장치).
//
// UX-D1: 백업 시 원위치(targetPath) 등을 manifest.json에 함께 남겨 "복구" 동선을 만든다.
//  - backupFile : 기존 시그니처(targetPath, tool) 유지 + 선택 meta로 추가 정보 수집.
//  - listBackups: backupRoot 스캔 → 최신순 목록(과거 manifest 없는 백업은 targetPath:null=복구불가).
//  - restoreBackup: 경로 탈출 차단 + 대상 화이트리스트 검증 + 복구 전 현재 파일 재백업 후 복사.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const projects = require('./projects');

const MANIFEST = 'manifest.json';

// 한 타임스탬프 폴더의 manifest를 읽는다(없으면 null).
function readManifest(dir) {
  const mf = path.join(dir, MANIFEST);
  if (!fs.existsSync(mf)) return null;
  try {
    return JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch {
    return null; // 손상된 manifest는 없는 것으로 취급(우아한 실패)
  }
}

// manifest에 항목 1건을 추가(append)한다. 같은 타임스탬프 폴더에 여러 파일이
// 백업될 수 있으므로(예: store apply → 3개 도구 동시 push) entries 배열로 누적한다.
function appendManifest(dir, entry) {
  const mf = path.join(dir, MANIFEST);
  let data = readManifest(dir);
  if (!data || !Array.isArray(data.entries)) {
    data = { timestamp: path.basename(dir), entries: [] };
  }
  data.entries.push(entry);
  fs.writeFileSync(mf, JSON.stringify(data, null, 2));
}

// targetPath의 현재 파일을 backups/<timestamp>/<tool>-<basename>로 복사.
// 파일이 없으면(신규 생성) 백업할 게 없으므로 null 반환.
//
// meta(선택): { kind, item } — 어떤 트랙/항목의 백업인지 기록용. 호출부가 넘기지 않아도
//   targetPath에서 유추 가능한 범위(도구/파일명)만 남는다. 기존 2인자 호출은 그대로 동작.
function backupFile(targetPath, tool, meta = {}) {
  if (!fs.existsSync(targetPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(paths.backupRoot(), stamp);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${tool}-${path.basename(targetPath)}`);
  fs.copyFileSync(targetPath, dest);
  // 복구에 필요한 정보를 manifest에 남긴다(원위치 절대경로·도구·항목·시각).
  appendManifest(dir, {
    file: path.basename(dest),
    targetPath: path.resolve(targetPath),
    tool: tool || null,
    kind: meta.kind || null,
    item: meta.item || null,
    at: new Date().toISOString(),
    size: fs.statSync(dest).size,
  });
  return dest;
}

// backupRoot 아래 모든 타임스탬프 폴더를 스캔 → 최신순 목록.
// manifest가 있으면 entries의 targetPath/tool을 붙이고, 없으면(과거 백업) targetPath:null.
function listBackups() {
  const root = paths.backupRoot();
  if (!fs.existsSync(root)) return [];
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const out = dirs.map((name) => {
    const dir = path.join(root, name);
    const mf = readManifest(dir);
    // manifest의 entries를 파일명 기준으로 조회할 수 있게 map 구성.
    const byFile = new Map();
    if (mf && Array.isArray(mf.entries)) {
      for (const e of mf.entries) byFile.set(e.file, e);
    }
    // 실제 백업 파일(manifest.json 제외)을 나열하고 manifest 정보를 붙인다.
    const files = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((f) => f.isFile() && f.name !== MANIFEST)
      .map((f) => f.name);
    const entries = files.map((file) => {
      const e = byFile.get(file) || {};
      let size = e.size;
      if (size == null) {
        try {
          size = fs.statSync(path.join(dir, file)).size;
        } catch {
          size = null;
        }
      }
      return {
        file,
        backupFilePath: path.join(dir, file),
        targetPath: e.targetPath || null, // null = 복구 불가(과거 백업, 원위치 정보 없음)
        tool: e.tool || null,
        kind: e.kind || null,
        item: e.item || null,
        at: e.at || null,
        size,
        restorable: !!e.targetPath,
      };
    });
    return { timestamp: name, dir, entries };
  });

  // 최신순(타임스탬프 폴더명은 ISO 파생이라 문자열 역순 = 시간 역순).
  out.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  return out;
}

// 경로 p가 base 디렉토리 하위(또는 자신)인지 — 심볼릭/상대경로 탈출 차단용.
function isInside(base, p) {
  const rb = path.resolve(base);
  const rp = path.resolve(p);
  if (rp === rb) return true;
  const rel = path.relative(rb, rp);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// (보안 가드) restore 대상 targetPath가 paths가 정의한 "정당한 배포 위치"인지 검증한다.
// 정당한 위치 = 각 도구의:
//   ① 글로벌 지시문 파일(instructionPath)  ② agents 폴더 하위(agentDir)  ③ skills 대상 폴더 하위(skillTargetDir)
//   ④ 등록된 프로젝트의 skill/agent 배포 폴더(스코프 인지 동기화의 push 대상과 대칭)
// 그 외 경로(임의 경로/도구 홈 밖)면 false → restore가 임의 파일을 덮어쓰지 못하게 막는다.
// (현재 push/agentPush/skillPush가 실제로 쓰는 위치와 정확히 대칭.)
function isLegitTarget(targetPath) {
  const rp = path.resolve(targetPath);
  for (const tool of paths.TOOLS) {
    // ① 지시문: 정확히 그 파일
    if (rp === path.resolve(paths.instructionPath(tool))) return true;
    // ② agent: agents 폴더 하위
    if (isInside(paths.agentDir(tool), rp)) return true;
    // ③ skill: skillTargetDir 하위
    if (isInside(paths.skillTargetDir(tool), rp)) return true;
  }
  // ④ 프로젝트 스코프: "등록된" 프로젝트의 배포 폴더만(임의 경로 차단은 그대로 유지).
  let projList = [];
  try { projList = projects.list(); } catch { /* 레지스트리 읽기 실패 = 프로젝트 대상 불허 */ }
  for (const proj of projList) {
    for (const src of paths.projectSkillSources(proj.root)) {
      if (isInside(src.dir, rp)) return true;
    }
    for (const tool of paths.TOOLS) {
      if (isInside(paths.projectAgentDir(proj.root, tool), rp)) return true;
    }
  }
  return false;
}

// 백업 파일 하나를 원위치로 복구한다.
//  ① 경로 검증 — backupFilePath가 backupRoot 하위인지(경로 탈출 차단)
//  ② manifest에서 해당 파일의 targetPath 조회 + 화이트리스트 검증(도구 홈 하위의 지시문/agents/skills만)
//  ③ 복구 전 현재 파일을 먼저 백업(안전망)
//  ④ 복사 복구
// 반환: { restored, targetPath, preRestoreBackup }
function restoreBackup({ backupFilePath }) {
  if (!backupFilePath) throw new Error('backupFilePath가 필요합니다');
  const root = paths.backupRoot();
  const abs = path.resolve(backupFilePath);

  // ① 경로 탈출 차단 — 반드시 backupRoot 하위여야 한다.
  if (!isInside(root, abs)) {
    throw new Error('백업 경로가 backups 폴더 밖입니다(거부): ' + abs);
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error('백업 파일이 없습니다: ' + abs);
  }
  // 심볼릭 링크 하드닝 — 링크를 실제 경로로 풀어본 뒤에도 backups 하위인지 재검증.
  // (backups 안에 밖을 가리키는 링크를 심어 밖의 파일을 읽게 하는 우회 차단)
  if (!isInside(fs.realpathSync(root), fs.realpathSync(abs))) {
    throw new Error('백업 경로가 backups 폴더 밖을 가리킵니다(거부): ' + abs);
  }
  if (path.basename(abs) === MANIFEST) {
    throw new Error('manifest는 복구 대상이 아닙니다');
  }

  // ② manifest에서 원위치(targetPath) 조회.
  const dir = path.dirname(abs);
  const mf = readManifest(dir);
  const entry = mf && Array.isArray(mf.entries)
    ? mf.entries.find((e) => e.file === path.basename(abs))
    : null;
  if (!entry || !entry.targetPath) {
    throw new Error('이 백업에는 원위치 정보(manifest)가 없어 복구할 수 없습니다: ' + abs);
  }
  const targetPath = path.resolve(entry.targetPath);

  // 대상 화이트리스트 검증 — 도구 홈 하위의 정당한 위치가 아니면 거부(임의 쓰기 방지).
  if (!isLegitTarget(targetPath)) {
    throw new Error('복구 대상이 허용된 배포 위치가 아닙니다(거부): ' + targetPath);
  }

  // ③ 복구 전 현재 파일을 먼저 백업(안전망) — 현재 파일이 있을 때만.
  const preRestoreBackup = backupFile(targetPath, entry.tool || 'restore', {
    kind: entry.kind,
    item: entry.item,
  });

  // ④ 복사 복구.
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(abs, targetPath);

  return { restored: true, targetPath, preRestoreBackup };
}

module.exports = { backupFile, listBackups, restoreBackup };
