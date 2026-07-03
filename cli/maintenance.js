'use strict';
// Phase 2 유지보수 로직: 사용량 조회(usage) + 점검 패스(review) + 제안 staging + archive.
// 원칙(plan2.md): 자동 적용 없음 — 전부 제안 → 승인/거절. 삭제 없음 — archive(복구 가능).
//
// telemetry(A 신호·노후화) + duplicate(중복 탐지)를 묶어 "제안"을 만들고,
// 승인 시에만 안전한 동작(archive 이동)을 한다. canonical 변경은 git 커밋(가능할 때).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const paths = require('./paths');
const canonical = require('./canonical');
const telemetry = require('./telemetry');
const duplicate = require('./duplicate');
const synclog = require('./synclog');

// 테스트 용이성: now 기준 시각을 환경변수로도 주입 가능(AAD_NOW). 없으면 현재.
function defaultNow() {
  return process.env.AAD_NOW ? new Date(process.env.AAD_NOW) : new Date();
}

// canonical 변경 커밋(로컬 전용). git 미초기화/변경없음이면 조용히 스킵(더미 모드 등).
// 주의: canonical 폴더 "자체"가 git 저장소일 때만 커밋한다. 자체 저장소가 아니면
// rev-parse가 상위(프로젝트) 저장소에서 성공해 add -A가 저장소 전체를 커밋해버리므로
// toplevel == canonicalRoot 을 확인하고, add도 canonical 하위로만 한정한다.
function gitCommit(message) {
  const cwd = paths.canonicalRoot();
  let top;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return;
  }
  try {
    if (path.resolve(fs.realpathSync(top)) !== path.resolve(fs.realpathSync(cwd))) return;
  } catch {
    return;
  }
  try {
    execFileSync('git', ['add', '-A', '--', '.'], { cwd, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', message], { cwd, stdio: 'ignore' });
  } catch {
    /* 변경 없음 등 무시 */
  }
}

// 모든 canonical 항목을 { id, name, text, type } 로 모은다(중복 탐지/표시용).
function collectItems() {
  const items = [];
  const instr = canonical.read('instr-global');
  if (instr) items.push({ id: 'instr-global', name: 'instr-global', text: instr.body, type: 'instruction' });
  for (const a of canonical.listAgents()) {
    items.push({ id: a.id, name: a.name, text: `${a.description || ''}\n${a.system_prompt || ''}`, type: 'agent' });
  }
  for (const meta of canonical.listSkills()) {
    const s = canonical.readSkill(meta.name);
    items.push({ id: meta.id, name: meta.name, text: s ? s.body : '', type: 'skill' });
  }
  return items;
}

// ---------- 사용량 조회(A 신호 + 상태 + LRU) ----------
function usage(now, thresholds) {
  const nowDate = now || defaultNow();
  telemetry.recompute(nowDate, thresholds); // A 재계산(사이드카 갱신)
  const rows = telemetry.list(nowDate, thresholds).map((x) => ({
    ...x,
    lastActivity: telemetry.latestActivity(x.telemetry),
  }));
  // LRU: 활동이 오래된(또는 없는) 순으로 정렬
  rows.sort((a, b) => (a.lastActivity || '').localeCompare(b.lastActivity || ''));
  return { now: nowDate.toISOString(), items: rows };
}

// ---------- 제안 staging 저장소 ----------
function proposalsPath() {
  return path.join(paths.canonicalRoot(), '.proposals.json');
}
function loadProposals() {
  try {
    return JSON.parse(fs.readFileSync(proposalsPath(), 'utf8')) || [];
  } catch {
    return [];
  }
}
function saveProposals(list) {
  fs.mkdirSync(paths.canonicalRoot(), { recursive: true });
  fs.writeFileSync(proposalsPath(), JSON.stringify(list, null, 2) + '\n');
}

// ---------- 점검 패스(review) ----------
// 재계산 → 상태 전이 → 제안 생성. dryRun이면 리포트만, 아니면 staging + 리포트.
function review({ now, thresholds, dryRun = false } = {}) {
  const nowDate = now || defaultNow();
  telemetry.recompute(nowDate, thresholds);
  const states = telemetry.list(nowDate, thresholds);
  const items = collectItems();

  const proposals = [];
  let seq = 0;
  const nextId = (k) => `prop-${k}-${++seq}`;
  const churnTrigger = (thresholds && thresholds.churnTrigger) || 5;

  // 1) archived 상태 + 미pin → archive 제안(승인 시 실제 이동, 복구 가능)
  for (const x of states) {
    if (x.state === 'archived' && !x.telemetry.pinned) {
      proposals.push({
        id: nextId('archive'),
        kind: 'archive',
        target: x.id,
        title: `'${x.id}' 장기 미사용 → archive`,
        detail: '상태 archived. canonical archive 영역으로 이동(복구 가능, 삭제 아님).',
        status: 'pending',
      });
    }
  }
  // 2) 중복/유사 → consolidate 제안(정보형: 자동 병합하지 않고 사용자 판단)
  for (const pair of duplicate.findDuplicates(items, {})) {
    proposals.push({
      id: nextId('dup'),
      kind: 'consolidate',
      target: [pair.a.id, pair.b.id],
      title: `유사 항목: ${pair.a.name} ↔ ${pair.b.name} (score ${pair.score.toFixed(2)})`,
      detail: `${pair.reasons.join('; ')} — 통합할지 / 둘 다 둘지 선택.`,
      status: 'pending',
    });
  }
  // 3) churn 높음 → 새 버전/분리 제안(정보형)
  for (const x of states) {
    if ((x.telemetry.churn_count || 0) >= churnTrigger && !x.telemetry.pinned) {
      proposals.push({
        id: nextId('version'),
        kind: 'version',
        target: x.id,
        title: `'${x.id}' 자주 수정됨(churn ${x.telemetry.churn_count}) → 새 버전/분리?`,
        detail: '편집이 잦음. 새 버전으로 올리거나 reference로 분리 검토.',
        status: 'pending',
      });
    }
  }

  const report = {
    ran_at: nowDate.toISOString(),
    counts: { items: items.length, proposals: proposals.length },
    states: states.reduce((acc, x) => ((acc[x.state] = (acc[x.state] || 0) + 1), acc), {}),
    proposals,
  };

  if (!dryRun) {
    saveProposals(proposals); // 모든 변경은 staging(자동 적용 없음)
    writeReport(report, nowDate);
    synclog.recordReview(); // 마지막 점검 시각 기록
    gitCommit(`review: 제안 ${proposals.length}개 staging`);
  }
  return { dryRun, report };
}

// 리포트(run.json + REPORT.md)를 canonical/reports/<timestamp>/ 에 남긴다(감사 가능).
function writeReport(report, nowDate) {
  const stamp = nowDate.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(paths.canonicalRoot(), 'reports', stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(report, null, 2) + '\n');
  const md = [
    '# Review 리포트',
    '',
    `- 실행: ${report.ran_at}`,
    `- 항목 수: ${report.counts.items}`,
    `- 제안 수: ${report.counts.proposals}`,
    '',
    '## 상태 분포',
    ...Object.entries(report.states).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## 제안',
    ...(report.proposals.length ? report.proposals.map((p) => `- [${p.kind}] ${p.title}`) : ['- (없음)']),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'REPORT.md'), md);
}

// ---------- 대기 제안 + 승인/거절 ----------
function pending() {
  return loadProposals().filter((p) => p.status === 'pending');
}

function approve(id) {
  const list = loadProposals();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('제안을 찾을 수 없습니다: ' + id);
  if (p.status !== 'pending') throw new Error('이미 처리된 제안입니다: ' + id);

  // archive 제안만 실제(안전) 동작을 한다. consolidate/version은 정보형 → 승인 기록만.
  if (p.kind === 'archive') archiveItem(p.target);

  p.status = 'approved';
  saveProposals(list);
  gitCommit(`approve: ${id} (${p.kind})`);
  return p;
}

function reject(id) {
  const list = loadProposals();
  const p = list.find((x) => x.id === id);
  if (!p) throw new Error('제안을 찾을 수 없습니다: ' + id);
  p.status = 'rejected';
  saveProposals(list);
  return p;
}

// ---------- archive / restore (삭제 아님, 복구 가능) ----------
function moveInto(srcRel, destBaseRel) {
  const root = paths.canonicalRoot();
  const src = path.join(root, srcRel);
  if (!fs.existsSync(src)) return false;
  const dest = path.join(root, destBaseRel, srcRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(src, dest);
  return true;
}

// id 종류별로 canonical → archive/ 로 이동.
function archiveItem(id) {
  if (id.startsWith('skill-')) {
    const name = id.slice('skill-'.length);
    moveInto(path.join('skills', name), 'archive');
  } else if (id.startsWith('agent-')) {
    moveInto(path.join('agents', `${id}.json`), 'archive');
  } else if (id === 'instr-global') {
    moveInto(path.join('instructions', `${id}.md`), 'archive');
    moveInto(path.join('instructions', `${id}.meta.json`), 'archive');
  } else {
    throw new Error('archive 대상 종류를 알 수 없습니다: ' + id);
  }
  // telemetry 상태도 archived로 표시
  const data = telemetry.load();
  if (data[id]) {
    data[id].state = 'archived';
    telemetry.save(data);
  }
  gitCommit(`archive: ${id}`);
}

// archive/ 에서 원위치로 복구.
function restoreItem(id) {
  const root = paths.canonicalRoot();
  const archiveBase = path.join(root, 'archive');
  const move = (rel) => {
    const src = path.join(archiveBase, rel);
    if (!fs.existsSync(src)) return false;
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return true;
  };
  let ok = false;
  if (id.startsWith('skill-')) ok = move(path.join('skills', id.slice('skill-'.length)));
  else if (id.startsWith('agent-')) ok = move(path.join('agents', `${id}.json`));
  else if (id === 'instr-global') {
    ok = move(path.join('instructions', `${id}.md`));
    move(path.join('instructions', `${id}.meta.json`));
  }
  if (!ok) throw new Error('복구할 archive 항목이 없습니다: ' + id);
  gitCommit(`restore: ${id}`);
  return { restored: id };
}

module.exports = {
  usage,
  review,
  pending,
  approve,
  reject,
  archiveItem,
  restoreItem,
  loadProposals,
};
