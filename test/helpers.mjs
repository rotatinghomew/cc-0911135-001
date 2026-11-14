import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSite } from '../src/site.mjs';

export async function withTempDir(operation) {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-'));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function withSite(operation, { control = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'harvest-'));
  let site;
  try {
    site = await createSite();
    if (Object.keys(control).length > 0) await setControl(site, control);
    const result = await operation(site, directory);
    return result;
  } finally {
    await site?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

export async function setControl(site, value) {
  const response = await fetch(site.url + '/_control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!response.ok) throw new Error('control failed');
  return response.json();
}

export async function readHarvest(directory) {
  return JSON.parse(await readFile(join(directory, 'harvest.json'), 'utf8'));
}

export async function readState(directory) {
  return JSON.parse(await readFile(join(directory, 'harvest-state.json'), 'utf8'));
}

export function clientFrom(site, { expireAtTokenCall = 0 } = {}) {
  let tokenCalls = 0;
  return async (base, request) => {
    const url = new URL(base + '/oai');
    url.searchParams.set('verb', 'ListRecords');
    if (request.resumptionToken) {
      tokenCalls += 1;
      if (expireAtTokenCall && tokenCalls === expireAtTokenCall) {
        // 模拟源端令牌过期一次：不消耗真实站点的 expireOnce，便于精确控制位置。
        return { error: 'badResumptionToken' };
      }
      url.searchParams.set('resumptionToken', request.resumptionToken);
    } else {
      url.searchParams.set('from', request.from);
      url.searchParams.set('until', request.until);
    }
    const response = await fetch(url);
    return response.json();
  };
}

export { createSite, mkdir, rm };
