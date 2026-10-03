# 用量统计与口径

## 架构决策:零采集层(0.3.0)

初版功能分解曾计划"服务端 `index.ts` 订阅事件 → 自聚合 → storage 落盘"。取证后确认 OpenCode V2 服务端**原生已做全量聚合**并暴露只读查询端点,采集层整体砍掉:

| 原计划组件 | 取代方式 |
|---|---|
| 服务端采集(订阅 session.* 聚合) | 服务端自身已统计(覆盖全部会话,含 headless 与 subagents) |
| storage 持久化 + 保留策略 | 服务端数据库自管,插件重启不丢 |
| 自定义 RPC 双端通道 | TUI 插件直接调用客户端 stats 方法 |
| 去重/时区/重放风险 | 不存在(纯只读查询) |

## 数据源

`GET /api/experimental/session/stats`(operationId `experimental.session.stats`)。

**关键参数格式(实测)**:`from`/`to` 为 epoch 毫秒 **number**(v2.0.21 SDK `SessionStatsInput` 要求,字符串会被 effect schema 拒绝);`timezone` 传本地 IANA 时区名(影响 `activity[].date` 的日切归属);`project` 可选,缺省全局。响应:`tokens{input,output,reasoning,cache{read,write}}`、`cost`、`models[]`、`activity[]`、`sessions/steps/activeDays/streak`。

**客户端路径**(0.6.4 取证):openapi operationId 为 `experimental.session.stats`,但 v2.0.x effect 客户端实际挂在 **`SessionApi`**(`context.client.session.stats`);实现按候选路径数组 `[client.session.stats, client.experimental.session.stats]` 依次探测,兼容未来迁移。

## 展示与刷新

- **footer 可选段**:Σ(今日 `input+output+reasoning`,cache 成本结构不同不计入)与 hit(见下);今日为 0 或 API 不可用时隐藏
- **刷新策略**:插件加载取一次;`session.step.ended/failed` 后 1.5s 防抖;**60s 周期(0.6.8)**——后台会话(子代理/headless)消耗不触发本会话轮事件,定时器保证空闲期不滞后;500ms tick 检测跨零点自动重取并复位失败标记
- **定时器独立性(0.7.6)**:1.5s 防抖刷新与 30s 缺方法重试是两条独立生命周期,各自持有定时器——修复 0.7.5 前两者共用一个槽位、重试等待期间防抖刷新被静默吞掉的问题
- **降级**:client 方法缺失 → 30s 定时重试(不一次性判死);请求失败 → 静默隐藏 + 单次日志;不阻塞计时/tok/s 主功能

## 会话窗口与累计(0.6.0)

只读已同步的 TUI 状态,零服务端调用:

- **窗口快照**:`session.message.list(sessionID)` 中最后一条 `tokens.output > 0` 的 assistant 消息
- **窗口占用** = `input + output + reasoning + cache.read + cache.write`(与原生侧栏 Context 面板同源同数)÷ 模型 `limit.context`(`location.model.list` 按 `providerID + model.id` 匹配)
- **会话累计**:`session.get(sessionID)` 的 `session.tokens` / `session.cost` 权威聚合(TUI 消息窗只保留近期消息时依然全量);轮数从 message.list 统计 assistant 条数(截断时偏小,标 `N+`)
- **子代理**:`session.list()` 按 `parentID` BFS 遍历委派树(上限 200 防病态树);渲染时对每个子会话触发一次性 `session.sync()` 防陈旧;全部零用量时整块隐藏
- **80% 压缩预警**:窗口占用 ≥80% 时面板占用行追加 `▲ 接近压缩阈值`(常量 `CTX_WARN_PCT`,未来可配置化)

## 口径对照(三者并存,UI 必须标签区分,防误读)

| 口径 | 范围 | cache 计入 | 位置 |
|---|---|---|---|
| 今日 Σ | 当日全部会话 | 不计入 | footer 可选段 / 面板头部 / 右栏 📊 |
| 会话累计 | 本会话(压缩后不重置) | 计入 | 面板"本会话累计" |
| 窗口占用 | 最后一次请求 | 计入(缓存命中仍占窗口) | 面板"当前窗口" |

## 命中率双口径(有意并存)

- **日级**(footer/右栏 `🎯 (today)`):`cache.read ÷ (cache.read + input)`——stats API 日级口径
- **会话级严格口径**(面板/`hit·s`/`🎯 (session)`):`cache.read ÷ (input + cache.read + cache.write)`——分母含 cache write,与原生面板一致

## footer 指标段配置化(0.6.6 → 0.7.0)

footer 的 hit 段支持两种维度;0.7.0 起 footer 默认只显示 ⏱/⚡,Σ/hit 为 opt-in 开关。配置经 `/usage-settings`,持久化于 `storage.store("usage-meter.settings")`;旧存储缺键由读取器按文档默认值归一。详见 [features/settings.md](../features/settings.md)。

## 右栏指标块(0.7.0)

经 `sidebar.content` slot 与宿主 Context/MCP 区块同通道追加 `Stats` 块,数据与 footer 同源同口径。详见 [features/sidebar-stats.md](../features/sidebar-stats.md)。
