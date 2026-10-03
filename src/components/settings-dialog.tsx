/** @jsxImportSource @opentui/solid */
// v0.6.7: /usage-settings — extensible settings dialog (currently one
// item family: the footer hit dimension and footer/sidebar toggles).
// Reactive reads from the settings store mean the body re-renders the
// moment a value changes. Split from tui.tsx in v0.7.x — behavior unchanged.
import type { SettingsApi, TotalScope } from "../settings"
import { TOTAL_SCOPE_LABELS } from "../settings"

export type SettingsDialogApi = {
  SettingsBody: () => any
}

export function createSettingsDialog(deps: { context: any; settings: SettingsApi }): SettingsDialogApi {
  const { context } = deps
  const {
    hitScopeEnabled,
    totalScopeEnabled,
    footerSigmaEnabled,
    footerHitEnabled,
    sidebarMetricsEnabled,
    toggleSettingsFlag,
    toggleHitScope,
    cycleTotalScope,
  } = deps.settings

  const SettingsBody = () => {
    // Keymap layers must be created from a component scope (see §12D).
    try {
      ;(context.keymap as any)?.layer?.(() => ({
        commands: [
          {
            id: "usage-meter.settings.toggle-hit",
            title: "用量设置:切换 hit 维度",
            bind: "d",
            run: () => toggleHitScope(),
          },
          {
            id: "usage-meter.settings.cycle-total-scope",
            title: "用量设置:Σ/📊 总耗维度",
            bind: "s",
            run: () => cycleTotalScope(),
          },
          {
            id: "usage-meter.settings.toggle-footer-sigma",
            title: "用量设置:footer Σ 段开关",
            bind: "f",
            run: () => toggleSettingsFlag("footerSigma", footerSigmaEnabled()),
          },
          {
            id: "usage-meter.settings.toggle-footer-hit",
            title: "用量设置:footer hit 段开关",
            bind: "h",
            run: () => toggleSettingsFlag("footerHit", footerHitEnabled()),
          },
          {
            id: "usage-meter.settings.toggle-sidebar",
            title: "用量设置:右栏指标块开关",
            bind: "b",
            run: () => toggleSettingsFlag("sidebarMetrics", sidebarMetricsEnabled()),
          },
        ],
      }))
    } catch {}
    const onOff = (enabled: boolean): string => (enabled ? "开" : "关")
    const hitScopeLabel =
      hitScopeEnabled() === "session"
        ? "当前会话(hit·s,严格口径 read ÷ (input+read+write))"
        : "今日汇总(hit,全 session 日级,read ÷ (read+input))"
    const totalScope = totalScopeEnabled() as TotalScope
    const totalScopeLabel = `${TOTAL_SCOPE_LABELS[totalScope]}(今日=本地零点起,其余为滚动窗口)`
    const lines = [
      "用量设置",
      "──────────────────────────────",
      `hit 维度:${hitScopeLabel}`,
      `Σ/📊 总耗维度:${totalScopeLabel}`,
      `footer Σ 段:${onOff(footerSigmaEnabled())}`,
      `footer hit 段:${onOff(footerHitEnabled())}`,
      `右栏指标块:${onOff(sidebarMetricsEnabled())}`,
      "",
      "d hit 维度 · s Σ 维度 · f footer Σ · h footer hit · b 右栏块 · Esc 关闭",
      "(footer 默认只显示 ⏱ 与 ⚡,其余段按需开启;选择自动持久化)",
    ]
    return <text fg={(context.theme as any)?.text?.base}>{lines.join("\n")}</text>
  }

  return { SettingsBody }
}
