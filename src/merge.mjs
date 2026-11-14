import { InvalidWindowError, SourceConflictError } from './errors.mjs';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validRecord(record) {
  return record !== null &&
    typeof record === 'object' &&
    typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.datestamp === 'string' && DATE.test(record.datestamp) &&
    typeof record.deleted === 'boolean' &&
    (record.title === undefined || typeof record.title === 'string');
}

export function normalizeRecord(record) {
  if (!validRecord(record)) {
    throw new InvalidWindowError(`源端返回了无法解释的记录：${JSON.stringify(record)}`);
  }
  const normalized = { id: record.id, datestamp: record.datestamp, deleted: record.deleted };
  if (record.title !== undefined) normalized.title = record.title;
  return normalized;
}

function fingerprint(record) {
  return JSON.stringify(record);
}

/**
 * 窗口内跨页合并。
 * 不依赖页内顺序或最后一条记录作为水位：所有收到的记录都以标识+datestamp
 * 判定版本，跨页重复只计一次，旧版本不会覆盖新版本。
 * 相同标识、相同 datestamp 但内容不同视为不可判定冲突。
 */
export function createWindowAccumulator(window) {
  const versions = new Map(); // id -> Map(datestamp -> record)
  const conflicts = [];
  let pages = 0;
  let documents = 0;
  let duplicates = 0;

  function merge(record) {
    const byDate = versions.get(record.id) ?? new Map();
    versions.set(record.id, byDate);
    const existing = byDate.get(record.datestamp);
    if (existing) {
      if (fingerprint(existing) !== fingerprint(record)) {
        let conflict = conflicts.find(item => item.id === record.id && item.datestamp === record.datestamp);
        if (!conflict) {
          conflict = { id: record.id, datestamp: record.datestamp, versions: [{ ...existing }] };
          conflicts.push(conflict);
        }
        if (!conflict.versions.some(version => fingerprint(version) === fingerprint(record))) {
          conflict.versions.push({ ...record });
        }
      } else {
        duplicates += 1;
      }
      return;
    }
    byDate.set(record.datestamp, record);
  }

  function addPage(payload) {
    if (!payload || !Array.isArray(payload.records)) {
      throw new InvalidWindowError('源端页面缺少 records 数组', window);
    }
    if (payload.window && (payload.window.from !== window.from || payload.window.until !== window.until)) {
      throw new InvalidWindowError(
        `源端返回的窗口 ${payload.window.from}..${payload.window.until} 与请求 ${window.from}..${window.until} 不一致`,
        window
      );
    }
    pages += 1;
    for (const raw of payload.records) {
      const record = normalizeRecord(raw);
      if (record.datestamp < window.from || record.datestamp > window.until) {
        throw new InvalidWindowError(
          `记录 ${record.id} 的日期 ${record.datestamp} 落在窗口 ${window.from}..${window.until} 之外`,
          window
        );
      }
      documents += 1;
      merge(record);
    }
    const token = payload.resumptionToken;
    if (token !== null && token !== undefined && typeof token !== 'string') {
      throw new InvalidWindowError('源端 resumptionToken 不是字符串', window);
    }
    return { token: token ?? null, pageRecords: payload.records.length };
  }

  function snapshotConflicts() {
    return conflicts.map(entry => ({
      id: entry.id,
      datestamp: entry.datestamp,
      versions: entry.versions.map(version => ({ ...version }))
    }));
  }

  /**
   * 整窗结束后的确定性版本选择：每个标识保留 datestamp 最大的版本，
   * 墓碑也参与版本比较。任一同日内容冲突都使整窗不可提交。
   */
  function resolve() {
    if (conflicts.length > 0) throw new SourceConflictError(window, snapshotConflicts());
    const upserts = [];
    let retirements = 0;
    for (const [, byDate] of versions) {
      const newest = [...byDate.keys()].sort().at(-1);
      const record = { ...byDate.get(newest) };
      if (record.deleted) retirements += 1;
      upserts.push(record);
    }
    return { upserts, retirements, conflicts: [] };
  }

  function stats() {
    const unique = [...versions.values()].reduce((sum, byDate) => sum + byDate.size, 0);
    return { pages, documents, duplicates, unique };
  }

  return { window, addPage, resolve, snapshotConflicts, stats };
}
