# opencode-usage-meter 文档

OpenCode V2 TUI 用量仪表盘插件:footer 实时计时/tok/s、右栏 Stats 块、`/usage-full` 统计面板、`/usage-settings` 设置。零采集、零存储,只读消费服务端原生聚合 API 与已同步 TUI 状态。

## 文档地图

| 分类 | 文件 | 内容 |
|---|---|---|
| **使用** | [guides/install.md](guides/install.md) | 安装 / 更新 / 验证 / 卸载 / 热重载注意事项 |
| | [features/display-logic.md](features/display-logic.md) | **显示逻辑与功能总览(推荐先读)**:功能清单、判定流程图、速率来源、"为什么没显示"速查、数据来源矩阵 |
| | [features/footer.md](features/footer.md) | footer 状态行:状态图标、可选段、tok/s 口径 |
| | [features/sidebar-stats.md](features/sidebar-stats.md) | 右栏 Stats 指标块 |
| | [features/usage-panel.md](features/usage-panel.md) | `/usage-full` 统计面板 |
| | [features/settings.md](features/settings.md) | `/usage-settings` 设置弹窗 |
| **架构** | [architecture/overview.md](architecture/overview.md) | 项目概述、加载机制、总体数据流、验证方式 |
| | [architecture/events-and-state.md](architecture/events-and-state.md) | 事件模型、状态结构、轮次状态机 |
| | [architecture/token-accounting.md](architecture/token-accounting.md) | token 计量、速率算法、精确校准链路 |
| | [architecture/usage-statistics.md](architecture/usage-statistics.md) | 消耗统计与命中率口径、会话窗口/累计/子代理 |
| | [architecture/runtime-lessons.md](architecture/runtime-lessons.md) | 运行时问题取证记录(client 路径/keymap 作用域/热重载) |
| | [architecture/module-layout.md](architecture/module-layout.md) | 0.7.2 模块化代码结构与职责划分 |
| **决策** | [decisions/known-issues.md](decisions/known-issues.md) | 边界情况与已知限制 |
| | [decisions/roadmap.md](decisions/roadmap.md) | 未来扩展与未实现项记录 |
| | [decisions/changelog.md](decisions/changelog.md) | 版本变更记录 |
| **图示** | [interaction-sequence.html](interaction-sequence.html) | 交互顺序图(可缩放/高亮/导出) |

## 快速链接

- 装机:`opencode plugin add github:dubuqiangu/opencode-usage-meter` → 详见 [安装指南](guides/install.md)
- 上手:发一条消息,footer 出现 `⏱ … ⚡ … tok/s` → 详见 [footer 功能](features/footer.md)
- 当前版本:0.7.9 → 详见 [变更记录](decisions/changelog.md)
