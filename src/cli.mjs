import { parseArgs } from 'node:util';
import { commands } from './harvester.mjs';
import { HarvestError } from './errors.mjs';

export const USAGE = `用法：
  node src/cli.mjs baseline --base URL --dir 目录 [--until YYYY-MM-DD] [--from YYYY-MM-DD]
  node src/cli.mjs daily    --base URL --dir 目录 [--until YYYY-MM-DD] [--overlap 天数]
  node src/cli.mjs backfill --base URL --dir 目录 --range YYYY-MM-DD..YYYY-MM-DD
  node src/cli.mjs resume   --base URL --dir 目录
  node src/cli.mjs status   --dir 目录
  node src/cli.mjs verify   --dir 目录        # 只读校验 harvest.json

长期进度只在窗口完整提交后推进；--until 固定本轮截止日（默认源端当天）。
补采 --range 不改变常规进度，也不推进 checkpoint。
环境变量：HARVEST_BASE、HARVEST_DIR、HARVEST_UNTIL。`;

function number(value, label, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new HarvestError(`${label} 必须是非负整数`);
  return parsed;
}

export function parseCommandLine(argv, env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) return { command: 'help' };
  const [command = 'status', ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      base: { type: 'string' },
      dir: { type: 'string', short: 'd' },
      until: { type: 'string' },
      from: { type: 'string' },
      range: { type: 'string' },
      overlap: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    },
    allowPositionals: false
  });
  if (values.help) return { command: 'help' };
  const base = values.base ?? env.HARVEST_BASE ?? (env.PORT ? `http://127.0.0.1:${env.PORT}` : undefined);
  const directory = values.dir ?? env.HARVEST_DIR ?? 'var';
  const options = {
    base,
    directory,
    cutoff: values.until ?? env.HARVEST_UNTIL,
    from: values.from,
    range: values.range,
    overlapDays: number(values.overlap, '--overlap', undefined)
  };
  for (const key of ['base', 'cutoff', 'from', 'range', 'overlapDays']) {
    if (options[key] === undefined) delete options[key];
  }
  if (!Object.hasOwn(commands, command)) {
    throw new HarvestError(`未知入口 ${command}\n${USAGE}`);
  }
  return { command, options };
}

export async function cli(argv = process.argv.slice(2), env = process.env) {
  const parsed = parseCommandLine(argv, env);
  if (parsed.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const result = await commands[parsed.command](parsed.options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.status === 'conflict' ? 2 : 0;
}

const entry = process.argv[1];
if (entry && entry.endsWith('cli.mjs')) {
  try {
    process.exitCode = await cli();
  } catch (error) {
    process.stderr.write(`${error.name ?? 'Error'}: ${error.message}\n`);
    if (error.code === 'invalidWindow' || error.code === 'harvestError' || error.code === 'unfinishedWindow') {
      process.stderr.write(`${USAGE}\n`);
    }
    process.exitCode = 1;
  }
}
