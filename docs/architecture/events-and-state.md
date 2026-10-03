# 事件模型与状态机

## 事件订阅清单

| 事件 | 时机 | 载荷(经 `dataOf` 解包后) | 用途 |
|---|---|---|---|
| `session.execution.started` | 轮次开始 | `{sessionID}` | `starts.set(now)`;重置 `RateState` |
| `session.step.started` | 步骤开始 | `{sessionID, started, ...}` | 恢复路径:漏收 started 时用 `started` 补 |
| `session.execution.succeeded` / `failed` / `interrupted` | 轮次结束 | `{sessionID}` | 结算:时长 + 精确速率,清理状态 |
| `session.text.delta` | 正文流式块 | `{sessionID, assistantMessageID, ordinal, delta}` | **实时速率主数据源** |
| `session.reasoning.delta` | 思考流式块 | 同上 | 计入输出 |
| `session.tool.input.delta` | 工具参数 JSON 流式块 | 同上 | 计入输出 |
| `session.step.ended` / `failed` | 步骤结束 | `{sessionID, assistantMessageID, tokens, cost}` | **精确 token 校准** |
| `message.part.delta` / `message.updated` | (旧事件族) | — | 兜底,带防双计锁 |

## 信封解包(`dataOf`)

TUI 数据总线把载荷放在 `event.data`;官方 SDK 原始信封放在 `event.properties`。兼容三者:

```ts
const dataOf = (event) => event?.data ?? event?.properties ?? event
```

## 双事件族设计

当前 OpenCode V2 运行时以 **`session.*` 族**广播流式输出;本地安装的 SDK 类型文件可能过期(只含旧 `message.part.*` 词汇),不能作为依据。设计上**双族共存**:

- `session.*` 族:主路径,优先;
- `message.*` 族:兜底(兼容其他 OpenCode 版本);
- **防双计锁** `RateState.sessionVocab`:本轮一旦收到任一 `session.*` delta,后续 `message.part.delta` 全部忽略——同一内容块绝不计两次。

## 状态数据结构

```ts
type MsgRate = {
  est: number           // 本消息累计估算 token(来自 delta 流)
  exact?: number        // 最近一次采纳的精确 output token
  refEst: number        // 采纳 exact 时的 est 快照(用于偏差重整)
}
type RateState = {
  msgs: Map<messageID, MsgRate>
  samples: Array<{ t: number; tok: number }>   // (时刻, 累计 token) 采样
  sessionVocab: boolean                         // 防双计锁
}
```

**消息总 token**:`msgTotal = exact + max(0, est − refEst)`(未采纳精确值时即 `est`)
**轮次总 token**:`turnTotal = Σ msgTotal`(支持一轮多消息/多步)

## 轮次状态机

```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Running: session.execution.started<br/>重置 starts + RateState
    Running --> Running: session.*.delta → est累加+采样<br/>session.step.ended → adoptExact
    Running --> Idle: execution.succeeded/failed/interrupted<br/>结算 lastDuration + 精确速率
    Idle --> Running: step.started 恢复路径<br/>(漏收 started 时补 t0)
```

状态全部为**进程内存态**:重启 OpenCode 后上轮统计清零,新一轮自然重建。(校准系数与设置除外——经 storage 持久化。)

## 交互时序图

```mermaid
sequenceDiagram
    participant U as 用户
    participant TUI as OpenCode TUI
    participant S as Server 事件总线
    participant P as usage-meter 插件
    participant M as AI Provider

    U->>TUI: 提交 prompt
    TUI->>S: 启动会话执行
    S-->>P: session.execution.started
    Note over P: starts[ses]=now<br/>rates[ses]=新 RateState
    S->>M: 流式请求
    loop 流式输出(正文/思考/工具参数)
        M-->>S: 输出块
        S-->>P: session.text.delta 等
        Note over P: est += estimateTokens(delta)<br/>pushSample()
    end
    S-->>P: session.step.ended(tokens.output)
    Note over P: 精确值 > 估算值时采纳校准
    loop UI 重渲染(每 500ms tick)
        TUI->>P: footer render(sessionID)
        P-->>TUI: ⏱ …  ⚡ xx tok/s
    end
    S-->>P: session.execution.succeeded
    Note over P: 结算 lastDuration + 精确速率
    TUI-->>U: 🏁 …  ⚡ xx tok/s
```

交互式版本见 [interaction-sequence.html](../interaction-sequence.html)(可缩放/高亮/导出)。
