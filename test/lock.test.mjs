import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSite } from '../src/site.mjs';
import { commands } from '../src/harvester.mjs';
import { withLock, LockError, storePaths } from '../lib/store.mjs';

async function dir() {
  return mkdtemp(join(tmpdir(), 'harvest-lock-'));
}

test('并发采集被锁拒绝，遗留锁可按进程存活状态回收', async () => {
  const directory = await dir();
  const site = await createSite();
  try {
    let release;
    const blocker = withLock(directory, () => new Promise(resolve => { release = resolve; }));
    // 让持锁进程先拿到锁。
    await new Promise(resolve => setTimeout(resolve, 20));
    await assert.rejects(commands.status({ directory }), LockError);
    release();
    await blocker;
    const status = await commands.status({ directory });
    assert.equal(status.checkpoint, null);

    // 陈旧锁：记录一个已退出进程的 PID，应被回收。
    const paths = storePaths(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(paths.lock, JSON.stringify({ pid: 999999, host: hostname() }));
    const recovered = await commands.status({ directory });
    assert.equal(recovered.checkpoint, null);
    assert.equal((await readFile(paths.lock, 'utf8').catch(() => '').then(Boolean)), false);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('损坏的账本拒绝继续，不覆盖已有下游结果', async () => {
  const directory = await dir();
  const site = await createSite();
  try {
    await commands.baseline({ base: site.url, directory, cutoff: '2026-11-13' });
    const before = await readFile(join(directory, 'harvest.json'), 'utf8');
    await writeFile(storePaths(directory).state, '{not json');
    await assert.rejects(commands.status({ directory }), /不是有效的 JSON/);
    assert.equal(await readFile(join(directory, 'harvest.json'), 'utf8'), before);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('只保留 harvest.json 的目录可以安全接管，仍以已提交窗口为进度', async () => {
  const directory = await dir();
  const site = await createSite();
  try {
    await commands.baseline({ base: site.url, directory, cutoff: '2026-11-13' });
    await rm(storePaths(directory).state);
    const status = await commands.status({ directory });
    assert.equal(status.checkpoint, '2026-11-13');
    assert.equal(status.records, 4);
    const daily = await commands.daily({ base: site.url, directory, cutoff: '2026-11-13' });
    assert.equal(daily.status, 'up-to-date');
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('网络失败保持窗口未完成，重启后续采', async () => {
  const directory = await dir();
  const site = await createSite();
  try {
    let calls = 0;
    const client = async (base, request) => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('连接断开'), { code: 'networkError' });
      const url = new URL(base + '/oai');
      url.searchParams.set('verb', 'ListRecords');
      if (request.resumptionToken) url.searchParams.set('resumptionToken', request.resumptionToken);
      else { url.searchParams.set('from', request.from); url.searchParams.set('until', request.until); }
      return (await fetch(url)).json();
    };
    await assert.rejects(commands.baseline({
      base: site.url, directory, cutoff: '2026-11-13', client
    }), /连接断开/);
    const harvest = JSON.parse(await readFile(join(directory, 'harvest.json'), 'utf8'));
    assert.equal(harvest.checkpoint, null);
    const status = await commands.status({ directory });
    assert.equal(status.unfinished.pages, 1);
    const resumed = await commands.resume({ base: site.url, directory });
    assert.equal(resumed.status, 'committed');
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('源端返回窗口外记录时拒绝该页', async () => {
  const directory = await dir();
  const site = await createSite();
  try {
    const client = async () => ({ records: [{ id: 'X', datestamp: '2025-01-01', deleted: false }], resumptionToken: null });
    await assert.rejects(commands.baseline({
      base: site.url, directory, cutoff: '2026-11-13', client
    }), /落在窗口/);
    const status = await commands.status({ directory });
    assert.equal(status.checkpoint, null);
    assert.ok(status.unfinished);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('截止日晚于源端当天时拒绝，不擅自扩展窗口', async () => {
  const directory = await dir();
  const site = await createSite();
  try {
    await assert.rejects(commands.baseline({
      base: site.url, directory, cutoff: '2026-11-20'
    }), /晚于源端当前日期/);
  } finally {
    await site.close();
    await rm(directory, { recursive: true, force: true });
  }
});
