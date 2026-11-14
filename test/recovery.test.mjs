import test from 'node:test';
import assert from 'node:assert/strict';
import { commands } from '../src/harvester.mjs';
import { setControl, withSite, readHarvest, readState } from './helpers.mjs';

const BASE = site => ({ base: site.url });

test('令牌失效：重开同一窗口而非跳日，已接收页不重复入账', () => withSite(async (site, directory) => {
  // 第一页之后让下一次令牌查询失效一次；重开后的新令牌必须可用。
  let expired = false;
  const result = await commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13',
    hooks: {
      async afterPage({ token }) {
        if (token && !expired) {
          expired = true;
          await setControl(site, { expireOnce: true });
        }
      }
    }
  });
  assert.equal(result.status, 'committed');
  assert.equal(result.checkpoint, '2026-11-13');
  const state = await readState(directory);
  const running = state.progress.running;
  assert.equal(running, null);
  const harvest = await readHarvest(directory);
  assert.equal(harvest.records.length, 4);
  const m01 = harvest.records.filter(record => record.id === 'M-01');
  assert.equal(m01.length, 1);
  assert.equal(m01[0].datestamp, '2026-11-12');
  // 窗口仍是原来那天开始，没有跳日。
  assert.equal(harvest.windows[0].from, '2026-11-10');
  assert.equal(harvest.windows[0].until, '2026-11-13');
  assert.equal(harvest.checkpoint, '2026-11-13');
  assert.ok(harvest.windows[0].pages >= 3);
}));

test('令牌失效次数有上限，窗口保持未完成', () => withSite(async (site, directory) => {
  let pages = 0;
  await assert.rejects(commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13',
    pageDelay: 0,
    hooks: {
      afterPage({ token }) {
        pages += 1;
        return token ? setControl(site, { expireOnce: true }) : undefined;
      }
    }
  }), /令牌/);
  const harvest = await readHarvest(directory);
  assert.equal(harvest.checkpoint, null);
  assert.equal(harvest.windows.length, 0);
  const status = await commands.status({ directory });
  assert.ok(status.unfinished);
  assert.equal(status.unfinished.kind, 'baseline');
  assert.ok(status.unfinished.reopened >= 1);
}));

test('重排与跨页重复：标识+datestamp 定版本，不依赖页尾水位', () => withSite(async (site, directory) => {
  await setControl(site, { overlap: true, reverse: true });
  const result = await commands.baseline({ ...BASE(site), directory, cutoff: '2026-11-13' });
  assert.equal(result.status, 'committed');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.records.length, 4);
  const m01 = harvest.records.find(record => record.id === 'M-01');
  assert.equal(m01.datestamp, '2026-11-12');
  assert.equal(m01.title, '镍转运材料登记订正');
  const ids = harvest.records.map(record => record.id).sort();
  assert.deepEqual(ids, ['M-01', 'M-02', 'M-03', 'M-04']);
}));

test('页间退出 + 重排 + 跨页重复：恢复后不重复、不倒退', () => withSite(async (site, directory) => {
  await assert.rejects(commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13',
    hooks: {
      async afterPage({ pages }) {
        if (pages === 1) {
          await setControl(site, { overlap: true, reverse: true });
          throw new Error('页面之间退出');
        }
      }
    }
  }), /页面之间退出/);
  const resumed = await commands.resume({ ...BASE(site), directory });
  assert.equal(resumed.status, 'committed');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.records.length, 4);
  assert.equal(harvest.records.find(record => record.id === 'M-01').datestamp, '2026-11-12');
  assert.equal(harvest.records.filter(record => record.id === 'M-01').length, 1);
}));

test('同日内容冲突：保留双方版本、窗口不提交、checkpoint 不动', () => withSite(async (site, directory) => {
  await setControl(site, { conflict: true });
  const result = await commands.baseline({
    ...BASE(site),
    directory,
    cutoff: '2026-11-13'
  });
  assert.equal(result.status, 'conflict');
  const harvest = await readHarvest(directory);
  assert.equal(harvest.checkpoint, null);
  assert.equal(harvest.windows.length, 0);
  assert.equal(harvest.records.length, 0);
  assert.equal(harvest.conflicts.length, 1);
  const conflict = harvest.conflicts[0];
  assert.equal(conflict.from, '2026-11-10');
  assert.equal(conflict.until, '2026-11-13');
  const versions = conflict.versions.find(version => version.id === 'M-01');
  assert.equal(versions.datestamp, '2026-11-12');
  assert.equal(versions.versions.length, 2);
  assert.deepEqual(
    versions.versions.map(record => record.title).sort(),
    ['矛盾订正', '镍转运材料登记订正'].sort()
  );
  const status = await commands.status({ directory });
  assert.equal(status.unfinished, null);
  assert.equal(status.conflicts.length, 1);
}));
