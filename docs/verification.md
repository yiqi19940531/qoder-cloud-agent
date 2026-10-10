# 验证记录（2026-10-10）

本页记录作者账号的测试结果，供理解系统能力；新用户应在自己的 Qoder/Apify 账号中重新验证。测试 Session、Vault、Run 和 Dataset 的内部 ID 不作为复用配置发布。

## Qoder Cloud Agent → Apify MCP

| 场景 | 结果 |
| --- | --- |
| 远端配置 | Qwen3.8-Max Agent v3、云端 Environment、含一条 Apify MCP Bearer 凭证的 Qoder Vault 均创建成功。MCP、`ask_user`、`load_saved_data` 和 `publish_results` 工具可用。 |
| 多轮澄清 | Agent 通过 `ask_user` 询问平台。网页在同一任务中展示并保存问题；回答以 `user.custom_tool_result` 回到原 Qoder Session，刷新后仍能看到完整对话。 |
| 京东 20 商品 | 远端 MCP `call-actor` 获批后返回 Run/Dataset；Agent 使用 `get-actor-run` 和 `get-dataset-items` 读取数据，发布 20 件商品，9 件有评论样本。后续追问复用原 Dataset，付费 Actor 调用数仍为 1。 |
| 页面与导出 | 商品表、阶段状态、来源、排名依据和评论可见；CSV 有 22 列、20 件商品。执行中刷新页面后可恢复任务和消息。 |
| 执行轨迹 | 20 商品会话的 Qoder API 返回 134 条公开事件、24 次工具调用；可查看 `call-actor` 参数、$2 上限、批准记录和返回。另一会话在轨迹页打开期间追加 `load_saved_data`，公开事件从 20 增至 40，页面自动更新。 |
| 费用 | 单次远端 `maxTotalChargeUsd=2` 已设置。MCP Run 未返回精确美元扣费，所以页面显示“待 MCP 返回实际费用”；不会写成 0。 |

评论数据需用 `get-dataset-items` **不传 `fields`** 并按单件读取；`fields=reviews.text` 对嵌套评论数组的投影在本次测试中返回空。9 件评论样本偏向好评，不能代表总体差评率。京东 `popularity` 是搜索位次，**不是**真实成交量 Top 20。结构化促销和实际销量缺失时，页面显示“未提供”。

## 历史 Actor 探查（不计远端验收）

这些探查发生在本项目改为“本地只调用 Qoder、远端 Agent 调用 Apify MCP”之前。当前源码已移除本地 Apify API 调用路径。

| 平台与 Actor | 历史探查结果 |
| --- | --- |
| 京东 `zen-studio/jd-com-search-scraper` | 20 个唯一商品、部分详情与评论；`popularity` 不代表真实销量。后续已通过远端 MCP 重做验收。 |
| 京东 `silentflow/jd-products-scraper` | 20 行、18 个唯一商品；无逐条评论。 |
| 京东 `sian.agency/jd-com-product-scraper` | 0 行；当时的方案不支持此 API 场景。 |
| 淘宝/天猫 `zen-studio/taobao-search-scraper` | 当时一次仅返回 10 件；天猫过滤后的多数结果平台标识不明确。远端完整验收待做。 |
| 天猫 `sian.agency/taobao-tmall-product-scraper` | 0 行；当时的方案不支持此 API 场景。 |

## 软件与安全检查

- `npm test`：6 项通过，覆盖 MCP 付费审批、一次付费调用、结果来源校验、问答留存、SSE 游标、执行轨迹关联与敏感字段隐藏。
- `npm run typecheck` 与 `npm run build` 通过；生产服务在 `127.0.0.1:3000` 验证。
- 轨迹接口对不存在的任务返回 404，对旧版无 Qoder Session 的记录返回 409；API 响应与浏览器静态包中未发现本机 Qoder PAT。
- `.env.local`、`data/`、`info.txt` 和构建目录均被 Git 忽略；公开演示素材不含 API Key。
