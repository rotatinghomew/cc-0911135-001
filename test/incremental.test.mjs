import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/harvester.mjs';
import { readHarvest, readState, withSite } from './helpers.mjs';

const BASE = site => ({ base: site.url });

test('日常增量：带重叠区间、只推 checkpoint 不倒退', () => withSite(async (site, directory) => {
  await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-12' });
  const before = await readHarvest(directory);
  assert.equal(before.checkpoint, '2026-11-12');

  const daily = await commands.daily({ ...BASE(site), directory, cutoff: '2026-11-13' });
  assert.equal(daily.status, 'committed');
  assert.equal(daily.from, '2026-11-11', '增量从 checkpoint 前 1 天开始，带重叠区间');
  assert.equal(daily.until, '2026-11-13');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.checkpoint, '2026-11-13');
  assert.deepEqual(
    harvest.windows.map(window => `${window.kind}:${window.from}..${window.until}`),
    ['baseline:2026-11-10..2026-11-12', 'daily:2026-11-11..2026-11-13']
  );
  // 重叠区重采不产生重复版本，新日期进入当前版本。
  assert.equal(harvest.records.filter(record => record.id === 'M-01').length, 1);
  assert.equal(harvest.records.find(record => record.id === 'M-01').datestamp, '2026-11-12');
  assert.equal(harvest.records.find(record => record.id === 'M-04').datestamp, '2026-11-13');
}));

test('日常重叠区间天数可配置', () => withSite(async (site, directory) => {
  await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-11' });
  const daily = await commands.daily({
    ...BASE(site), directory, cutoff: '2026-11-13', overlapDays: 3
  });
  assert.equal(daily.from, '2026-11-08');
  assert.equal(daily.until, '2026-11-13');
  const harvest = await readHarvest(directory);
  assert.ok(daily.from < '2026-11-11');
  assert.equal(harvest.checkpoint, '2026-11-13');
}));

test('日常无新日期时不提交，状态可解释', () => withSite(async (site, directory) => {
  await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-13' });
  const result = await commands.daily({ ...BASE(site), directory, cutoff: '2026-11-13' });
  assert.equal(result.status, 'up-to-date');
  assert.equal(result.checkpoint, '2026-11-13');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.windows.length, 1);
}));

test('指定范围补采：不改变常规增量进度', () => withSite(async (site, directory) => {
  await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-12' });
  const backfill = await commands.backfill({
    ...BASE(site), directory, range: '2026-11-10..2026-11-11'
  });
  assert.equal(backfill.status, 'committed');
  assert.equal(backfill.checkpoint, '2026-11-12', '补采不推进 checkpoint');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.checkpoint, '2026-11-12');
  const backfillWindow = harvest.windows.find(window => window.kind === 'backfill');
  assert.equal(backfillWindow.from, '2026-11-10');
  assert.equal(backfillWindow.until, '2026-11-11');
  assert.equal(harvest.progress.backfills.length, 1);
  // 补采不会用旧版本覆盖新版本：M-01 仍保留 12 日订正。
  assert.equal(harvest.records.find(record => record.id === 'M-01').datestamp, '2026-11-12');

  // 补采之后常规增量仍从长期 checkpoint 继续，不从补采结束日推进。
  const daily = await commands.daily({ ...BASE(site), directory, cutoff: '2026-11-13' });
  assert.equal(daily.from, '2026-11-11');
  const after = await readHarvest(directory);
  assert.equal(after.checkpoint, '2026-11-13');
}));

test('日常增量拒绝倒退到 checkpoint 之前', () => withSite(async (site, directory) => {
  await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-13' });
  await assert.rejects(commands.daily({
    ...BASE(site), directory, cutoff: '2026-11-10'
  }), /早于|当前进度/);
}));

test('补采范围非法时拒绝', () => withSite(async (site, directory) => {
  await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-13' });
  await assert.rejects(commands.backfill({ ...BASE(site), directory, range: '2026-11-13..2026-11-10' }));
  await assert.rejects(commands.backfill({ ...BASE(site), directory, range: 'x' }));
}));

test('提交边界：账本领先下游视图时重启补齐，且不出现半窗口', () => withSite(async (site, directory) => {
  let injected = false;
  const result = await commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13',
    hooks: {
      afterStateCommit() {
        if (injected) return;
        injected = true;
        // 账本已写入，视图写入之前退出。
        throw new Error('视图写入前退出');
      }
    }
  }).catch(error => error);
  assert.match(result.message, /视图写入前退出/);
  const harvest = await readHarvest(directory);
  assert.equal(harvest.checkpoint, null, '下游还看不到已提交窗口');
  assert.equal(harvest.windows.length, 0);
  const state = await readState(directory);
  assert.equal(state.progress.running, null);
  assert.equal(state.progress.checkpoint, '2026-11-13');

  const status = await commands.status({ directory });
  assert.equal(status.checkpoint, '2026-11-13');
  const repaired = await readHarvest(directory);
  assert.equal(repaired.checkpoint, '2026-11-13');
  assert.equal(repaired.windows.length, 1);
  assert.equal(repaired.records.length, 4);
}));

test('下游视图校验拒绝虚假完成', () => withSite(async (site, directory) => {
  await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-13' });
  const harvest = await readHarvest(directory);
  const { verify } = await import('../lib/verify.mjs');
  const broken = { ...harvest, windows: harvest.windows.filter(window => window.until !== '2026-11-13') };
  assert.throws(() => verify(broken), /checkpoint/);
}));
