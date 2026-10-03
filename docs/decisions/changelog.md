# 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-09-29 | 0.1.0 | 初版:等待计时 + 上轮时长 |
| 2026-10-01 | 0.2.0 | 实时 tok/s:迁移到 `session.*` 事件族(根因:运行时弃用 `message.part.delta` 广播),增加精确 token 校准、防双计锁、空闲平均速率 |
| 2026-10-02 | 0.2.0 | 分发方式升级:git 仓库化发布 GitHub(`github:dubuqiangu/opencode-elapsed-timer`),原生一键安装实测通过;移除 install.ps1 与 junction 加载,补齐 LICENSE/.gitignore/发布规范 package.json;运行逻辑无变化 |
| 2026-10-03 | 0.3.0 | 跨会话消耗统计:footer 新增今日总耗 Σ,新增 `/tokens` 命令(今日按模型明细/近7日趋势/累计汇总);直接消费服务端原生 `GET /api/experimental/session/stats`(from/to 为 epoch 毫秒串,timezone 传本地时区),无采集层、无本地存储、无 RPC;API 不可用时静默降级 |
| 2026-10-03 | 0.4.0 | `/tokens` 升级为开关式 `session.panel` 侧边栏面板:头部当前会话实时读数(计时/tok/s/Σ,createMemo 响应式),`/tokens`/Esc 收起、`f` 全屏、面板打开期间 step 结束自动刷新;会话外降级为弹窗;footer 保持不变 |
| 2026-10-03 | 0.4.1 | 目录布局改为 `src/`(官方示例同款):`index.ts`/`tui.tsx` 移入 `src/`,exports 指向 `./src/*`;纯结构调整,运行逻辑无变化 |
| 2026-10-03 | 0.4.2 | 缓存命中率:footer Σ 旁追加 `hit nn%`(今日口径),`/tokens` 面板"今日合计"与"累计"均显示命中率;口径 `cache.read ÷ (cache.read + input)`,无输入上下文时隐藏 |
| 2026-10-03 | 0.5.0 | 更名:项目/包 `opencode-elapsed-timer` → **`opencode-usage-meter`**(功能早已超出"计时器":计时/tok/s/今日与累计 token/命中率/统计面板,名实对齐);插件 id `elapsed-timer` → `usage-meter`,面板名 `usage-meter.stats`,斜杠命令改为 **`/usage-full`**(移除 `/tokens` 及全部别名,避免与其他插件冲突);GitHub 仓库同步改名(旧地址自动重定向);功能集无变化 |
| 2026-10-03 | 0.6.0 | 当前会话窗口微观:footer 追加 `ctx nn%`(≥80% 显示 `▲` 与警示色,即 80% 压缩预警);`/usage-full` 面板新增"当前窗口"(最后请求 in/out/reasoning/cache 分项 + 占用%)、"本会话累计"(权威 `session.tokens` 聚合 + 轮数 + 会话级命中率 + cost)、"子代理"(`parentID` 委派树 BFS 归总 + 会话子代理合计)三块;会话级命中率采用更严口径 `read ÷ (input+read+write)`;全部只读已同步 TUI 状态,零服务端调用;设计见用量统计文档 |
| 2026-10-03 | 0.6.1 | 代码审视修复:footer ctx 段改用 box(row) 兄弟 `<text>` 分色(不嵌套 text 于 text,规避渲染兼容风险);降级弹窗传入当前 sessionID,会话内弹窗兜底同样展示当前窗口/本会话/子代理三块;子代理块在全部子会话零用量时隐藏(防零值噪音) |
| 2026-10-03 | 0.6.2 | tok/s 精确化:空闲态改为消息级**精确速率**(`output+reasoning ÷ created→completed`,与原生统计同口径,旧 avg 降为回退);流式估算加**每轮自校准**(会话级 EMA 系数 `精确/估算`,钳位 0.25-4,后续轮次偏差 ~5-10%) |
| 2026-10-03 | 0.6.3 | 精度增强:校准系数按模型持久化(`storage.store`,跨会话/重启复用,冷启动即校准);子代理块对每个子会话触发一次性 `session.sync()`(修后台子会话数据陈旧/整块被隐藏);轮数在消息窗截断时标 `N+`;修复 adoptExact 变量遮蔽 bug |
| 2026-10-03 | 0.6.4 | 首次真机验证暴露的运行时修复:stats 客户端方法改走 `client.session.stats`(v2.0.21 `SessionApi` 实际路径,原 `experimental.session.stats` 不存在致 Σ/hit 从未显示)+ `from/to` 改传 number(effect schema 校验);客户端方法缺失改 30s 重试不再一次性判死;keymap layer 改从 `app` slot 组件作用域注册(原 `setup()` 直接调用抛 `Keymap.Provider is missing` 被吞,命令从未注册);footer 移除 ctx 段(与 tok/s 同级冗余,面板"当前窗口"块保留完整口径) |
| 2026-10-03 | 0.6.5 | tok/s 空闲值真机偏差修复:原生 70.5 vs 插件 63 avg——`message.updated` 精确通道单点不可靠,空闲精确速率改为轮结束时从权威消息记录聚合(`Σ(output+reasoning) ÷ Σ(created→completed)`,原生同口径),1.5s 延迟重算兜底,`tsOf` 容忍式时间戳解析,时长 <60s 显示一位小数对齐原生;核实宿主已内置完成通知,"完成提示音"自研项撤销 |
| 2026-10-03 | 0.6.6 | footer hit 维度可配置:新增 `/usage-dim` 命令切换今日汇总 ⇄ 当前会话(单会话严格口径),storage 持久化 + toast 反馈 + 响应式即时生效;取证确认 2.0.21 宿主无插件 options 配置通道,故配置走命令+存储 |
| 2026-10-03 | 0.6.7 | 配置入口重构(命名清晰化):`/usage-dim` → **`/usage-settings` 设置弹窗**(可扩展),弹窗内 `d` 切换、状态响应式刷新、自动持久化;另保留命令面板"切换 hit 维度"直切命令兜底 |
| 2026-10-03 | 0.6.8 | hit 一位小数(整数百分比在日级比值天然稳定时看似"冻结")+ Σ/hit 60s 周期刷新(后台会话消耗不触发本会话轮事件,空闲期不再滞后) |
| 2026-10-03 | 0.7.0 | footer 重定默认 + 右栏指标块:footer 默认只显示 ⏱/⚡(速率链路含空闲精确终值不变),`Σ`/`hit` 改为 `/usage-settings` opt-in 开关(默认关,`f`/`h` 切换);新增右栏 Stats 块(`append: "sidebar.content"`,与宿主 Context/MCP 区块同通道,默认开,`b` 切换);设置读取器对旧存储缺键按文档默认值归一 |
| 2026-10-03 | 0.7.1 | 右栏块真机反馈样式修复:⏱/⚡ 分行展示(窄列单行被挤压换行);块内标签全英文,标题"用量"→`Stats`;Σ/hit 改图标 `📊`/`🎯`,范围标注统一括号后缀 `(today)`/`(session)` |
| 2026-10-03 | 0.7.2 | 代码模块化拆分(纯结构调整,行为零变化):tui.tsx 1275 行 → 入口仅 278 行组装,12 个功能模块(见 module-layout.md);空闲置行 `✓ last` 改终点旗 `🏁` 三处统一;拆分规则写入全局 AGENTS.md §5 代码组织 |
| 2026-10-03 | 0.7.3 | 状态标签全图标化:`⏱ waited` → `⏱`、运行中无起点态 → `⏳`(footer/右栏/面板三处);真机反馈"计时冻结/缺 tok/s"定位为宿主未重启 + `/reload` 拆除旧实例定时器与订阅但不重载插件(非代码 bug),记入已知限制 |
| 2026-10-03 | — | 文档体系重构:DESIGN.md 单文件 → `docs/` 总览 + guides/features/architecture/decisions 分类分文件,根 README 瘦身为入口页;DESIGN.md 保留为指针。纯文档变更,无代码改动 |
| 2026-10-03 | 0.7.4 | 单元测试套件:新增 `test/`(与 src 同级,38 用例)——format/rate-model/settings/calibration/session-metrics 五个模块的纯函数与 factory 层,含轮次生命周期、防双计锁、EMA 钳位收敛、旧存储归一等关键行为;零 devDependency(Node ≥22 原生 type stripping + node:test + 15 行解析钩子),`npm test` 一键执行;运行时行为零变化 |
| 2026-10-03 | 0.7.5 | 冷启动回填:重开终端/接手旧会话时,上轮 `🏁` 时长与 `⚡` 精确速率立即可见——footer/右栏渲染时对无内存记录的会话,从已同步权威消息记录回放上一轮(末条 user 消息 → 末条已完成 assistant);三重防护:已有实时记录不覆盖、运行中不写、末条消息未完成(异端运行中)不显示旧值;数据源与 finishTurn 精确结算同源,零新增采集 |
| 2026-10-03 | — | 一键安装自验证:新增 `scripts/verify-install.ps1`(update → plugin list commit 一致 → 落盘版本 → src/test/docs 文件树镜像 → opencode.json 注册,全过输出 VERIFY OK)+ 项目级 AGENTS.md 固化发布闭环(自验证为固定最后一步)。纯脚本/文档变更,无运行时改动 |
