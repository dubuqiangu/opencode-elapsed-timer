# 项目级工作规则(opencode-usage-meter)

本文件是插件仓库的项目级约束;全局规则见用户全局 AGENTS.md(推送前脱敏扫描、命名、代码组织等,此处不重复)。

## 发布闭环(每次改动的固定顺序)

1. 改 `src/` → esbuild 语法 + bundle 校验(命令见 [docs/architecture/overview.md](docs/architecture/overview.md))
2. `npm test`(test/ 全绿才继续)
3. 脱敏扫描——**独立成步,先读输出再推送**(细则见全局 AGENTS.md §2)
4. commit + push(纯文档/脚本改动不 bump 版本;任何 `src/` 或 package.json 运行时变更必须 bump)
5. **一键安装自验证(固定最后一步,不可省略)**:

   ```sh
   pwsh scripts/verify-install.ps1
   ```

   必须在**独立的一步**运行并**读取全部输出**,确认最后一行 `VERIFY OK` 且零 `FAIL`。它验证:本地 HEAD 已推送 → `plugin update` → `plugin list` commit 一致 → 落盘版本与 package.json 一致 → src/test/docs 文件树与仓库一致 → opencode.json 注册。任何一项 FAIL 都不得视为发布完成,先修复再重跑。

6. 提示用户**完整重启 TUI** 真机验证(热重载限制见 [docs/guides/install.md](docs/guides/install.md))。

## 项目红线(沿用既定决策)

- 数据层零采集、零存储:只读消费服务端原生聚合 API 或已同步 TUI 状态(校准/设置持久化是唯一例外,走官方 storage API)
- tok/s 空闲终值(精确值,avg 仅回退)必须保留,不可删
- 状态标签全图标化(⏱/⏳/🏁/⚡/📊/🎯);右栏块内全英文
- 单文件 ~400 行上限,按功能拆模块(拆分零行为变化)
