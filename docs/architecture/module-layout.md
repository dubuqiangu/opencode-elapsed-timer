# 代码模块结构(0.7.2 拆分)

入口只做组装,按功能维度解耦;单文件超过 ~400 行或职责混杂即拆,改一处功能只碰一个文件。

```
src/
  tui.tsx            入口:Plugin.define + 工厂装配 + 事件/slot/命令注册 + 清理
  format.ts          纯格式化(format/fmtNum/fmtUSD)与 token 估算
  rate-model.ts      速率数学(滑动窗口/精确采纳)+ 事件访问器(纯函数)
  calibration.ts     每模型持久化校准(storage store + EMA 学习)
  settings.ts        /usage-settings 持久化设置 + 归一读取器/开关
  stats-source.ts    日级统计拉取/防抖刷新/跨零点/重试
  session-metrics.ts 每会话运行时状态 + session.*/message.* 事件处理
  panel-content.ts   /usage-full 面板文本构建(窗口/本会话/子代理/明细)
  components/
    footer-status.tsx     prompt.footer.status 状态行组件
    sidebar-metrics.tsx   右栏 Stats 块组件
    stats-panel.tsx       面板/dialog 组件 + /usage-full 命令
    settings-dialog.tsx   /usage-settings 弹窗组件
```

## 模块接口(factory 模式)

setup 内的闭包状态拆为各 factory,依赖显式注入:

| 工厂 | 返回 | 依赖 |
|---|---|---|
| `createCalibration(context)` | `calibOf` / `learnCalibration` / `rememberSessionModel` / `release` | storage |
| `createSettings(context)` | store + 读取器 + 开关 | storage |
| `createStatsSource(context)` | `todayStats` 信号 / `fetchToday` / `scheduleStatsRefresh` / `checkMidnightRollover` / `release` | client |
| `createSessionMetrics(deps)` | 事件处理器 + 每会话 Map(`starts`/`lastDurations`/`rates`/...) | context, calibration, statsSource |
| `createPanelContent(deps)` | 面板文本构建函数 + `ensureDetail` | context, sessionMetrics, statsSource |
| `createStatsPanel` / `createSettingsDialog` / `createSidebarMetrics` / `createFooterStatus` | 各 UI 组件 | 对应数据模块 + `now` 信号 |

`tui.tsx` 按原顺序创建工厂、注册事件与 slot、组装清理函数——**行为零变化**的纯结构调整。

## 单元测试(test/,0.7.4 起)

零 devDependency:Node ≥ 22 原生 type stripping + `node:test`;`npm test` 执行。

```
test/
  test-loader.mjs         仅测试用的模块解析钩子(src 内无扩展名 TS 互导 → 重试 .ts)
  format.test.ts          时长/数量/费用格式化、CJK token 估算
  rate-model.test.ts      消息/轮次记账、滑窗采样、liveRate 门槛、事件信封访问器
  settings.test.ts        设置默认值、旧版本存储归一、开关持久化
  calibration.test.ts     校准默认值、EMA 学习与 0.25-4 钳位、按模型持久化
  stats-source.test.ts    日用统计取数:number 入参契约、信封解包、防抖与 30s 重试定时器独立(0.7.6)
  session-metrics.test.ts 轮次生命周期:启动/delta/精确采纳/防双计锁/空闲精确速率结算/冷启动回填(含三重防护)
```

覆盖纯函数层与 factory 层;UI 组件(solid-js 渲染)与宿主交互不在 UT 范围,按项目惯例走真机验证。

## 关键约定

- `package.json` 的 `exports["./tui"]: "./src/tui.tsx"` 是 OpenCode 发现 TUI 插件的约定,不可改
- JSX 组件文件首行 `/** @jsxImportSource @opentui/solid */` pragma
- keymap layer 必须从组件作用域注册(app slot render),不得在 `setup()` 直接调用(见 [runtime-lessons.md](runtime-lessons.md))
- 耐久 store 由宿主管理,factory 的 `release` 对其保持 no-op(接口对齐用),仅定时器/订阅需要显式释放
