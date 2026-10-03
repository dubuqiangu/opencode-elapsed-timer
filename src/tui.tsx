/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI plugin "usage-meter" — assembly root. Shows usage
// indicators in the prompt footer status row (waited timer, live tok/s,
// last-turn readout, opt-in Σ/hit segments), plus the /usage-full stats
// panel, the /usage-settings dialog, and the right-sidebar metrics block.
//
// Split in v0.7.x into focused modules (pure structural move, behavior
// unchanged — this file only wires factories, slots, commands, events
// and cleanup in the original order):
//   format.ts          — pure formatting / token-estimation helpers
//   rate-model.ts      — rate math types + pure functions + event accessors
//   calibration.ts    — live/persisted per-model rate calibration
//   settings.ts        — durable settings store + readers / toggles
//   stats-source.ts    — daily-usage stats fetch / refresh / midnight rollover
//   session-metrics.ts — per-session runtime state + event handlers
//   panel-content.ts   — panel text builders (window / session / detail)
//   components/stats-panel.tsx      — StatsBody / StatsPanel / /usage-full
//   components/settings-dialog.tsx  — /usage-settings dialog body
//   components/sidebar-metrics.tsx  — sidebar.content metrics block
//   components/footer-status.tsx    — prompt.footer.status component
//
// Token sources (current OpenCode emits the session.* event family):
//   session.text.delta / session.reasoning.delta / session.tool.input.delta
//     -> real-time streaming chunks { sessionID, assistantMessageID, ordinal, delta }
//   session.step.ended / session.step.failed -> exact tokens { tokens: { output, ... } }
//   message.part.delta / message.updated kept as legacy fallbacks (guarded).
import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { createCalibration } from "./calibration"
import { createSettings } from "./settings"
import { createStatsSource } from "./stats-source"
import { createSessionMetrics } from "./session-metrics"
import { createPanelContent, PANEL_NAME } from "./panel-content"
import { createStatsPanel } from "./components/stats-panel"
import { createSettingsDialog } from "./components/settings-dialog"
import { createSidebarMetrics } from "./components/sidebar-metrics"
import { createFooterStatus } from "./components/footer-status"

export default Plugin.define({
  id: "usage-meter",
  setup(context: any) {
    // Ticking clock drives the elapsed recompute while a run is active, and
    // detects the midnight rollover for the daily usage stats.
    const [now, setNow] = createSignal(Date.now())

    // Module factories. Creation order preserves the original storage-store
    // subscription order (calibration store first, then settings store).
    const calibration = createCalibration(context)
    const settings = createSettings(context)
    const statsSource = createStatsSource(context)
    const sessionMetrics = createSessionMetrics({
      context,
      calibration,
      scheduleStatsRefresh: statsSource.scheduleStatsRefresh,
    })
    const panelContent = createPanelContent({
      context,
      sessionMetrics,
      statsSource,
      calibration,
      now,
    })
    const statsPanel = createStatsPanel({ context, panelContent })
    const settingsDialog = createSettingsDialog({ context, settings })
    const sidebarMetrics = createSidebarMetrics({
      context,
      sessionMetrics,
      settings,
      statsSource,
      calibration,
      now,
    })
    const footerStatus = createFooterStatus({
      context,
      sessionMetrics,
      settings,
      statsSource,
      calibration,
      now,
    })
    // The debounced stats refresh also refreshes an open stats panel; the
    // panel-name check + ensureDetail live here next to the panel assembly
    // (stats-source guards the call with the same try/catch as before).
    statsSource.bindPanelRefresh(() => {
      const current = (context.ui as any)?.panel?.current?.()
      if (current === PANEL_NAME || current?.name === PANEL_NAME) void panelContent.ensureDetail()
    })

    const timer = setInterval(() => {
      setNow(Date.now())
      statsSource.checkMidnightRollover()
    }, 500)

    const subs: Array<() => void> = []
    const listen = (type: string, handler: (event: any) => void) => {
      try {
        subs.push(context.data.on(type, handler))
      } catch (error) {
        console.error(`[usage-meter] ${type} subscription failed:`, error)
      }
    }

    const { StatsPanel, runTokensCommand } = statsPanel
    const { SettingsBody } = settingsDialog
    const { SidebarMetrics } = sidebarMetrics
    const { FooterStatus } = footerStatus

    // --- /usage-full stats view: sidebar panel (in-session) + dialog fallback ---
    let unregisterPanel: any
    try {
      unregisterPanel = context.ui.slot({
        append: "session.panel",
        render: (panel: any) =>
          panel?.name === PANEL_NAME ? <StatsPanel panel={panel} /> : null,
      })
    } catch (error) {
      console.error("[usage-meter] session.panel slot failed:", error)
    }

    let unregisterSidebarSlot: any
    try {
      unregisterSidebarSlot = context.ui.slot({
        append: "sidebar.content",
        render: (sidebarProps: any) =>
          sidebarProps?.sessionID
            ? <SidebarMetrics sessionID={sidebarProps.sessionID} />
            : null,
      })
    } catch (error) {
      console.error("[usage-meter] sidebar.content slot failed:", error)
    }

    // /usage-full + palette commands "用量统计" / "用量设置".
    // v0.6.4 runtime fix: a keymap layer must be created from a component
    // scope — calling it directly from setup() throws "Keymap.Provider is
    // missing" on the host, which silently killed the /usage-full command
    // in 0.6.x. Register from an `app` slot render instead (runs once inside
    // the component tree).
    let layerDispose: any
    let unregisterAppSlot: any
    try {
      unregisterAppSlot = context.ui.slot({
        append: "app",
        render: () => {
          if (layerDispose === undefined) {
            try {
              layerDispose = (context.keymap as any)?.layer?.(() => ({
                mode: "global",
                commands: [
                  {
                    id: "usage-meter.usage",
                    title: "用量统计(面板开关)",
                    group: "usage-meter",
                    palette: true,
                    slash: { name: "usage-full" },
                    run: () => {
                      void runTokensCommand()
                    },
                  },
                  {
                    // v0.6.7: /usage-settings — extensible settings dialog
                    // (footer hit dimension today; more items later).
                    id: "usage-meter.settings",
                    title: "用量设置(footer 指标维度等)",
                    group: "usage-meter",
                    palette: true,
                    slash: { name: "usage-settings" },
                    run: () => {
                      try {
                        context.ui.dialog.set({ size: "large", centered: true })
                      } catch {}
                      try {
                        context.ui.dialog.show(() => <SettingsBody />, () => {})
                      } catch (error) {
                        console.error("[usage-meter] settings dialog failed:", error)
                      }
                    },
                  },
                  {
                    // Palette-only backup toggle: works even if the dialog's
                    // in-dialog keybind cannot register on some hosts.
                    id: "usage-meter.hit-scope",
                    title: "切换 hit 维度(今日汇总 ⇄ 当前会话)",
                    group: "usage-meter",
                    palette: true,
                    run: () => {
                      settings.toggleHitScope()
                      try {
                        const next = settings.settingsStore?.hitScope
                        ;(context.ui as any)?.toast?.show?.({
                          title: "usage-meter",
                          message:
                            next === "session"
                              ? "hit 维度:当前会话(hit·s,严格口径)"
                              : "hit 维度:今日汇总(hit,全 session)",
                        })
                      } catch {}
                    },
                  },
                ],
              }))
            } catch (error) {
              layerDispose = null
              console.error("[usage-meter] keymap layer failed:", error)
            }
          }
          return null
        },
      })
    } catch (error) {
      console.error("[usage-meter] app slot failed:", error)
    }

    // --- Session lifecycle events (original registration order) ----------
    listen("session.execution.started", sessionMetrics.onExecutionStarted)
    listen("session.step.started", sessionMetrics.onStepStarted)
    listen("session.execution.succeeded", sessionMetrics.finishTurn)
    listen("session.execution.failed", sessionMetrics.finishTurn)
    listen("session.execution.interrupted", sessionMetrics.finishTurn)
    listen("session.text.delta", sessionMetrics.onSessionDelta)
    listen("session.reasoning.delta", sessionMetrics.onSessionDelta)
    listen("session.tool.input.delta", sessionMetrics.onSessionDelta)
    listen("session.step.ended", sessionMetrics.onStepEnded)
    listen("session.step.failed", sessionMetrics.onStepEnded)
    listen("message.part.delta", sessionMetrics.onLegacyDelta)
    listen("message.updated", sessionMetrics.onMessageUpdated)

    // Initial daily-usage load for the footer Σ.
    void statsSource.fetchToday()
    // v0.6.8: periodic refresh (60s) — background sessions (subagents,
    // headless runs) consume usage without firing this session's turn
    // events, so the daily footer stats could lag indefinitely while idle.
    const statsInterval = setInterval(() => void statsSource.fetchToday(), 60_000)

    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render: (slotProps: any) => <FooterStatus slotProps={slotProps} />,
    })

    return () => {
      clearInterval(timer)
      clearInterval(statsInterval)
      statsSource.release()
      if (typeof unregister === "function") unregister()
      if (typeof unregisterSidebarSlot === "function") {
        try {
          unregisterSidebarSlot()
        } catch {}
      }
      if (typeof unregisterAppSlot === "function") {
        try {
          unregisterAppSlot()
        } catch {}
      }
      if (typeof unregisterPanel === "function") {
        try {
          unregisterPanel()
        } catch {}
      }
      if (typeof layerDispose === "function") {
        try {
          layerDispose()
        } catch {}
      } else if (layerDispose && typeof layerDispose.dispose === "function") {
        try {
          layerDispose.dispose()
        } catch {}
      }
      subs.forEach((stop) => {
        try {
          stop()
        } catch {}
      })
      calibration.release()
      settings.release()
    }
  },
})
