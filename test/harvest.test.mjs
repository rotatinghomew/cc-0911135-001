import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { commands } from '../src/harvester.mjs';
import { readHarvest, readState, withSite } from './helpers.mjs';

const BASE = site => ({ base: site.url });

test('首轮全量：固定截止日、墓碑保留、窗口闭合', () => withSite(async (site, directory) => {
  const result = await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-13' });
  assert.equal(result.status, 'committed');
  assert.equal(result.checkpoint, '2026-11-13');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.checkpoint, '2026-11-13');
  assert.equal(harvest.windows.length, 1);
  assert.deepEqual(harvest.windows[0].status, 'committed');
  assert.equal(harvest.windows[0].until, '2026-11-13');
  assert.ok(harvest.windows[0].pages >= 1);
  const m01 = harvest.records.find(record => record.id === 'M-01');
  assert.equal(m01.datestamp, '2026-11-12');
  assert.equal(m01.title, '镍转运材料登记订正');
  const m03 = harvest.records.find(record => record.id === 'M-03');
  assert.equal(m03.deleted, true);
  assert.deepEqual(harvest.tombs.map(record => record.id), ['M-03']);
  assert.equal(harvest.records.length, 4);
  assert.ok(harvest.sourceWindows.some(window => window.from === '2026-11-10' && window.until === '2026-11-13'));
  assert.equal(harvest.progress.baselineComplete, true);
  // 下游视图不包含采集器的进行中状态。
  assert.equal(harvest.progress.running, undefined);
}));

test('基线未完成时 checkpoint 为 null，且不能显示为完成', () => withSite(async (site, directory) => {
  const state = await commands.status({ directory });
  assert.equal(state.checkpoint, null);
  assert.equal(state.harvest.checkpoint, null);
  assert.equal(state.harvest.windows.length, 0);
  await assert.rejects(
    commands.daily({ ...BASE(site), directory }),
    /尚未完成首轮全量/
  );
}));

test('页间退出：下游看不到半窗口，恢复后无重复版本', () => withSite(async (site, directory) => {
  const first = await commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13',
    hooks: {
      afterPage({ pages }) {
        if (pages === 1) throw new Error('模拟进程在第 1 页后退出');
      }
    }
  }).catch(error => error);
  assert.match(first.message, /模拟进程/);
  const partial = await readHarvest(directory);
  assert.equal(partial.checkpoint, null, '半窗口不得推进进度');
  assert.equal(partial.windows.length, 0, '下游看不到半窗口');
  assert.deepEqual(partial.records, []);
  const state = await readState(directory);
  assert.equal(state.progress.running.from, '2026-11-10');
  assert.equal(state.progress.running.attempts[0].pages.length, 1);
  assert.equal(state.progress.running.attempts[0].status, 'open');

  const resumed = await commands.resume({ ...BASE(site), directory });
  assert.equal(resumed.status, 'committed');
  assert.equal(resumed.checkpoint, '2026-11-13');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.records.filter(record => record.id === 'M-01').length, 1);
  assert.equal(harvest.records.find(record => record.id === 'M-01').datestamp, '2026-11-12');
  assert.equal(harvest.records.length, 4);
}));

test('进程级退出后重启能解释未完成窗口', () => withSite(async (site, directory) => {
  await assert.rejects(commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13',
    hooks: { afterPage({ pages }) { if (pages === 1) throw new Error('退出'); } }
  }), /退出/);
  const status = await commands.status({ directory });
  assert.equal(status.unfinished.from, '2026-11-10');
  assert.equal(status.unfinished.until, '2026-11-13');
  assert.equal(status.unfinished.pages, 1);
  assert.ok(status.unfinished.documents >= 1);
  assert.equal(status.checkpoint, null);
  assert.equal(status.harvest.checkpoint, null);

  // 同一窗口重新运行等于续采（安全）；不同窗口必须被拒绝，不能被覆盖。
  await assert.rejects(commands.daily({ ...BASE(site), directory }), /尚未完成首轮全量/);
  await assert.rejects(commands.backfill({
    ...BASE(site), directory, range: '2026-11-10..2026-11-11'
  }), /未完成窗口/);

  const restarted = await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-13' });
  assert.equal(restarted.status, 'committed');
  assert.equal(restarted.checkpoint, '2026-11-13');
}));

test('最后一页已收到但尚未提交时退出：重启直接提交，不重复访问', () => withSite(async (site, directory) => {
  let calls = 0;
  const client = async (base, request) => {
    calls += 1;
    const url = new URL(base + '/oai');
    url.searchParams.set('verb', 'ListRecords');
    if (request.resumptionToken) url.searchParams.set('resumptionToken', request.resumptionToken);
    else { url.searchParams.set('from', request.from); url.searchParams.set('until', request.until); }
    return (await fetch(url)).json();
  };
  await assert.rejects(commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13',
    client,
    hooks: {
      afterPage({ token }) {
        if (token === null) throw new Error('最后一页后退出');
      }
    }
  }), /最后一页后退出/);
  const partial = await readState(directory);
  assert.equal(partial.progress.running.attempts[0].status, 'complete');
  const harvestBefore = await readHarvest(directory);
  assert.equal(harvestBefore.checkpoint, null);
  assert.equal(harvestBefore.records.length, 0);

  const requestsBefore = calls;
  const resumed = await commands.resume({ base: site.url, directory, client });
  assert.equal(resumed.status, 'committed');
  assert.equal(calls, requestsBefore, '整窗已完整收到，不应重复访问源端');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.checkpoint, '2026-11-13');
  assert.equal(harvest.records.length, 4);
}));
