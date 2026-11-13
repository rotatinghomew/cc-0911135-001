import { readFile } from 'node:fs/promises';
import { serve, json } from '../lib/http.mjs';
const records = JSON.parse(await readFile(new URL('../data/records.json', import.meta.url)));
export async function createSite(port = 0) {
  const tokens = new Map();
  let counter = 0;
  return serve(({ response, url, state }) => {
    if (url.pathname !== '/oai') return false;
    if (url.searchParams.get('verb') === 'Identify') {
      json(response, 200, { earliest: '2026-11-10', today: '2026-11-13', granularity: 'day', pageSize: 2 });
      return true;
    }
    if (url.searchParams.get('verb') !== 'ListRecords') throw new Error('未知 verb');
    const token = url.searchParams.get('resumptionToken');
    let window;
    if (token) {
      if (state.expireOnce) {
        state.expireOnce = false;
        tokens.delete(token);
      }
      window = tokens.get(token);
      if (!window) { json(response, 200, { error: 'badResumptionToken' }); return true; }
    } else {
      const from = url.searchParams.get('from');
      const until = url.searchParams.get('until');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(until) || from > until) {
        throw new Error('需要有效的包含端点日期窗口');
      }
      window = { from, until, offset: 0 };
    }
    let selected = records.filter(record => record.datestamp >= window.from && record.datestamp <= window.until);
    if (state.reverse) selected = selected.toReversed();
    if (state.conflict) selected = [...selected, { id: 'M-01', datestamp: '2026-11-12', deleted: false, title: '矛盾订正' }];
    const page = selected.slice(window.offset, window.offset + 2);
    if (state.overlap && window.offset > 0) page.unshift(selected[window.offset - 1]);
    const next = window.offset + 2 < selected.length ? `opaque-${++counter}` : null;
    if (next) tokens.set(next, { ...window, offset: window.offset + 2 });
    json(response, 200, { records: page, resumptionToken: next, window: { from: window.from, until: window.until } });
    return true;
  }, { expireOnce: false, reverse: false, overlap: false, conflict: false }, port);
}
