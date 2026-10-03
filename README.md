# opencode-usage-meter

OpenCode V2 TUI 插件:在输入框下方的状态行(`prompt.footer.status`)实时显示当前会话的等待时间、生成速率(tok/s)与用量指标。

- **运行中**:`⏱ waited 12.3s   ⚡ 42 tok/s   Σ 1.5M   hit 93%` — 计时每 500ms 跳动;速率基于 10s 采样滑动窗口的字符估算,并用每轮结束的精确 token 做持续校准(EMA,按模型跨会话持久化,收敛后偏差 ~5-10%);流式停顿超过 4s(工具调用间隙)自动隐藏;Σ 为今日 token 总耗,hit 为今日缓存命中率(`cache.read ÷ (cache.read + input)`)
- **空闲**:`✓ last 8.4s   ⚡ 48.9 tok/s   Σ 1.5M   hit 93%` — 速率为**精确值**(`tokens.output+reasoning ÷ 消息 created→completed 时长`,与 opencode 自带统计同口径);无精确值时回退启发式 avg(标注 avg)
- **上下文窗口占用不进 footer**:为避免与 tok/s 同级冗余(0.6.4 起移除),完整口径在 `/usage-full` 面板的"当前窗口"块——in/out/reasoning/cache 分项 + 占用% + ≥80% 压缩预警(`▲ 接近压缩阈值`),与原生侧栏面板同源
- **`/usage-full` 命令**(同时进命令面板):**开关式侧边栏统计面板**(`session.panel` 贡献)——面板头部为当前会话实时读数(计时/tok/s/今日 Σ,随 500ms 时钟跳动),以及**当前窗口**(最后一次请求的 in/out/reasoning/cache 分项 + 占用% 与压缩预警)、**本会话累计**(轮数/token 过流/会话级命中率 `cache.read ÷ (input+read+write)`/费用)、**子代理**(委派子会话树递归归总 + 会话与子代理合计);下方为今日按模型明细、今日合计(含缓存命中率)、近 7 日 steps 趋势、累计总量(含命中率)、累计 Top 模型;再按一次 `/usage-full` 或 `Esc` 收起,面板聚焦时按 `f` 全屏展开(窄终端下宿主自动全屏);无侧边栏时自动降级为普通弹窗——会话内的降级弹窗同样展示当前窗口/本会话/子代理三块
- **`/usage-settings` 命令**(0.6.7,同时进命令面板):**用量设置弹窗**(可扩展,当前一项)——**footer hit 维度**:`今日汇总`(默认,`hit nn%`,全 session 日级 `read ÷ (read+input)`)⇄ `当前会话`(`hit·s nn%`,单会话严格口径 `read ÷ (input+read+write)`);弹窗内按 `d` 切换,状态响应式刷新,选择自动持久化(storage);另有命令面板"切换 hit 维度"直切命令兜底(防个别宿主弹窗内 keybind 注册失败);面板始终完整展示两个维度,不受影响

Token 消耗统计基于服务端原生聚合 API(`/api/experimental/session/stats`),跨全部会话(含无 TUI 的 headless 会话与子代理),插件零采集、零存储,服务重启不丢数据。

## 一键安装(OpenCode ≥ V2)

任意目录执行一条命令,克隆、依赖安装、注册全部自动完成:

```sh
opencode plugin add github:dubuqiangu/opencode-usage-meter
```

重启 opencode(或 `opencode service restart` 后重开 TUI)即可生效。

## 更新

```sh
opencode plugin update github:dubuqiangu/opencode-usage-meter
```

(也可用 `opencode plugin list` 查看当前已安装版本。)重启后生效。

### 备选安装方式

**克隆到全局插件目录**(OpenCode 自动发现,无需改配置):

```sh
git clone https://github.com/dubuqiangu/opencode-usage-meter.git ~/.config/opencode/plugins/usage-meter
npm install ~/.config/opencode/plugins/usage-meter
```

**或在配置中指定路径** — `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file://<本仓库的绝对路径>"]
}
```

## 验证

1. 重启 opencode(或 `opencode service restart` 后重开 TUI)
2. 任意会话里发一条消息
3. 状态行出现 `⏱ waited …` 跳动与 `⚡ … tok/s` 流速;跑完变 `✓ last …   ⚡ … tok/s avg`

若状态行无显示:`~/.local/share/opencode/log/opencode.log` 过滤 `role=cli` 查插件加载错误。

## 卸载

```sh
opencode plugin remove github:dubuqiangu/opencode-usage-meter
```

或删除 `~/.config/opencode/plugins/usage-meter` 后重启。

## 工作原理

- TUI 插件经 `@opencode/plugin/tui`(OpenCode 运行时解析,无需构建);入口为 `Plugin.define({ id, setup })`,`.tsx` + `/** @jsxImportSource @opentui/solid */` pragma
- **计时**:订阅 `session.execution.started` / `succeeded` / `failed` / `interrupted`;漏事件时用 `session.step.started` 的 `started` 时间戳兜底
- **tok/s 实时速率**:订阅 `session.text.delta` / `session.reasoning.delta` / `session.tool.input.delta`,按字符启发式估算 token(CJK ≈ 1 token/字,其余 ≈ 4 字符/token),样本进入 10s 滑动窗口计算 Δtoken/Δt
- **精确校准**:`session.step.ended` / `failed` 携带精确 `tokens.output`,按 `msgTotal = exact + max(0, est − refEst)` 增量补偿,不丢不重
- **会话隔离**:全部状态按 `sessionID` 分桶,子代理会话互不干扰;旧 `message.*` 事件族保留兜底并带防双计锁
- **当前会话窗口/累计(0.6)**:只读已同步的 TUI 状态,零服务端调用——`session.message.list` 取最后一条 assistant 消息算窗口占用(÷ `location.model.list` 匹配模型的 `limit.context`,与原生侧栏面板同源同数);`session.get` 的 `session.tokens`/`cost` 权威聚合出本会话累计(免疫长会话消息窗截断);`session.list` 按 `parentID` BFS 归总子代理委派树(上限 200)
- 卸载时清理 interval、slot 与全部订阅

详细设计文档:[DESIGN.md](DESIGN.md);交互顺序图:[docs/interaction-sequence.html](docs/interaction-sequence.html)

## 许可

[MIT](LICENSE)
