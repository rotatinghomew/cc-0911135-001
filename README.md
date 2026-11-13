# germplasm-window-harvester

资料目录的窗口查询与响应查看服务。

## 环境与命令

Node.js 22.23.4，依赖使用 package-lock.json 固定。准备阶段运行 `npm ci`。


```bash
npm run build
npm test
npm run demo
npm start
```

`npm start` 输出本次监听地址，另一个终端可运行 `npm run probe -- http://127.0.0.1:端口`。服务只监听本机。`PORT` 可指定端口，Ctrl-C 结束。

`npm run build` 检查所有模块的 JavaScript 语法，无需生成打包文件；`npm test` 检查源端协议、正常及异常响应。

## 数据与运行边界

GET /oai?verb=Identify 返回日期范围；GET /oai?verb=ListRecords&from=YYYY-MM-DD&until=YYYY-MM-DD 开始查询。后续请求仅带 verb=ListRecords 和 resumptionToken，不可解释令牌内容。所有日期均包含端点，空页且令牌为 null 表示窗口结束；错误以 JSON error 字段表示，HTTP 200 不保证业务成功。每页最多两条新记录，页内顺序不构成进度保证。

演练开关：POST /_control JSON 可设置 expireOnce（下次令牌查询失效一次）、overlap（页首重复上一页尾）、reverse（重开时倒序）、conflict（加入同日冲突版本）。这些开关不属于采集器接口。记录字段为 id、datestamp、deleted 和可选 title。

harvest.json 基本字段：records 数组为当前版本，windows 数组各项含 from、until、status，checkpoint 为已完整提交的日期或 null，conflicts 保存不能提交的版本。未完成窗口不推进 checkpoint。

接口的完整字段及演练开关见 `docs/protocol.md`。业务编号均为合成值，不对应真实研究材料；服务没有外网依赖。`/_audit` 查看源端请求证据，`/_control` 只用于运行演练情景，不属于业务采集入口。

现有客户端只进行单次协议查看；尚不提供自动采集与持久运行调度。原始服务可单独运行，以便采集端在重启时保持源端状态。

## 数据校验

`npm run verify -- harvest.json` 检查本地结果的基本业务不变量，缺少文件时返回非零状态。该命令不生成采集结果，也不替代网络交互和恢复测试。`npm run demo` 在临时本地服务上真实发起请求并完整打印响应，随后退出。日常演练均不需要安装依赖或访问研究站。
