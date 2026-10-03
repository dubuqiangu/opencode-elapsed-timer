# 未来扩展与未实现记录

已评估可行性的方向。**未实现项明确记录,避免悬空状态。**

## 已实现(原规划落地)

| 方向 | 版本 | 形态 |
|---|---|---|
| Session 统计面板 | 0.4.0 | `/usage-full` 开关式 `session.panel` 侧边面板 |
| 按模型/按日消耗统计 | 0.3.0 | footer Σ + `/usage-full` 面板 |
| 费用(USD)展示 | 0.3.0 | stats API 自带 `cost`(模型未配价时为 0) |
| 右栏指标块 | 0.7.0 | `sidebar.content` slot,`Stats` 块(原"左侧列表"方向演化为右侧同通道) |

## 暂缓 / 等待依赖(未实现)

| 方向 | 依赖 | 状态 |
|---|---|---|
| 跑完弹"战报" | `context.ui.dialog.show()` | **暂缓未实现(2026-10-03 用户决定暂不做弹窗)**:本轮 token/时长/花费战报;数据链路已就绪(finishTurn 已持有 duration/lastExactRates/todayStats),启动时仅需恢复此表项 |
| 配置文件直读(options 通道) | 宿主插件 options 回传 | **等待宿主,未实现**(v2.0.21 取证:`{package, options}` 不回传插件):就绪后支持 `opencode.json` 内 `options: { hitScope, footerSigma, footerHit, sidebarMetrics }` 启动即生效;当前经 `/usage-settings` + storage 达成同等效果 |
| 全 session 状态列表 | `sidebar.content` slot | 未实现:各 session 运行态 + 速率列表 |
| 本轮/累计花费(USD) | `tokens` × 模型单价 + storage 持久化 | 未实现:footer 或面板 |
| 模型/工具活动指示 | `session.step.started`(model/agent)、`session.tool.*` | 未实现:footer 或面板 |

## 不做(已被宿主覆盖)

| 方向 | 理由 |
|---|---|
| 完成提示音/通知 | v2.0.21 宿主内置 `internal:notifications` 特性插件:轮结束 `done` 音效、报错 `error`、提问/授权提醒;系统通知仅在失焦时;由 `attention.*` 配置控制(默认 `false`,需用户开启)。如需差异化提醒再用 `context.attention.notify()` |
