# footer 状态行

挂载点:`prompt.footer.status`(append 模式,不覆盖原生状态行)。当前会话的实时读数,随 500ms 时钟跳动。

## 状态与图标(0.7.3 起全图标化)

| 状态 | 显示 | 条件 |
|---|---|---|
| 等待计时 | `⏱ 1m 02s   ⚡ 87 tok/s` | 运行中且有起始时间戳;速率有可用滑窗 |
| 运行中无起点 | `⏳` | 运行中但未收到 `execution.started`(如 TUI 中途打开、/reload 后) |
| 上轮终值 | `🏁 17.5s   ⚡ 70 tok/s` | 空闲;速率为消息级**精确值** |
| 流式停顿 | `⏱ 8s` | 工具执行间隙(>4s 无流),速率自动隐藏 |

- 计时每 500ms 跳动;<60s 显示一位小数(`17.5s`),对齐原生精度风格
- 空闲速率 = `Σ(output+reasoning) ÷ Σ(created→completed)`,与原生统计同口径;无精确值时回退启发式 avg 并标注 `avg`

## 默认段与可选段(0.7.0 重定默认)

**默认只显示 ⏱ 与 ⚡ 两段**。以下段默认关,经 `/usage-settings`(`f`/`h` 键)开启:

- `Σ 1.5M` — 今日 token 总耗(60s 周期 + 每轮结束 1.5s 防抖刷新,后台会话消耗也计入)
- `hit 96.4%` — 今日缓存命中率 `cache.read ÷ (cache.read + input)`,一位小数;维度可切当前会话严格口径(`hit·s`,见 [settings.md](settings.md))

## 实时速率原理(摘要)

- 流式期:字符启发式估算(CJK ≈ 1 token/字,其余 ≈ 4 字符/token)进入 10s 滑动窗口求 Δtoken/Δt
- 每轮结束用精确 token 自校准(EMA 系数,按模型持久化,收敛后偏差 ~5-10%)
- 完整算法见 [architecture/token-accounting.md](../architecture/token-accounting.md)

## 设计决策

- **上下文窗口占用不进 footer**(0.6.4 移除):与 tok/s 同级冗余;完整口径保留在 `/usage-full` 面板"当前窗口"块
- **ctx 段移除后 `ctxPercent` 实现保留**,备未来界面使用
