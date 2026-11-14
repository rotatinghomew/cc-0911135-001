const DATE = /^\d{4}-\d{2}-\d{2}$/;

export class DateError extends Error {
  constructor(value, label = '日期') {
    super(`${label}不是有效的 YYYY-MM-DD：${String(value)}`);
    this.code = 'invalidDate';
  }
}

export function isDate(value) {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function assertDate(value, label = '日期') {
  if (!isDate(value)) throw new DateError(value, label);
  return value;
}

export function addDays(value, days) {
  assertDate(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function compareDates(left, right) {
  assertDate(left, '左端点');
  assertDate(right, '右端点');
  return left < right ? -1 : left > right ? 1 : 0;
}

export function assertWindow(from, until) {
  assertDate(from, '窗口开始日期');
  assertDate(until, '窗口截止日期');
  if (from > until) throw new DateError(`${from}..${until}`, '日期窗口（开始晚于截止）');
  return { from, until };
}

export function later(left, right) {
  if (left === null) return right;
  if (right === null) return left;
  return compareDates(left, right) >= 0 ? left : right;
}
