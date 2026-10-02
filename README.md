# opencode-usage-meter

OpenCode V2 TUI 插件:在输入框下方的状态行(`prompt.footer.status`)实时显示当前会话的等待时间、生成速率(tok/s)与用量指标。

- **运行中**:`⏱ waited 12.3s   ⚡ 42 tok/s   Σ 1.5M   hit 93%` — 计时每 500ms 跳动;速率基于 10s 采样滑动窗口,流式停顿超过 4s(工具调用间隙)自动隐藏;Σ 为今日 token 总耗,hit 为今日缓存命中率(`cache.read ÷ (cache.read + input)`)
- **空闲**:`✓ last 8.4s   ⚡ 38 tok/s avg   Σ 1.5M   hit 93%`
- **`/usage-full` 命令**(同时进命令面板):**开关式侧边栏统计面板**(`session.panel` 贡献)——面板头部为当前会话实时读数(计时/tok/s/今日 Σ,随 500ms 时钟跳动),下方为今日按模型明细、今日合计(含缓存命中率)、近 7 日 steps 趋势、累计总量(含命中率)、累计 Top 模型;再按一次 `/usage-full` 或 `Esc` 收起,面板聚焦时按 `f` 全屏展开(窄终端下宿主自动全屏);会话外(无侧边栏)自动降级为普通弹窗

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
- 卸载时清理 interval、slot 与全部订阅

详细设计文档:[DESIGN.md](DESIGN.md);交互顺序图:[docs/interaction-sequence.html](docs/interaction-sequence.html)

## 许可

[MIT](LICENSE)
