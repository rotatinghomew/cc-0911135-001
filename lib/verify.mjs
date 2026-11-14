import assert from 'node:assert/strict';
import { addDays, isDate } from './calendar.mjs';

function validRecord(record) {
  return record !== null && typeof record === 'object' &&
    typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.datestamp === 'string' && isDate(record.datestamp) &&
    typeof record.deleted === 'boolean' &&
    (record.title === undefined || typeof record.title === 'string');
}

function validWindow(window) {
  return window !== null && typeof window === 'object' &&
    typeof window.from === 'string' && isDate(window.from) &&
    typeof window.until === 'string' && isDate(window.until) &&
    window.from <= window.until;
}

/** 常规窗口实际覆盖的日期集合；补采窗口不参与长期覆盖证明。 */
export function coveredDates(windows) {
  const covered = new Set();
  for (const window of windows) {
    if (window.kind === 'backfill') continue;
    let date = window.from;
    while (date <= window.until) {
      covered.add(date);
      date = addDays(date, 1);
    }
  }
  return covered;
}

/**
 * harvest.json 的业务不变量：
 * - 当前版本每个标识只有一条，字段可解释，墓碑保留；
 * - windows 只包含完整提交的窗口；
 * - checkpoint 必须对应某个已提交常规窗口，并且从基线起点到 checkpoint
 *   的每个日期都被已提交窗口完整覆盖，未覆盖日期不得显示为完成；
 * - 冲突保留双方版本，来源时间窗可追溯。
 */
export function verify(value) {
  assert.ok(value && typeof value === 'object', '结果必须是对象');
  assert.ok(Array.isArray(value.records), 'records 必须是数组');
  assert.ok(Array.isArray(value.windows), 'windows 必须是数组');
  assert.ok(value.checkpoint === null || value.checkpoint === undefined ||
    (typeof value.checkpoint === 'string' && isDate(value.checkpoint)),
  'checkpoint 必须是日期或 null');
  const checkpoint = value.checkpoint ?? null;
  const progress = value.progress ?? {};
  const identifiers = value.records.map(record => record.id);
  assert.equal(new Set(identifiers).size, identifiers.length, '当前版本重复');
  for (const record of value.records) {
    assert.ok(validRecord(record), `记录不可解释：${JSON.stringify(record)}`);
  }

  for (const window of value.windows) {
    assert.ok(validWindow(window), `窗口不可解释：${JSON.stringify(window)}`);
    assert.ok(window.status === undefined || window.status === 'committed',
      'harvest.json 只能包含已提交窗口');
    assert.ok(Number.isInteger(window.pages) && window.pages >= 1,
      `已提交窗口 ${window.from}..${window.until} 必须记录页数`);
    assert.ok(Number.isInteger(window.records) && window.records >= 0,
      `已提交窗口 ${window.from}..${window.until} 必须记录记录数`);
    assert.ok(['baseline', 'daily', 'backfill'].includes(window.kind),
      `窗口 ${window.from}..${window.until} 缺少可解释的类型`);
  }

  if (value.sourceWindows !== undefined) {
    assert.ok(Array.isArray(value.sourceWindows), 'sourceWindows 必须是数组');
    for (const source of value.sourceWindows) {
      assert.ok(validWindow(source), `来源时间窗不可解释：${JSON.stringify(source)}`);
    }
  }

  const committed = value.windows;
  const baselineDeclared = value.baseline !== null && value.baseline !== undefined;
  if (checkpoint === null) {
    assert.equal(Boolean(progress.baselineComplete) || baselineDeclared, false,
      '没有 checkpoint 时不能声称基线已完成');
  } else {
    assert.ok(committed.some(window => window.kind !== 'backfill' && window.until === checkpoint),
      `checkpoint ${checkpoint} 必须对应一个完整提交的常规窗口`);
    assert.ok(progress.baselineComplete !== false || baselineDeclared,
      '有 checkpoint 时必须已声明基线完成');
    const from = value.baseline?.from ?? [...committed]
      .filter(window => window.kind !== 'backfill')
      .sort((left, right) => left.from.localeCompare(right.from))[0]?.from;
    if (from) {
      const covered = coveredDates(committed);
      for (let date = from; date <= checkpoint; date = addDays(date, 1)) {
        assert.ok(covered.has(date), `日期 ${date} 未完整覆盖，不能显示为已提交`);
      }
    }
  }
  if (value.baseline !== null && value.baseline !== undefined) {
    assert.ok(validWindow(value.baseline), 'baseline 不可解释');
    assert.ok(committed.some(window => window.kind === 'baseline' &&
      window.from === value.baseline.from && window.until === value.baseline.until),
    'baseline 必须对应一个已提交的基线窗口');
  }

  if (value.conflicts !== undefined) {
    assert.ok(Array.isArray(value.conflicts), 'conflicts 必须是数组');
    for (const conflict of value.conflicts) {
      assert.ok(validWindow(conflict), '冲突窗口不可解释');
      assert.ok(Array.isArray(conflict.versions) && conflict.versions.length >= 1,
        '冲突必须保留涉及冲突的标识');
      for (const version of conflict.versions) {
        assert.ok(typeof version.id === 'string' && isDate(version.datestamp), '冲突标识不可解释');
        assert.ok(Array.isArray(version.versions) && version.versions.length >= 2,
          '同日冲突必须保留多个版本内容');
        for (const record of version.versions) assert.ok(validRecord(record), '冲突版本记录不可解释');
      }
    }
  }
}
