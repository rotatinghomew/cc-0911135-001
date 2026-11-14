import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSite } from '../src/site.mjs';
import { commands } from '../src/harvester.mjs';
import { setControl } from '../test/helpers.mjs';

/**
 * 可重复运行的业务演练：
 *   1. 首轮全量在第 1 页后退出；
 *   2. 重启解释未完成窗口并续采，途中令牌失效一次；
 *   3. 源端跨页重复并在重开时倒序；
 *   4. 日常增量带重叠区间；
 *   5. 指定旧范围补采，常规进度不变；
 *   6. 同日冲突窗口不提交。
 * 最后打印 harvest.json 中下游可见的部分。
 */
const directory = await mkdtemp(join(tmpdir(), 'harvest-rehearsal-'));
const site = await createSite();
const out = {};

try {
  const baseline = await commands.baseline({
    base: site.url,
    directory,
    cutoff: '2026-11-13',
    hooks: {
      async afterPage({ pages }) {
        if (pages === 1) {
          await setControl(site, { overlap: true, reverse: true });
          throw new Error('演练：首个页面后退出采集进程');
        }
      }
    }
  }).catch(error => ({ status: 'interrupted', message: error.message }));
  out['1_首轮中断'] = baseline;

  const beforeResume = await commands.status({ directory });
  out['2_重启解释'] = {
    checkpoint: beforeResume.checkpoint,
    unfinished: beforeResume.unfinished
  };

  let expired = false;
  out['3_续采并令牌失效'] = await commands.resume({
    base: site.url,
    directory,
    hooks: {
      async afterPage({ token }) {
        if (token && !expired) {
          expired = true;
          await setControl(site, { expireOnce: true });
        }
      }
    }
  });

  out['4_日常增量'] = await commands.daily({ base: site.url, directory, cutoff: '2026-11-13' });
  out['5_旧范围补采'] = await commands.backfill({
    base: site.url,
    directory,
    range: '2026-11-10..2026-11-11'
  });

  await setControl(site, { conflict: true });
  out['6_同日冲突'] = await commands.backfill({
    base: site.url,
    directory,
    range: '2026-11-12..2026-11-13'
  });

  const harvest = JSON.parse(await readFile(join(directory, 'harvest.json'), 'utf8'));
  out['7_harvest.json'] = {
    checkpoint: harvest.checkpoint,
    baseline: harvest.baseline,
    records: harvest.records,
    tombs: harvest.tombs,
    windows: harvest.windows.map(window => `${window.kind} ${window.from}..${window.until} (${window.status})`),
    sourceWindows: harvest.sourceWindows,
    committed: harvest.progress.committed,
    backfills: harvest.progress.backfills,
    conflictWindows: harvest.conflicts.map(conflict => ({
      from: conflict.from,
      until: conflict.until,
      versions: conflict.versions
    }))
  };
  out['8_恢复元数据'] = (await commands.status({ directory })).progress.unfinished;
  out.directory = directory;
  console.log(JSON.stringify(out, null, 2));
} finally {
  await site.close();
  if (!process.env.HARVEST_KEEP) await rm(directory, { recursive: true, force: true });
}
