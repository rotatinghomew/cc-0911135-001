# 业务演练

所有恢复路径都由 `npm test` 中可重复运行的真实 HTTP 情景覆盖；`npm run rehearse` 把主要场景串成一次可观察的演练。

|情景|操作|应观察到的业务结果|
|---|---|---|
|首轮|从最早日期采到固定的 11 月 13 日|M-01 保留 12 日订正，M-03 为墓碑，窗口闭合|
|页间退出|收首个页面后退出采集进程，源服务不退出|checkpoint 未越过未完成窗口，重启无重复版本|
|令牌失效|下一页前 expireOnce=true|旧窗口重开而非跳日，已接收页可安全重采|
|重排与重复|overlap=true、重开时 reverse=true|标识及 datestamp 决定版本，不依赖页尾水位|
|冲突|conflict=true|同日 M-01 两份内容保留，窗口不提交|
|补采|常规进度提交后指定旧范围|不倒退或擅自推进常规 checkpoint|
|提交边界|在文件落盘和进度记录之间分别中断|下游看不到半窗口，没有虚假完成|

## 入口与文件

|入口|用途|
|---|---|
|`npm run harvest:baseline -- --base URL --dir 目录 [--until D]`|首轮全量，固定本轮截止日|
|`npm run harvest:daily -- --base URL --dir 目录 [--until D] [--overlap N]`|日常增量，默认重叠 1 天|
|`npm run harvest:backfill -- --base URL --dir 目录 --range D..D`|指定范围补采，不改变常规进度|
|`npm run harvest:resume -- --dir 目录`|继续账本中的未完成窗口|
|`npm run harvest:status -- --dir 目录`|解释进度、未完成窗口、冲突，不访问源端|
|`npm run harvest:verify -- --dir 目录`|只读校验 harvest.json|
|`npm run demo` / `npm run probe -- URL`|保留原有的单次目录查看用法|

- `harvest-state.json`：采集器账本，含进行中窗口的已收页面。
- `harvest.json`：下游唯一可见视图，只由已提交窗口推导。
- 每页到达后先写账本；整窗收完后按“账本 → 视图”顺序提交；两者之间退出时下次启动补齐视图。
- 未收到 `resumptionToken: null` 的窗口不会出现 `status: committed`，`checkpoint` 也不会越过它。

## 版本规则

- 版本键为 `id` + `datestamp`，墓碑参与比较。
- 页内顺序与最后一条记录不构成进度；跨页、跨重开尝试的重复按版本键去重。
- 同一版本键内容不同 → `conflicts` 保留双方，整窗不提交。
- 旧 datestamp 不覆盖新版本；同日同内容重复是幂等的。
- 令牌失效只重开同一窗口；连续失效 3 次保留未完成状态并退出。
- 截止日启动时固定；`resume` 不会把窗口延伸到更晚日期。

## 演练检查点

`npm run rehearse` 依次打印：

1. `1_首轮中断` → `2_重启解释`：`checkpoint: null`，`unfinished.pages: 1`。
2. `3_续采并令牌失效`：窗口仍为 `2026-11-10..2026-11-13`，`status: committed`，`pages` 大于 3。
3. `4_日常增量` 无新日期时为 `up-to-date`。
4. `5_旧范围补采` 后 `checkpoint` 不变，`backfills` 增加。
5. `6_同日冲突` 返回 `status: conflict`，`harvest.json` 的 `conflicts` 保留两份 M-01，`checkpoint` 不推进。
6. `7_harvest.json` 只包含 `records`、`tombs`、已提交 `windows`、`sourceWindows`、`checkpoint`、`progress`、`conflicts`。
