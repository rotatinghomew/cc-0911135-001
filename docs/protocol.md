GET /oai?verb=Identify 返回日期范围；GET /oai?verb=ListRecords&from=YYYY-MM-DD&until=YYYY-MM-DD 开始查询。后续请求仅带 verb=ListRecords 和 resumptionToken，不可解释令牌内容。所有日期均包含端点，空页且令牌为 null 表示窗口结束；错误以 JSON error 字段表示，HTTP 200 不保证业务成功。每页最多两条新记录，页内顺序不构成进度保证。

演练开关：POST /_control JSON 可设置 expireOnce（下次令牌查询失效一次）、overlap（页首重复上一页尾）、reverse（重开时倒序）、conflict（加入同日冲突版本）。这些开关不属于采集器接口。记录字段为 id、datestamp、deleted 和可选 title。

## 时间窗与版本

- `from`/`until` 均为**包含端点**，窗口 `2026-11-10..2026-11-13` 覆盖 10、11、12、13 四天。
- 记录属于哪个窗口只由 `datestamp` 决定，与页内位置、返回顺序无关。
- **版本键**：`id` + `datestamp`。墓碑（`deleted: true`）也参与版本比较：墓碑日期更新时，该标识从当前版本中呈现为已删除。
- 同一版本键出现不同 `title`/`deleted` 即不可裁决冲突，窗口停止提交。
- `resumptionToken` 是不透明值，采集器只原样回传；失效后只能丢弃令牌、用原 `from`/`until` 重开同一窗口。

## harvest.json（下游可见）

| 字段 | 含义 |
|---|---|
| `records` | 当前版本，每个 `id` 恰好一条；墓碑以 `deleted: true` 保留 |
| `tombs` | 当前版本中的墓碑 |
| `windows` | **仅已提交**窗口，含 `from`、`until`、`kind`（baseline/daily/backfill）、`status: "committed"`、`pages`、`documents`、`records`、`retirements`、`completedAt` |
| `sourceWindows` | 每次提交实际访问的来源时间窗及页数，用于追溯 |
| `checkpoint` | 已完整提交的常规日期或 `null`；不会越过任何未完成窗口 |
| `baseline` | 首轮全量的起止日期与完成时间 |
| `progress.committed` | 已提交的常规窗口（含 `commitId`） |
| `progress.backfills` | 已提交的补采窗口；不参与 checkpoint |
| `progress.cutoff` | 本轮固定的截止日 |
| `conflicts` | 不能提交的窗口及其同日多份版本 |

未完成窗口只存在于 `harvest-state.json` 的 `progress.running`，不会出现在 `harvest.json`；`windows` 中不会出现非 `committed` 状态。

## harvest-state.json（采集器恢复账本）

- `progress.running`：当前未完成窗口，含 `from`、`until`、`kind`、每次尝试的 `pages` 与 `documents`、`reopened` 次数、`status`。
- `progress.committed` / `progress.backfills`：提交日志。
- `windows`：包含 `conflict` 窗口等审计信息。
- 每页到达后先写入该文件；整窗完成后先写账本、再写 `harvest.json`。两个文件之间退出时，任意入口启动都会用账本补齐 `harvest.json`。
- 只保留 `harvest.json`（例如恢复旧备份）时也可安全接管：已提交窗口是恢复进度的唯一依据。
