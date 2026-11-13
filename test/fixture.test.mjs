import test from 'node:test';
import assert from 'node:assert/strict';
import { createSite } from '../src/site.mjs';
import { verify } from '../lib/verify.mjs';

async function withSite(operation) {
  const site = await createSite();
  try { await operation(site); } finally { await site.close(); }
}
async function control(site, value) {
  return fetch(site.url + '/_control', { method: 'POST', body: JSON.stringify(value) });
}

test('分页、墓碑和包含端点窗口', async () => withSite(async site => {
  let result = await (await fetch(site.url + '/oai?verb=ListRecords&from=2026-11-12&until=2026-11-12')).json();
  assert.equal(result.records.length, 2);
  assert.equal(result.records[1].deleted, true);
  assert.equal(result.resumptionToken, null);
}));

test('跨页重复与同日矛盾来源可重放', async () => withSite(async site => {
  await control(site, { overlap: true, conflict: true });
  const first = await (await fetch(site.url + '/oai?verb=ListRecords&from=2026-11-10&until=2026-11-13')).json();
  const second = await (await fetch(site.url + '/oai?verb=ListRecords&resumptionToken=' + first.resumptionToken)).json();
  assert.deepEqual(first.records.at(-1), second.records[0]);
  let result = second; const all = [...first.records, ...second.records];
  while (result.resumptionToken) {
    result = await (await fetch(site.url + '/oai?verb=ListRecords&resumptionToken=' + result.resumptionToken)).json(); all.push(...result.records);
  }
  assert.equal(all.filter(record => record.id === 'M-01' && record.datestamp === '2026-11-12').length, 2);
}));
test('令牌失效不能当作空窗口', async () => withSite(async site => {
  const page = await (await fetch(site.url + '/oai?verb=ListRecords&from=2026-11-10&until=2026-11-13')).json();
  await control(site, { expireOnce: true });
  const next = await (await fetch(site.url + '/oai?verb=ListRecords&resumptionToken=' + page.resumptionToken)).json();
  assert.equal(next.error, 'badResumptionToken');
}));
test('非法日期及虚假进度被拒绝', async () => withSite(async site => {
  assert.equal((await fetch(site.url + '/oai?verb=ListRecords&from=z&until=a')).status, 400);
  assert.throws(() => verify({ records: [], windows: [], checkpoint: '2026-11-13' }));
}));
