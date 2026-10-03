# 运行时问题取证记录

真实环境暴露的问题、根因取证与修复。取证基准:anomalyco/opencode v2.0.21 源码(`packages/client/src/effect/api/api.ts` 等)。

## 0.6.4:stats 客户端路径 / keymap 作用域(首次真机验证暴露)

**背景**:0.6.3 安装后首次真机验证,暴露两个自 0.3.0/0.4.0 起潜伏的 bug——Σ/hit 从未显示、`/usage-full` 命令从未注册(此前所有版本停留在"待重启验证",实为从未通过)。

**根因与修复**:

| 问题 | 根因 | 修复 |
|---|---|---|
| Σ/hit 从未显示 | openapi operationId 是 `experimental.session.stats`,但 v2.0.x effect 客户端把 `stats` 挂在 `SessionApi`(`client.session.stats`);`client.experimental.session.stats` 不存在 → `statsFailed` 一次性永久失败 | 候选路径数组依次探测;`from/to` 改传 number(effect schema 运行时校验拒绝字符串) |
| 客户端未就绪即判死 | setup 时 client 方法可能尚未注入 | 缺失方法改 30s 定时重试(仅日志一次);硬失败闸门保留(跨零点复位) |
| `/usage-full` 从未注册 | `context.keymap.layer()` 在 `setup()` 直接调用抛 `Keymap.Provider is missing`(keymap 层必须从组件作用域创建);try/catch 吞掉异常 → 命令静默丢失 | 改经 `app` slot render(组件作用域)内注册,一次性 guard,失败置 `null` 防重复注册 |

## 0.6.5:空闲速率偏差(63 vs 70.5)

真机反馈空闲态显示 `63 tok/s avg` 而原生为 `70.5`。带 `avg` 后缀即说明 `message.updated` 精确通道单点未触发,回退到整轮墙钟 avg(分母含工具时间必然偏低)。实证:63 ≈ 70.5 × (15.6s 生成时长 / 17.5s 墙钟)。修复:空闲精确速率改为轮结束时从权威消息记录聚合,不再依赖事件形状。详见 [token-accounting.md](token-accounting.md)。

## 0.7.3:热重载生命周期(计时冻结/缺 tok/s)

**现象**:更新插件并 `/reload` 后,footer 计时冻结、tok/s 不再更新。

**定位(非代码 bug)**:

- `opencode plugin update` 只改磁盘包,运行中宿主仍持旧代码
- `/reload` 会执行旧实例的清理函数(拆掉 500ms 时钟与全部事件订阅)**但不从磁盘重载插件**
- 结果:旧接线死亡、新代码未加载 → 冻结

**规则:每次 `plugin update` 后必须完整重启 TUI。**已写入安装指南与已知限制。

## 经验沉淀

- openapi 文档 ≠ 客户端实际形状:SDK 生成层可能改名/换命名空间,必须运行时探测 + 源码取证
- 静默 try/catch 会吞掉注册类失败的可见性——注册动作要么成功要么显式日志,不做无声降级
- 每个版本必须真机验证后再叠加新功能(0.6.4 的两个 bug 均因缺真机验证而潜伏三个版本)
