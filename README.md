# germplasm-window-harvester

资料目录的窗口查询、响应查看与长期增量采集。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。

```bash
npm run build      # 所有模块语法检查
npm test           # 协议、采集、恢复路径的可重复测试
npm run demo       # 单次协议查看（保留原有用法）
npm run rehearse   # 完整业务演练，打印 harvest.json 可见字段
npm start          # 启动本地演练源端
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

## 采集命令

```bash
node src/cli.mjs baseline --base URL --dir 目录 [--until YYYY-MM-DD]
node src/cli.mjs daily    --base URL --dir 目录 [--until YYYY-MM-DD] [--overlap 天数]
node src/cli.mjs backfill --base URL --dir 目录 --range YYYY-MM-DD..YYYY-MM-DD
node src/cli.mjs resume   --base URL --dir 目录
node src/cli.mjs status   --dir 目录
node src/cli.mjs verify   --dir 目录
```

对应 npm 入口：`npm run harvest:baseline -- --base ...`、`harvest:daily`、`harvest:backfill`、`harvest:resume`、`harvest:status`、`harvest:verify`。

- **baseline**：首轮全量，从源端最早日期采到本轮截止日（`--until`，默认源端当天，启动时固定）。
- **daily**：日常增量，从长期 checkpoint 往前 1 天（`--overlap` 可调）开始到截止日，重采重叠区以接收晚到订正。
- **backfill**：指定范围补采，只记入 `progress.backfills`，**不推进** 常规 checkpoint。
- **resume**：不访问新的日期，只继续账本里记录的未完成窗口；没有未完成窗口时立即返回且不请求源端。
- **status**：解释已提交进度、未完成窗口、冲突，不访问源端。
- **verify**：只读校验 `harvest.json` 的业务不变量。

环境变量 `HARVEST_BASE`、`HARVEST_DIR`、`HARVEST_UNTIL` 可替代对应参数。命令默认写入 `var/`（已由 `.gitignore` 忽略）。

退出码：0 成功或无需采集；1 参数/协议/网络错误（窗口保持未完成，可 `resume`）；2 同日冲突（窗口不提交）。

## 持久化与提交语义

采集目录下有两个文件：

| 文件 | 读者 | 内容 |
|---|---|---|
| `harvest-state.json` | 采集器 | 完整账本：已提交窗口、进行中窗口的已收页面、冲突、锁定截止日 |
| `harvest.json` | 下游 | 只含已提交结果：`records`、`tombs`、`windows`、`sourceWindows`、`checkpoint`、`progress`、`conflicts` |

- 每页校验通过后先把该页写入账本，再请求下一页；进程随时退出都能说明“未完成到第几页”。
- 只有收到 `resumptionToken: null` 的整窗才合并提交；半窗口从不进入 `harvest.json`。
- 提交顺序是先账本、后视图。两步之间退出时，下次任意入口启动会用账本补齐 `harvest.json`；下游只会看到完整窗口或旧视图，不会看到半窗口或虚假 `checkpoint`。
- `checkpoint` 只由已提交的常规窗口推导，并且校验命令会逐一确认从基线起点到 `checkpoint` 的每个日期都被已提交窗口完整覆盖；补采窗口不参与覆盖证明。
- 目录独占锁（`harvest.lock`）防止两个采集进程同时写入；进程被 SIGKILL 留下的锁按 PID/主机判断为遗留并回收。

## 版本与恢复规则

- 记录版本由 `id` + `datestamp` 决定，墓碑也参与版本比较。
- 页内顺序不可信，不使用“最后一条记录”作为水位；跨页、跨重开尝试、跨重试的重复按上述版本键去重。
- 同一 `id@datestamp` 出现不同内容视为不可裁决冲突：涉及版本全部保留到 `conflicts`，`datestamp` 较旧的旧版本不会覆盖当前版本，整窗停止提交且不推进 `checkpoint`。
- 令牌失效时丢弃旧令牌、从 `from`/`until` 重开**同一窗口**，已收页面仍参与合并，不会重复入账也不会跳日。连续失效 3 次则保留未完成状态并报错。
- 每个进程启动时都从窗口第一页重读，因为源端可能重新划页；已收页面在账本中，重复接收是幂等的。
- 本轮截止日在启动时固定写入账本；`resume` 不会把窗口扩展到更晚日期。

## 数据校验

`npm run verify -- harvest.json` 检查单个结果文件的业务不变量。`node src/cli.mjs verify --dir 目录` 是采集器内的只读校验入口。

`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出（原有单次查看用法）。`npm run rehearse` 在临时目录中依次重演：首轮页间退出、重启解释、令牌失效、重排与跨页重复、日常重叠增量、旧范围补采、同日冲突，最后只打印 `harvest.json` 中下游可见的字段；设置 `HARVEST_KEEP=1` 可保留演练目录。日常测试与演练都不需要安装依赖或访问研究站。

## 测试覆盖

`npm test` 中的恢复路径都是可重复运行的真实 HTTP 场景：

- 真实子进程在页面之间被 SIGKILL，重启后 `status` 解释未完成窗口、`resume` 完成整窗。
- 令牌失效一次或连续失效至上限；重开窗口、不跳日、不重复入账。
- 跨页重复、重开时倒序、页间退出后重排：版本由标识和 `datestamp` 决定。
- 同日内容冲突：双方版本保留，窗口与 `checkpoint` 都不提交。
- 日常重叠区间、补采不改变常规进度、补采后增量仍从原 checkpoint 继续。
- 账本写入与视图写入之间退出：下游看不到半窗口，重启补齐。
- 锁竞争、遗留锁回收、损坏账本拒绝继续、网络失败后续采、窗口外记录拒绝。
