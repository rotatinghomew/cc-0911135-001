GET /oai?verb=Identify 返回日期范围；GET /oai?verb=ListRecords&from=YYYY-MM-DD&until=YYYY-MM-DD 开始查询。后续请求仅带 verb=ListRecords 和 resumptionToken，不可解释令牌内容。所有日期均包含端点，空页且令牌为 null 表示窗口结束；错误以 JSON error 字段表示，HTTP 200 不保证业务成功。每页最多两条新记录，页内顺序不构成进度保证。

演练开关：POST /_control JSON 可设置 expireOnce（下次令牌查询失效一次）、overlap（页首重复上一页尾）、reverse（重开时倒序）、conflict（加入同日冲突版本）。这些开关不属于采集器接口。记录字段为 id、datestamp、deleted 和可选 title。

harvest.json 基本字段：records 数组为当前版本，windows 数组各项含 from、until、status，checkpoint 为已完整提交的日期或 null，conflicts 保存不能提交的版本。未完成窗口不推进 checkpoint。
