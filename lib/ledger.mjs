import { later } from './calendar.mjs';
import { verify } from './verify.mjs';

export const FORMAT_VERSION = 1;

export function emptyProgress() {
  return {
    baselineComplete: false,
    checkpoint: null,
    cutoff: null,
    committed: [],
    backfills: [],
    running: null
  };
}

function copyRecord(record) {
  const copy = { id: record.id, datestamp: record.datestamp, deleted: record.deleted };
  if (record.title !== undefined) copy.title = record.title;
  return copy;
}

function freezeWindow(window) {
  return {
    from: window.from,
    until: window.until,
    kind: window.kind,
    status: window.status,
    pages: window.pages,
    documents: window.documents,
    records: window.records,
    retirements: window.retirements,
    startedAt: window.startedAt ?? null,
    completedAt: window.completedAt ?? null,
    reason: window.reason ?? null
  };
}

function sameContent(left, right) {
  return left.deleted === right.deleted && left.title === right.title;
}

export function createLedger({ sourceId, base, clock } = {}) {
  const now = clock?.() ?? new Date().toISOString();
  return {
    version: FORMAT_VERSION,
    sourceId: sourceId ?? null,
    base: base ?? null,
    createdAt: now,
    updatedAt: now,
    baseline: null,
    progress: emptyProgress(),
    records: [],
    windows: [],
    commits: [],
    conflicts: []
  };
}

/** 长期进度只由已提交的常规窗口推导；补采窗口不参与。 */
export function deriveCheckpoint(progress) {
  if (!progress.baselineComplete) return null;
  return progress.committed.reduce((value, window) => later(value, window.until), null);
}

export function committedWindows(ledger) {
  return ledger.windows.filter(window => window.status === 'committed');
}

/**
 * 把窗口效果与长期版本对照：
 * - 更新的 datestamp 覆盖旧版本；
 * - 旧 datestamp 不覆盖新版本（重叠区重采幂等）；
 * - 同 datestamp 不同内容无法裁决，返回冲突，整窗不得提交。
 */
export function planCommit(ledger, { upserts, retirements, checkpoint }) {
  const current = new Map(ledger.records.map(record => [record.id, record]));
  const conflicts = [];
  const effective = [];
  for (const incoming of upserts.map(copyRecord)) {
    const existing = current.get(incoming.id);
    if (!existing) {
      effective.push(incoming);
      continue;
    }
    if (incoming.datestamp > existing.datestamp) {
      effective.push(incoming);
      continue;
    }
    if (incoming.datestamp < existing.datestamp) continue;
    if (!sameContent(existing, incoming)) {
      conflicts.push({
        id: incoming.id,
        datestamp: incoming.datestamp,
        versions: [copyRecord(existing), copyRecord(incoming)]
      });
    }
  }
  return {
    conflicts,
    effects: {
      upserts: effective,
      retirements,
      checkpoint: conflicts.length === 0 ? checkpoint : null
    }
  };
}

/**
 * 提交一个在截止日内完整覆盖的窗口。只有引擎确认所有页面到达、且整窗
 * 无冲突时才调用；本函数只改内存账本，落盘顺序由 lib/state.mjs 控制。
 */
export function commitWindow(ledger, source, { kind, clock } = {}) {
  const committedAt = clock?.() ?? new Date().toISOString();
  const commitId = `${source.from}..${source.until}#${ledger.commits.length + 1}`;
  const recordMap = new Map(ledger.records.map(record => [record.id, copyRecord(record)]));
  for (const record of source.effects.upserts) recordMap.set(record.id, copyRecord(record));
  ledger.commits.push({
    id: commitId,
    kind,
    from: source.from,
    until: source.until,
    pages: source.pages,
    documents: source.documents,
    records: source.records,
    retirements: source.retirements,
    changed: source.effects.upserts.length,
    committedAt
  });
  ledger.records = [...recordMap.values()].sort((left, right) => left.id.localeCompare(right.id));
  ledger.windows.push(freezeWindow({
    from: source.from,
    until: source.until,
    kind,
    status: 'committed',
    pages: source.pages,
    documents: source.documents,
    records: source.records,
    retirements: source.retirements,
    startedAt: source.startedAt,
    completedAt: committedAt
  }));
  if (kind === 'backfill') {
    ledger.progress.backfills.push({ from: source.from, until: source.until, commitId });
  } else {
    ledger.progress.committed.push({ from: source.from, until: source.until, kind, commitId });
    if (source.effects.checkpoint !== null) {
      ledger.progress.checkpoint = later(ledger.progress.checkpoint, source.effects.checkpoint);
    }
    if (kind === 'baseline' && !ledger.progress.baselineComplete) {
      ledger.progress.baselineComplete = true;
      ledger.baseline = { from: source.from, until: source.until, completedAt: committedAt };
    }
  }
  ledger.progress.running = null;
  ledger.updatedAt = committedAt;
  return ledger;
}

export function recordConflict(ledger, source, conflicts, { clock } = {}) {
  const now = clock?.() ?? new Date().toISOString();
  ledger.conflicts.push({
    from: source.from,
    until: source.until,
    kind: source.kind,
    reason: '同日内容冲突',
    versions: conflicts,
    observedAt: now
  });
  ledger.windows.push(freezeWindow({
    from: source.from,
    until: source.until,
    kind: source.kind,
    status: 'conflict',
    pages: source.pages,
    documents: source.documents,
    records: source.records,
    retirements: source.retirements,
    startedAt: source.startedAt,
    completedAt: now,
    reason: '同日内容冲突'
  }));
  ledger.progress.running = null;
  ledger.updatedAt = now;
  return ledger;
}

/** 下游唯一可见的视图：完全由已提交日志推导，进行中窗口不会出现。 */
export function harvestView(ledger) {
  const checkpoint = deriveCheckpoint(ledger.progress);
  const recordView = ledger.records.map(copyRecord);
  const committed = committedWindows(ledger).map(window => ({
    from: window.from,
    until: window.until,
    kind: window.kind,
    status: window.status,
    pages: window.pages,
    documents: window.documents,
    records: window.records,
    retirements: window.retirements,
    completedAt: window.completedAt
  }));
  const view = {
    records: recordView,
    tombs: recordView.filter(record => record.deleted).map(copyRecord),
    windows: committed,
    sourceWindows: ledger.commits.map(commit => ({
      from: commit.from,
      until: commit.until,
      kind: commit.kind,
      pages: commit.pages,
      documents: commit.documents,
      records: commit.records,
      retirements: commit.retirements,
      committedAt: commit.committedAt
    })),
    checkpoint,
    baseline: ledger.baseline ? { ...ledger.baseline } : null,
    progress: {
      baselineComplete: ledger.progress.baselineComplete,
      checkpoint,
      cutoff: ledger.progress.cutoff ?? null,
      committed: ledger.progress.committed.map(window => ({ ...window })),
      backfills: ledger.progress.backfills.map(window => ({ ...window }))
    },
    conflicts: ledger.conflicts.map(conflict => ({
      from: conflict.from,
      until: conflict.until,
      kind: conflict.kind,
      reason: conflict.reason,
      versions: conflict.versions.map(version => ({
        id: version.id,
        datestamp: version.datestamp,
        versions: version.versions.map(record => copyRecord(record))
      })),
      observedAt: conflict.observedAt
    })),
    updatedAt: ledger.updatedAt
  };
  verify(view);
  return view;
}

/** 恢复元数据：说明哪些窗口仍未完成，供重启后解释与续采。 */
export function progressView(ledger) {
  const running = ledger.progress.running;
  const attemptCount = running ? running.attempts.length : 0;
  const pageCount = running ? running.attempts.reduce((sum, item) => sum + item.pages.length, 0) : 0;
  const documents = running ? running.attempts.reduce((sum, item) => sum + item.documents, 0) : 0;
  return {
    version: FORMAT_VERSION,
    sourceId: ledger.sourceId,
    base: ledger.base,
    updatedAt: ledger.updatedAt,
    baseline: ledger.baseline,
    progress: {
      baselineComplete: ledger.progress.baselineComplete,
      checkpoint: deriveCheckpoint(ledger.progress),
      cutoff: ledger.progress.cutoff ?? null,
      committed: ledger.progress.committed.map(window => ({ ...window })),
      backfills: ledger.progress.backfills.map(window => ({ ...window })),
      running: running
        ? {
            from: running.from,
            until: running.until,
            kind: running.kind,
            pages: pageCount,
            documents,
            attempts: attemptCount,
            reopened: running.reopened,
            startedAt: running.startedAt
          }
        : null
    },
    unfinished: running
      ? [{
          from: running.from,
          until: running.until,
          kind: running.kind,
          pages: pageCount,
          documents,
          reopened: running.reopened,
          attempts: running.attempts.map(attempt => ({
            number: attempt.number,
            status: attempt.status,
            pages: attempt.pages.length,
            documents: attempt.documents
          }))
        }]
      : [],
    conflictWindows: ledger.windows
      .filter(window => window.status === 'conflict')
      .map(window => ({
        from: window.from, until: window.until, kind: window.kind,
        status: window.status, completedAt: window.completedAt
      })),
    conflicts: ledger.conflicts.map(conflict => ({
      from: conflict.from,
      until: conflict.until,
      kind: conflict.kind,
      reason: conflict.reason,
      versions: conflict.versions.map(version => ({
        id: version.id,
        datestamp: version.datestamp,
        versions: version.versions.map(record => copyRecord(record))
      })),
      observedAt: conflict.observedAt
    }))
  };
}
