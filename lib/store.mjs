import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export class StoreError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StoreError';
    this.code = options.code || 'storeError';
    if (options.cause) this.cause = options.cause;
  }
}

export class LockError extends StoreError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'locked' });
    this.name = 'LockError';
  }
}

export function storePaths(directory) {
  return {
    directory,
    harvest: join(directory, 'harvest.json'),
    state: join(directory, 'harvest-state.json'),
    lock: join(directory, 'harvest.lock')
  };
}

export async function readJsonIfPresent(filename) {
  let text;
  try {
    text = await readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new StoreError(`无法读取 ${filename}：${error.message}`, { code: 'readFailed', cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new StoreError(`${filename} 不是有效的 JSON，拒绝在损坏的状态上继续`, {
      code: 'corruptState',
      cause: error
    });
  }
}

async function fsyncDirectory(directory) {
  // 目录 fsync 让 rename 本身也落盘；部分文件系统不支持打开目录，忽略该能力差异。
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP', 'EPERM', 'ECANCELED'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

export async function writeJsonAtomic(filename, value) {
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.part`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, filename);
    await fsyncDirectory(dirname(filename));
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw new StoreError(`无法原子写入 ${filename}：${error.message}`, { code: 'writeFailed', cause: error });
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

const heldHere = new Set();

async function staleLock(lockPath) {
  const owner = await readJsonIfPresent(lockPath).catch(() => null);
  if (!owner) return true;
  if (owner.host !== hostname()) return false;
  if (owner.pid === process.pid) return !heldHere.has(lockPath);
  return !processIsAlive(owner.pid);
}

export async function withLock(directory, operation) {
  await mkdir(directory, { recursive: true });
  const paths = storePaths(directory);
  if (heldHere.has(paths.lock)) {
    throw new LockError(`目录正被本进程的另一次采集使用：${directory}`);
  }
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    let handle;
    try {
      handle = await open(paths.lock, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          host: hostname(),
          startedAt: new Date().toISOString()
        }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      acquired = true;
    } catch (error) {
      if (error.code !== 'EEXIST') {
        throw new StoreError(`无法获取采集锁：${error.message}`, { code: 'lockFailed', cause: error });
      }
      if (attempt > 0 || !(await staleLock(paths.lock))) {
        throw new LockError(`目录正被另一个采集进程使用：${directory}`, { cause: error });
      }
      await unlink(paths.lock).catch(() => {});
    }
  }
  if (!acquired) throw new LockError(`无法获取采集锁：${directory}`);
  heldHere.add(paths.lock);
  try {
    return await operation(paths);
  } finally {
    heldHere.delete(paths.lock);
    await unlink(paths.lock).catch(() => {});
  }
}
