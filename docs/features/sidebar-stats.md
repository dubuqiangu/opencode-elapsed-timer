# 右栏 Stats 指标块(0.7.0)

会话右栏(Context/MCP/agents 区块下方)追加 `Stats` 区块,默认开启。

## 挂载机制

右栏是宿主侧栏,暴露 `sidebar.content` slot——宿主自己的 Context/MCP 区块(`feature-plugins/sidebar/context.tsx`/`mcp.tsx`)正是经此 slot 挂载。插件以同通道 `append: "sidebar.content"` 追加,落在宿主区块下方。经 v2.0.21 源码取证。

## 内容(0.7.1 起全英文图标行,分行展示)

```
Stats
⏱ 1m 02s
⚡ 73 tok/s
📊 13M (today)
🎯 96.3% (today)
```

| 行 | 说明 |
|---|---|
| `⏱` / `⏳` / `🏁` | 当前会话实时计时;空闲显示上轮终值(与 footer 同数据同口径) |
| `⚡` | 实时速率;空闲显示精确速率(或 avg 回退) |
| `📊 总量 (today)` | 今日 token 总耗 |
| `🎯 命中率 (today\|session)` | 缓存命中率,维度跟随 `/usage-settings` |

设计约束:右栏为窄列,单行并排会挤压换行,故 ⏱/⚡ 分行;范围标注统一括号后缀。

## 开关

`/usage-settings` 内按 `b` 切换(默认开);关闭后整块消失。生命周期纳入插件清理。
