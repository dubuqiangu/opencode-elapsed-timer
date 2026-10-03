# 总体架构

## 项目概述

在 OpenCode TUI 中为**每个 session** 独立显示等待计时、实时输出速率、上轮终值,以及跨会话用量统计(footer Σ/hit、右栏 Stats 块、`/usage-full` 面板)。对所有 session 生效,含子代理 session。

设计目标:零采集、零存储、事件驱动、API 不可用时静默降级。校准系数与用户设置是仅有的持久化数据(官方 storage API)。

## 运行环境与加载机制

1. **发现**:OpenCode 启动时扫描 `~/.config/opencode/plugins/<name>/`,读取 `package.json` 的 `exports["./tui"]` 加载为 TUI 插件;`exports["."]` 加载为服务端插件(本插件为空占位)。
2. **模块解析**:`import { Plugin } from "@opencode/plugin/tui"` 由 OpenCode 运行时代理解析(本地无需安装);`solid-js` / `@opentui/solid` 从插件目录 `node_modules` 解析。
3. **JSX**:`.tsx` 顶部 `@jsxImportSource @opentui/solid` pragma,由 OpenCode 内置 TSX 转换器按 solid-js 语义编译。
4. **生命周期**:`setup(context)` 加载时执行一次;返回的清理函数在卸载/重载时执行(清理 interval、slot、全部订阅)。
5. **热重载限制**:`plugin update` 后必须完整重启 TUI;`/reload` 不从磁盘重载插件(详见 [runtime-lessons.md](runtime-lessons.md))。

## 三层数据流

**事件采集 → 状态计算 → 响应式渲染**:

```
OpenCode Server(事件总线)
  session.execution.* / session.step.* / session.*.delta ...
        │ context.data.on(type, handler)   ← 12 类事件订阅
        ▼
插件运行时状态(session-metrics.ts,纯内存)
  starts: Map<sessionID, t0>            轮次起始时间
  rates:  Map<sessionID, RateState>     token 记账 + 采样窗口
  lastDurations/lastExactRates/...      上轮终值
        │ Solid 信号 now() 每 500ms tick → 触发重渲染
        ▼
UI 槽位(append 模式,不覆盖原生内容)
  prompt.footer.status / sidebar.content / session.panel / app
```

关键点:**状态按 sessionID 全隔离**——多 session 并发(含子代理)互不干扰,渲染时只取当前 session 的状态。

## 渲染层

- 各 UI 表面为独立组件(见 [module-layout.md](module-layout.md)),render 内读取 `now()` 信号,tick 触发 Solid 重渲染
- **sessionID 来源**:优先 slot props,回退当前路由(`router.current()?.params?.sessionID`,兼容不同挂载点)
- **颜色**:主题 `text.muted` token,自动适配明暗主题
- **多 session**:每个 session 的 footer 各自渲染,读各自的 Map 条目

## 验证方式

- **语法/JSX**:每次改动后 esbuild 校验
  `npx esbuild src/tui.tsx --loader:.tsx=tsx --jsx=automatic`
  (完整 tsc 不可行:`@opencode/plugin/tui` 仅由 OpenCode 运行时解析,本地无类型)
- **import 解析**:bundle 校验
  `npx esbuild src/tui.tsx --bundle --platform=node --external:@opencode/* --external:@opentui/* --external:solid-js`
- **真机**:完整重启 TUI 后发起一轮对话,观察 footer/右栏/面板;stats 可经
  `opencode api get "/api/experimental/session/stats?from=<epoch_ms>"` 复现
- 每个版本必须真机验证后再叠加新功能
