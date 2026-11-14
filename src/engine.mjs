import { listPage, SourceError } from './client.mjs';
import { assertDate } from '../lib/calendar.mjs';
import {
  commitWindow,
  deriveCheckpoint,
  harvestView,
  planCommit,
  recordConflict
} from '../lib/ledger.mjs';
import { saveLedger, saveView } from '../lib/state.mjs';
import { createWindowAccumulator, normalizeRecord } from './merge.mjs';
import {
  HarvestError,
  InvalidWindowError,
  SourceConflictError,
  TokenExpiredError
} from './errors.mjs';

export const MAX_REOPENS = 3;

function nowOf(clock) {
  return (clock ?? (() => new Date().toISOString()))();
}

function sameWindow(running, window, kind) {
  return running !== null &&
    running.from === window.from &&
    running.until === window.until &&
    running.kind === kind;
}

function newAttempt(running, clock) {
  const attempt = {
    number: running.attempts.length + 1,
    startedAt: nowOf(clock),
    status: 'open',
    token: null,
    pages: [],       // 每页的原始记录；恢复与跨尝试合并的唯一依据
    documents: 0
  };
  running.attempts.push(attempt);
  return attempt;
}

function verifyPage(payload, window) {
  if (!payload || !Array.isArray(payload.records)) {
    throw new InvalidWindowError('源端页面缺少 records 数组', window);
  }
  if (payload.window && (payload.window.from !== window.from || payload.window.until !== window.until)) {
    throw new InvalidWindowError(
      `源端返回的窗口 ${payload.window.from}..${payload.window.until} 与请求 ${window.from}..${window.until} 不一致`,
      window
    );
  }
  const token = payload.resumptionToken;
  if (token !== null && token !== undefined && typeof token !== 'string') {
    throw new InvalidWindowError('源端 resumptionToken 不是字符串', window);
  }
  const records = payload.records.map(raw => {
    const record = normalizeRecord(raw);
    if (record.datestamp < window.from || record.datestamp > window.until) {
      throw new InvalidWindowError(
        `记录 ${record.id} 的日期 ${record.datestamp} 落在窗口 ${window.from}..${window.until} 之外`,
        window
      );
    }
    return record;
  });
  return { records, token: token ?? null };
}

function mergeRunning(running) {
  const accumulator = createWindowAccumulator({ from: running.from, until: running.until });
  let documents = 0;
  for (const attempt of running.attempts) {
    for (const page of attempt.pages) {
      accumulator.addPage({ records: page, resumptionToken: null });
      documents += page.length;
    }
  }
  return { accumulator, documents };
}

function windowSpec(window, kind) {
  return { from: window.from, until: window.until, kind };
}

/**
 * 采集一个时间窗并（仅当整窗完整）提交。
 *
 * 持久化顺序：
 *  1. 窗口打开 → 写 running；
 *  2. 每页到达并校验 → 写 running（含该页记录）；
 *  3. 所有页面 token=null → 合并、版本裁决；
 *  4. 无冲突 → 先写恢复账本（含新提交，running=null），再写下游 harvest.json。
 *
 * 任何时刻退出都不会让下游看到半窗口；令牌失效只重开窗口，已收文档按
 * 标识+datestamp 去重，不会重复入账或倒退版本。
 */
export async function harvestWindow(context, { window, kind = 'daily' } = {}) {
  const {
    paths, state, base, hooks = {}, clock, pageDelay = 0
  } = context;
  const client = context.client ?? listPage;
  if (!window || typeof window.from !== 'string' || typeof window.until !== 'string') {
    throw new InvalidWindowError('缺少时间窗');
  }
  assertDate(window.from, '窗口开始日期');
  assertDate(window.until, '窗口截止日期');
  if (window.from > window.until) throw new InvalidWindowError('窗口开始晚于截止', window);

  const existing = state.progress.running;
  if (existing && !sameWindow(existing, window, kind)) {
    throw new HarvestError(
      `仍有未完成窗口 ${existing.from}..${existing.until}（${existing.kind}），先运行 resume 入口`,
      { code: 'unfinishedWindow', window: { from: existing.from, until: existing.until, kind: existing.kind } }
    );
  }
  const resuming = existing !== null;
  const running = existing ?? {
    ...windowSpec(window, kind),
    startedAt: nowOf(clock),
    reopened: 0,
    attempts: []
  };
  state.progress.running = running;
  const completedAttempt = running.attempts.find(item => item.status === 'complete') ?? null;
  // 每次进程启动都从窗口第一页重读：源端可能在重试/重启后重新划页，
  // 旧令牌的偏移量不再可信。已收页面仍在账本里，按标识+datestamp 合并去重。
  let attempt = completedAttempt ? null : newAttempt(running, clock);
  await saveLedger(paths, state);
  await hooks.afterOpen?.({ window, kind, resuming, reopened: running.reopened });

  // 上次退出前已经收到整窗最后一页：不必再访问源端，直接进入提交。
  if (!completedAttempt) {
    for (;;) {
      let payload;
      try {
        payload = attempt.pages.length === 0
          ? await client(base, { from: window.from, until: window.until })
          : await client(base, { from: window.from, until: window.until, resumptionToken: attempt.token });
      } catch (error) {
        if (error instanceof SourceError && error.code === 'badResumptionToken') {
          attempt.status = 'expired';
          if (running.reopened >= MAX_REOPENS) {
            await saveLedger(paths, state);
            throw new TokenExpiredError(window, `令牌连续失效 ${MAX_REOPENS} 次，窗口仍未完成`);
          }
          running.reopened += 1;
          attempt = newAttempt(running, clock);
          await saveLedger(paths, state);
          await hooks.afterReopen?.({ window, kind, attempt: attempt.number, reopened: running.reopened });
          continue;
        }
        attempt.status = 'failed';
        await saveLedger(paths, state);
        throw error;
      }

      const page = verifyPage(payload, window);
      await hooks.afterReceive?.({ window, page });
      attempt.pages.push(page.records);
      attempt.documents += page.records.length;
      attempt.token = page.token;
      if (page.token === null) attempt.status = 'complete';
      await saveLedger(paths, state);
      await hooks.afterPage?.({
        window,
        kind,
        attempt: attempt.number,
        pages: running.attempts.reduce((sum, item) => sum + item.pages.length, 0),
        documents: running.attempts.reduce((sum, item) => sum + item.documents, 0),
        token: page.token
      });
      if (page.token === null) break;
      if (pageDelay) await new Promise(resolve => setTimeout(resolve, pageDelay));
    }
  }

  const { accumulator, documents } = mergeRunning(running);
  const resolved = (() => {
    try {
      return accumulator.resolve();
    } catch (error) {
      if (error instanceof SourceConflictError) return { conflict: error };
      throw error;
    }
  })();

  const pageCount = running.attempts.reduce((sum, item) => sum + item.pages.length, 0);
  const source = {
    ...windowSpec(window, kind),
    pages: pageCount,
    documents,
    records: resolved.upserts?.length ?? 0,
    retirements: resolved.retirements ?? 0,
    startedAt: running.startedAt
  };
  await hooks.afterResolve?.({ window, kind, state });

  if (resolved.conflict) {
    recordConflict(state, source, resolved.conflict.conflicts, { clock });
    const view = harvestView(state);
    await saveLedger(paths, state);
    await saveView(paths, view);
    await hooks.afterConflict?.({ window, kind, conflicts: resolved.conflict.conflicts });
    return { status: 'conflict', ...windowSpec(window, kind), conflicts: resolved.conflict.conflicts };
  }

  const checkpoint = kind === 'backfill' ? null : window.until;
  const plan = planCommit(state, {
    upserts: resolved.upserts,
    retirements: resolved.retirements,
    checkpoint
  });
  if (plan.conflicts.length > 0) {
    recordConflict(state, source, plan.conflicts, { clock });
    const view = harvestView(state);
    await saveLedger(paths, state);
    await saveView(paths, view);
    await hooks.afterConflict?.({ window, kind, conflicts: plan.conflicts });
    return { status: 'conflict', ...windowSpec(window, kind), conflicts: plan.conflicts };
  }

  commitWindow(state, { ...source, effects: plan.effects }, { kind, clock });
  // 先验证并生成下游视图，再按“账本 → 视图”的顺序落盘。两者之间退出时
  // 账本已经包含完整提交，重启会用账本补齐视图，下游不会看到半窗口。
  const view = harvestView(state);
  await saveLedger(paths, state);
  await hooks.afterStateCommit?.({ window, kind, state });
  await saveView(paths, view);
  await hooks.afterCommit?.({ window, kind, view });
  return {
    status: 'committed',
    ...windowSpec(window, kind),
    checkpoint: deriveCheckpoint(state.progress),
    records: state.records.length,
    pages: pageCount,
    documents
  };
}

export function unfinishedWindow(state) {
  const running = state.progress.running;
  if (!running) return null;
  return {
    from: running.from,
    until: running.until,
    kind: running.kind,
    pages: running.attempts.reduce((sum, attempt) => sum + attempt.pages.length, 0),
    documents: running.attempts.reduce((sum, attempt) => sum + attempt.documents, 0),
    reopened: running.reopened,
    attempts: running.attempts.map(attempt => ({
      number: attempt.number,
      status: attempt.status,
      pages: attempt.pages.length,
      documents: attempt.documents
    }))
  };
}

export { SourceConflictError, TokenExpiredError };
