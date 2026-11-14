import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSite } from '../src/site.mjs';
import { setControl } from './helpers.mjs';

function runCli(args) {
  const child = spawn(process.execPath, ['src/cli.mjs', ...args], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitFor(check, { timeout = 5000, interval = 10 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}

async function withDir(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-cli-'));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function listCalls(site) {
  return (await (await fetch(site.url + '/_audit')).json())
    .filter(entry => entry.path.includes('ListRecords'));
}

test('CLI：真实进程在页面之间被 SIGKILL，重启后解释并续采', async () => {
  const site = await createSite();
  await withDir(async directory => {
    try {
      const first = runCli(['baseline', '--base', site.url, '--dir', directory, '--until', '2026-11-13']);
      assert.ok(await waitFor(async () => (await listCalls(site)).length >= 1),
        '首个页面请求应已到达源端');
      // 等第二个页面也开始请求，再从外部杀掉进程，模拟“采集期间进程退出”。
      await waitFor(async () => (await listCalls(site)).length >= 2);
      first.child.kill('SIGKILL');
      const exited = await first.done;
      assert.equal(exited.signal, 'SIGKILL');

      const harvest = JSON.parse(await readFile(join(directory, 'harvest.json'), 'utf8'));
      assert.equal(harvest.checkpoint, null);
      assert.equal(harvest.windows.length, 0);
      assert.equal(harvest.records.length, 0);

      const status = runCli(['status', '--dir', directory]);
      const statusResult = await status.done;
      assert.equal(statusResult.code, 0, statusResult.stderr);
      const parsed = JSON.parse(statusResult.stdout);
      assert.equal(parsed.checkpoint, null);
      assert.ok(parsed.unfinished, '重启后应能解释未完成窗口');
      assert.equal(parsed.unfinished.from, '2026-11-10');
      assert.equal(parsed.unfinished.until, '2026-11-13');
      assert.ok(parsed.unfinished.pages >= 1);

      const resume = runCli(['resume', '--base', site.url, '--dir', directory]);
      const resumed = await resume.done;
      assert.equal(resumed.code, 0, resumed.stderr);
      const final = JSON.parse(await readFile(join(directory, 'harvest.json'), 'utf8'));
      assert.equal(final.checkpoint, '2026-11-13');
      assert.equal(final.windows.length, 1);
      assert.equal(final.records.length, 4);
      assert.equal(final.records.filter(record => record.id === 'M-01').length, 1);
      assert.equal(final.records.find(record => record.id === 'M-01').datestamp, '2026-11-12');
      assert.ok(final.tombs.some(record => record.id === 'M-03'));

      const verify = runCli(['status', '--dir', directory]);
      assert.equal((await verify.done).code, 0);
      const verified = runCli(['verify', '--dir', directory]);
      assert.equal((await verified.done).code, 0, (await verified.done).stderr);
    } finally {
      await site.close();
    }
  });
});

test('CLI：源端令牌失效一次，重开窗口而不跳日', async () => {
  const site = await createSite();
  await setControl(site, { expireOnce: true });
  await withDir(async directory => {
    try {
      const baseline = runCli(['baseline', '--base', site.url, '--dir', directory, '--until', '2026-11-13']);
      const result = await baseline.done;
      assert.equal(result.code, 0, result.stderr);
      const final = JSON.parse(await readFile(join(directory, 'harvest.json'), 'utf8'));
      assert.equal(final.checkpoint, '2026-11-13');
      assert.equal(final.windows[0].from, '2026-11-10');
      assert.equal(final.windows[0].until, '2026-11-13');
      assert.equal(final.records.length, 4);
      // 重开窗口导致第一页被再次请求，审计中能看到重复请求，但账本没有重复。
      const calls = await listCalls(site);
      const firstPages = calls.filter(call => call.path.includes('from=2026-11-10'));
      assert.ok(firstPages.length >= 2, '过期后应重开窗口而不是继续旧令牌');
      assert.equal(final.records.filter(record => record.id === 'M-01').length, 1);
    } finally {
      await site.close();
    }
  });
});

test('CLI：帮助与未知入口', async () => {
  const help = runCli(['--help']);
  assert.equal((await help.done).code, 0);
  const unknown = runCli(['nonsense']);
  const result = await unknown.done;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /未知入口/);
});
