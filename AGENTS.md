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

## edit 工具使用纪律(`Could not find oldString` 专项)

本仓库 `src/` 改动频繁,是 `edit` 报 `Could not find oldString` 的高发区(实测该类错误在本项目一次会话内就出现 5 次)。历史统计显示它**从不是环境问题**(文件为 LF、无 BOM、`core.autocrlf=false`),而是 `oldString` 与磁盘内容不一致。固定下列纪律:

1. **先 `read`,再 `edit`。** `oldString` 必须逐字节从 `read` 输出复制,禁止凭记忆/印象补写。
2. **缩进按 `read` 里的实际列数抄。** 典型翻车:把 `try {` 内实际 4 缩进的 `const store` 写成 6 缩进。
3. **空行必须原样保留。** `read` 把空行渲染成 `3: `(行号 + 尾随空格),该尾随空格不可见,转录时最容易丢失——上下两段注释/声明之间的空行不得合并。
4. **`oldString` 用 3–8 行最小锚点。** 不跨文件头注释,不跨整段类型/函数声明,越大越容易失真。
5. **同一文件一轮只发一次 `edit`。** 多处改动分轮串行,或直接 `write` 整文件重写;禁止在一个批次里对同一文件并发多个 `edit`(后发的会因前一个已改而失效)。
6. **失败后必须先 `read` 再重试。** 连续两次失败禁止第三次盲猜——第二次仍失败说明是理解偏差,不是字符差异。
7. **跨 subagent 写同一文件后必须重读。** fixer/designer 落盘后,本会话此前对同文件的任何 `oldString` 一律视为失效快照。
8. **改动可能已经落地时先 `git diff` 确认。** 本项目 `src/` 常年有未提交改动;若 `newString` 的内容已存在于文件里,说明改动已应用,不要再下发同一 edit。

排查口径:`Could not find oldString` 与"多处匹配/需更多上下文"是两种不同错误,前者只可能是内容不一致——先比对缩进与空行,再怀疑文件被改过。

## 项目红线(沿用既定决策)

- 数据层零采集、零存储:只读消费服务端原生聚合 API 或已同步 TUI 状态(校准/设置持久化是唯一例外,走官方 storage API)
- tok/s 空闲终值(精确值,avg 仅回退)必须保留,不可删
- 状态标签全图标化(⏱/⏳/🏁/⚡/📊/🎯);右栏块内全英文
- 单文件 ~400 行上限,按功能拆模块(拆分零行为变化)
