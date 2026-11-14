import { readJsonIfPresent, writeJsonAtomic } from './store.mjs';

/**
 * 两个文件的分工：
 * - harvest-state.json 是采集器恢复账本，含进行中窗口的已收页面；
 * - harvest.json 是下游唯一可见的提交视图，只可能整窗更新。
 *
 * 提交顺序：先写恢复账本（新提交日志 + running 清空），再写 harvest.json。
 * 若在两者之间退出，重启时由账本重建视图；下游要么看不到该窗口，要么看到
 * 完整窗口，绝不会看到半窗口或虚假 checkpoint。
 */
export async function loadState(paths, { createLedger, sourceId, base }) {
  const state = await readJsonIfPresent(paths.state);
  if (state !== null) {
    if (!state || typeof state !== 'object' || !Array.isArray(state.records) ||
      !state.progress || !Array.isArray(state.progress.committed) ||
      !Array.isArray(state.progress.backfills) || !Array.isArray(state.windows)) {
      throw new Error(`${paths.state} 不是有效的采集账本，拒绝在损坏状态下继续`);
    }
    return state;
  }
  const view = await readJsonIfPresent(paths.harvest);
  if (view === null) return createLedger({ sourceId, base });
  if (!view || typeof view !== 'object' || !Array.isArray(view.records) || !Array.isArray(view.windows)) {
    throw new Error(`${paths.harvest} 不是有效的采集结果`);
  }
  // 只有 harvest.json 的目录也能安全接管：已提交窗口是恢复的唯一依据。
  const committed = view.windows.filter(window => window.status === 'committed');
  if (committed.length !== view.windows.length) {
    throw new Error(`${paths.harvest} 含有未提交窗口，缺少 ${paths.state} 无法解释`);
  }
  return {
    ...createLedger({ sourceId, base }),
    baseline: view.baseline ?? null,
    records: view.records,
    windows: view.windows,
    conflicts: view.conflicts ?? [],
    updatedAt: view.updatedAt,
    progress: {
      baselineComplete: view.baseline !== null || committed.some(window => window.kind === 'baseline'),
      checkpoint: view.checkpoint ?? null,
      cutoff: view.progress?.cutoff ?? null,
      committed: committed.filter(window => window.kind !== 'backfill').map((window, index) => ({
        from: window.from,
        until: window.until,
        kind: window.kind,
        commitId: `${window.from}..${window.until}#${index + 1}`
      })),
      backfills: committed.filter(window => window.kind === 'backfill').map((window, index) => ({
        from: window.from,
        until: window.until,
        commitId: `${window.from}..${window.until}#b${index + 1}`
      })),
      running: null
    },
    commits: []
  };
}

/** 采集器账本：每页到达、窗口状态变化时写入。 */
export async function saveLedger(paths, state) {
  await writeJsonAtomic(paths.state, state);
}

export async function saveView(paths, view) {
  await writeJsonAtomic(paths.harvest, view);
}

/** 账本领先于下游视图（提交与视图写入之间退出）时，用账本补齐视图。 */
export async function repairView(paths, view) {
  await saveView(paths, view);
}
