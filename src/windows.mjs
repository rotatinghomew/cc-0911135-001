import { assertDate, addDays, assertWindow } from '../lib/calendar.mjs';
import { InvalidWindowError } from './errors.mjs';

/**
 * 日常增量窗口带重叠区间：从 checkpoint 往前 overlapDays 天开始，重新接收
 * 最近几天，允许源端晚到的订正覆盖旧版本。重叠区内的旧版本按 datestamp
 * 输给新版本，因此重复接收是无害的；只有整窗完整接收才会推进进度。
 */
export function dailyWindow(checkpoint, cutoff, { overlapDays = 1 } = {}) {
  assertDate(checkpoint, '长期进度');
  assertDate(cutoff, '本轮截止日');
  if (checkpoint > cutoff) throw new InvalidWindowError(`长期进度 ${checkpoint} 晚于本轮截止日 ${cutoff}`);
  const from = addDays(checkpoint, -Math.max(0, overlapDays));
  const { from: start, until } = assertWindow(from, cutoff);
  return { from: start, until };
}

/** 没有新日期时不重复提交；晚到订正由下一次增量携带的重叠区接收。 */
export function hasDailyWork(checkpoint, cutoff) {
  return checkpoint < cutoff;
}

export function parseRange(spec) {
  if (typeof spec !== 'string') throw new InvalidWindowError('补采范围必须是 YYYY-MM-DD..YYYY-MM-DD');
  const parts = spec.split('..');
  if (parts.length !== 2) throw new InvalidWindowError('补采范围必须是 YYYY-MM-DD..YYYY-MM-DD');
  try {
    return assertWindow(parts[0], parts[1]);
  } catch (error) {
    throw new InvalidWindowError(error.message, { from: parts[0], until: parts[1] });
  }
}

export function fullWindow(earliest, cutoff) {
  try {
    return assertWindow(earliest, cutoff);
  } catch (error) {
    throw new InvalidWindowError(error.message, { from: earliest, until: cutoff });
  }
}
