# 安装 / 更新 / 验证 / 卸载

适用于 OpenCode ≥ V2。

## 一键安装

任意目录执行一条命令,克隆、依赖安装、注册全部自动完成:

```sh
opencode plugin add github:dubuqiangu/opencode-usage-meter
```

**重启 opencode**(或 `opencode service restart` 后重开 TUI)即可生效。

## 更新

```sh
opencode plugin update github:dubuqiangu/opencode-usage-meter
```

`opencode plugin list` 可查看当前已安装版本(commit 号)。

> ⚠️ **热重载限制(重要)**:`plugin update` 只更新磁盘包,**运行中的宿主仍持有旧代码**;`/reload` 会拆掉旧实例的定时器与事件订阅但不从磁盘重载插件——表现为计时冻结、tok/s 停更。**每次更新后必须完整重启 TUI。**详见 [runtime-lessons.md](../architecture/runtime-lessons.md)。

## 备选安装方式

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

### 一键安装自验证(推荐,发布后必跑)

仓库自带的安装链路自验证脚本,一条命令完成 update → 注册 → 落盘全套核对:

```sh
pwsh scripts/verify-install.ps1
```

检查项:本地 HEAD 已推送、`plugin list` commit 与 HEAD 一致、落盘版本与 package.json 一致、src/test/docs 文件树与仓库镜像一致、opencode.json 注册。全部通过输出 `VERIFY OK`,任一失败输出 `FAIL` 并以非零码退出。

> 脚本只验证**磁盘安装态**;运行中的 TUI 仍持旧代码,须完整重启(见下)。

### 真机验证

1. 重启 opencode(或 `opencode service restart` 后重开 TUI)
2. 任意会话里发一条消息
3. 状态行出现 `⏱ …` 跳动与 `⚡ … tok/s` 流速;跑完变 `🏁 …   ⚡ … tok/s`(或 avg 回退);0.7.5 起重开终端接手的旧会话也立即可见上轮 `🏁/⚡`(冷启动回填)

若状态行无显示:`~/.local/share/opencode/log/opencode.log` 过滤 `role=cli` 查插件加载错误。

## 卸载

```sh
opencode plugin remove github:dubuqiangu/opencode-usage-meter
```

或删除 `~/.config/opencode/plugins/usage-meter` 后重启。
