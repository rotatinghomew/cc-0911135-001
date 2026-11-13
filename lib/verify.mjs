import assert from 'node:assert/strict';

export function verify(value) {
  assert.ok(Array.isArray(value.records));
  assert.ok(Array.isArray(value.windows));
  const identifiers = value.records.map(record => record.id);
  assert.equal(new Set(identifiers).size, identifiers.length, '当前版本重复');
  for (const record of value.records) {
    assert.match(record.datestamp, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof record.deleted, 'boolean');
  }
  if (value.checkpoint !== null) {
    assert.match(value.checkpoint, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(value.windows.some(window => window.status === 'committed' && window.until === value.checkpoint));
  }
}
