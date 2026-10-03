# opencode-usage-meter

OpenCode V2 TUI 用量仪表盘插件:footer 实时等待计时与生成速率(tok/s)、右栏 Stats 指标块、`/usage-full` 统计面板、`/usage-settings` 设置。

```
运行中   ⏱ 1m 02s   ⚡ 87 tok/s
空闲     🏁 17.5s    ⚡ 70 tok/s
右栏     Stats ─ ⏱/⚡/📊 总量 (today)/🎯 命中率
```

- **零采集、零存储**:只读消费服务端原生聚合 API(`/api/experimental/session/stats`)与已同步 TUI 状态,数据与宿主自带统计同口径,跨全部会话(含 headless 与子代理)
- **静默降级**:API 不可用时指标隐藏,不阻塞计时/速率主功能
- **状态全图标化**:⏱ 等待计时 · ⏳ 运行中无起点 · 🏁 上轮终值 · ⚡ 速率 · 📊 总量 · 🎯 命中率

## 快速开始

```sh
opencode plugin add github:dubuqiangu/opencode-usage-meter
```

重启 opencode,任意会话发一条消息,状态行即出现 `⏱ … ⚡ … tok/s`。

更新:`opencode plugin update github:dubuqiangu/opencode-usage-meter`(**更新后必须完整重启 TUI**,`/reload` 不会重载插件)。

完整安装/更新/验证/卸载说明 → [docs/guides/install.md](docs/guides/install.md)

## 功能一览

| 功能 | 入口 | 说明 |
|---|---|---|
| footer 状态行 | 常驻 | 实时 ⏱/⚡;Σ/hit 段默认关,`/usage-settings` 开启 → [footer.md](docs/features/footer.md) |
| 右栏 Stats 块 | 常驻(可关) | 与宿主 Context/MCP 区块同通道,分行图标行 → [sidebar-stats.md](docs/features/sidebar-stats.md) |
| 统计面板 | `/usage-full` | 当前窗口/本会话累计/子代理/日与累计明细 → [usage-panel.md](docs/features/usage-panel.md) |
| 设置弹窗 | `/usage-settings` | hit 维度、footer 段、右栏块,持久化 → [settings.md](docs/features/settings.md) |

## 文档

全部文档在 [docs/](docs/README.md) 下分类组织:

- **使用**:安装指南 + 四个功能页
- **架构**:总体架构、事件模型、计量与速率算法、统计口径、运行时取证、模块结构
- **决策**:已知限制、未来扩展/未实现记录、变更记录

设计文档原 DESIGN.md 已拆分迁移至 docs/(DESIGN.md 保留为指针);交互顺序图:[docs/interaction-sequence.html](docs/interaction-sequence.html)。

## 开发

- 源码经 OpenCode 运行时解析,无需构建;改动后 esbuild 语法校验(命令见 [docs/architecture/overview.md](docs/architecture/overview.md))
- 单元测试:`npm test`(test/ 目录,纯函数与 factory 层)
- 模块结构(0.7.2 起 12 模块)→ [docs/architecture/module-layout.md](docs/architecture/module-layout.md)

## 许可

[MIT](LICENSE)
