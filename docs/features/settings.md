# /usage-settings 设置弹窗

可扩展的用量设置入口(0.6.7 引入),命令同时进命令面板("用量设置(footer 指标维度等)")。

## 配置项(五项)

| 键 | 配置项 | 默认 | 说明 |
|---|---|---|---|
| `d` | hit 维度 | 今日汇总 | `今日汇总`(全 session 日级 `read ÷ (read+input)`)⇄ `当前会话`(严格口径 `read ÷ (input+read+write)`,显示为 `hit·s`) |
| `s` | Σ/📊 总耗维度(0.7.7) | 今日 | 今日(本地零点起)→ 近24小时 → 近7日 → 近30日 滚动窗口循环;footer Σ / 右栏 📊 / 面板头部共用;非今日时强制显示范围标签 |
| `f` | footer Σ 段 | 关 | 0.7.0 起默认关,opt-in |
| `h` | footer hit 段 | 关 | 0.7.0 起默认关,opt-in |
| `b` | 右栏指标块 | 开 | 见 [sidebar-stats.md](sidebar-stats.md) |

`Esc` 关闭;全部选择自动持久化,弹窗内状态响应式刷新。各指标何时显示/隐藏的一页速查 → [display-logic.md](display-logic.md)

## 持久化机制

`storage.store("usage-meter.settings")`,官方 storage API,跨重启、跨 TUI 实例同步。旧版本存储缺新键时,读取器按文档默认值归一(footer 两键缺=关,sidebar 缺=开),无需迁移。

## 为什么走"命令 + storage"而非配置文件

v2.0.21 宿主无插件 options 配置通道(dev 的 `{package, options}` 不回传插件,已取证),故配置经命令修改 + storage 持久化自洽。宿主就绪后可加配置文件直读,见 [roadmap.md](../decisions/roadmap.md)。

## 兜底

命令面板另有"切换 hit 维度"直切命令(带 toast 反馈),防个别宿主弹窗内 keybind 注册失败。
