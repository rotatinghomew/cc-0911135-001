import { identify } from './client.mjs';
import { assertDate } from '../lib/calendar.mjs';
import { createLedger, deriveCheckpoint, harvestView, progressView } from '../lib/ledger.mjs';
import { loadState, repairView, saveLedger } from '../lib/state.mjs';
import { readJsonIfPresent, storePaths, withLock } from '../lib/store.mjs';
import { verify } from '../lib/verify.mjs';
import { harvestWindow, unfinishedWindow } from './engine.mjs';
import { HarvestError, InvalidWindowError } from './errors.mjs';
import { dailyWindow, hasDailyWork, fullWindow, parseRange } from './windows.mjs';

const DEFAULT_OVERLAP = 1;

function nowIso() {
  return new Date().toISOString();
}

function windowFor(kind, state, cutoff, identity, options) {
  if (kind === 'baseline') {
    if (state.progress.baselineComplete && !state.progress.running) {
      throw new InvalidWindowError(
        `首轮全量已于 ${deriveCheckpoint(state.progress)} 完成；日常增量用 daily，重核旧范围用 backfill`
      );
    }
    const from = options.from ?? identity.earliest;
    return fullWindow(from, cutoff);
  }
  if (kind === 'daily') {
    const checkpoint = deriveCheckpoint(state.progress);
    if (!state.progress.baselineComplete || checkpoint === null) {
      throw new InvalidWindowError('尚未完成首轮全量，先运行 baseline 或使用 resume');
    }
    const overlapDays = options.overlapDays ?? DEFAULT_OVERLAP;
    if (checkpoint > cutoff) {
      throw new InvalidWindowError(
        `本轮截止日 ${cutoff} 早于长期进度 ${checkpoint}，不能倒退采集；补采旧日期请使用 backfill`,
        { from: checkpoint, until: cutoff }
      );
    }
    if (!hasDailyWork(checkpoint, cutoff)) return null;
    return dailyWindow(checkpoint, cutoff, { overlapDays });
  }
  if (kind === 'backfill') {
    return parseRange(options.range);
  }
  throw new InvalidWindowError(`未知采集类型 ${kind}`);
}

/**
 * 独占锁内的完整生命周期：加载账本 → 修复下游视图 → 采集 → 提交。
 * 进程退出时运行窗口留在账本里，下一次启动 resume/status 可以解释它。
 */
async function lifecycle(kind, options) {
  const {
    base, directory, client, clock = nowIso, hooks = {}, pageDelay = 0, cutoff: fixedCutoff
  } = options;
  if (!directory) throw new HarvestError('缺少结果目录 directory');
  if (kind !== 'status' && kind !== 'verify' && !base) throw new HarvestError('缺少源端地址 base');
  const paths = storePaths(directory);
  if (kind === 'verify') {
    // verify 是只读入口：不加载采集账本、不访问源端、不改动文件。
    const stored = await readJsonIfPresent(paths.harvest);
    if (stored === null) throw new HarvestError('还没有 harvest.json，尚未提交任何窗口', { code: 'noHarvest' });
    verify(stored);
    return { status: 'verified', checkpoint: stored.checkpoint, records: stored.records.length };
  }
  const state = await loadState(paths, { createLedger, sourceId: base, base });
  if (base && state.sourceId && state.sourceId !== base) {
    throw new HarvestError(`目录属于源端 ${state.sourceId}，拒绝写入 ${base}`, { code: 'sourceMismatch' });
  }
  if (base) state.sourceId = base;
  else state.sourceId = state.sourceId ?? null;
  // 账本领先于下游视图（提交后、视图写入前退出）时补齐；视图从不含半窗口。
  await repairView(paths, harvestView(state));
  const context = { paths, state, base, client, clock, hooks, pageDelay };

  if (kind === 'status') {
    return {
      checkpoint: deriveCheckpoint(state.progress),
      baseline: state.baseline,
      unfinished: unfinishedWindow(state),
      records: state.records.length,
      windows: state.windows,
      conflicts: state.conflicts,
      harvest: harvestView(state),
      progress: progressView(state)
    };
  }

  if (kind === 'resume') {
    const runningWindow = state.progress.running;
    if (!runningWindow) {
      return {
        status: 'idle',
        message: '没有未完成窗口，未访问源端',
        checkpoint: deriveCheckpoint(state.progress),
        harvest: harvestView(state)
      };
    }
    const result = await harvestWindow(context, {
      window: { from: runningWindow.from, until: runningWindow.until },
      kind: runningWindow.kind
    });
    return { ...result, harvest: harvestView(state), progress: progressView(state) };
  }

  const identity = await identify(base, options.clientOptions);
  const cutoff = fixedCutoff ?? identity.today;
  assertDate(cutoff, '本轮截止日');
  if (cutoff > identity.today) {
    throw new InvalidWindowError(`本轮截止日 ${cutoff} 晚于源端当前日期 ${identity.today}`);
  }
  if (options.from) assertDate(options.from, '起始日期');
  const window = windowFor(kind, state, cutoff, identity, options);
  if (window === null) {
    return {
      status: 'up-to-date',
      message: `长期进度已到 ${cutoff}，没有新的日期`,
      cutoff,
      checkpoint: deriveCheckpoint(state.progress),
      harvest: harvestView(state)
    };
  }
  // 固定本轮截止日，恢复时不会漂移到更晚日期。
  state.progress.cutoff = cutoff;
  await saveLedger(paths, state);

  const result = await harvestWindow(context, { window, kind });
  return {
    ...result,
    cutoff,
    harvest: harvestView(state),
    progress: progressView(state)
  };
}

export async function run(kind, options = {}) {
  const directory = options.directory;
  if (!directory) throw new HarvestError('缺少结果目录 directory');
  return withLock(directory, () => lifecycle(kind, options));
}

export const commands = {
  baseline: options => run('baseline', options),
  daily: options => run('daily', options),
  backfill: options => run('backfill', options),
  resume: options => run('resume', options),
  status: options => run('status', options),
  verify: options => run('verify', options)
};
