/** @jsxImportSource @opentui/solid */
// Stats view components: the shared reactive body (live session header +
// detail tables), the sidebar panel contribution with its "f" fullscreen
// keymap, and the /usage-full toggle command with its dialog fallback.
// Split from tui.tsx in v0.7.x — behavior unchanged.
import { createMemo } from "solid-js"
import type { PanelContentApi } from "../panel-content"

export type StatsPanelApi = {
  StatsBody: (props: { sessionID?: string }) => any
  StatsPanel: (props: { panel: any }) => any
  runTokensCommand: () => Promise<void>
}

export function createStatsPanel(deps: { context: any; panelContent: PanelContentApi }): StatsPanelApi {
  const { context } = deps
  const { sessionLines, detail, detailLines, ensureDetail, setDetail, PANEL_NAME } = deps.panelContent

  // Shared reactive body: live session section (when in a session) + the
  // detail tables. createMemo keeps the panel ticking with the 500ms clock
  // and refreshing on every signal update.
  const StatsBody = (props: { sessionID?: string }) => {
    const lines = createMemo(() => {
      const out = [...sessionLines(props.sessionID)]
      const st = detail()
      if (!st) {
        out.push("统计加载中…")
        return out
      }
      if (st.error) {
        out.push(`统计加载失败:${st.error}`)
        return out
      }
      out.push(...detailLines(st))
      return out
    })
    const base = (context.theme as any)?.text?.base
    return <text fg={base}>{lines().join("\n")}</text>
  }

  // /usage-full toggles the sidebar panel: open when closed, collapse when open.
  // Falls back to a plain dialog outside a session (panel.open -> false).
  const runTokensCommand = async (): Promise<void> => {
    const panelAPI = (context.ui as any)?.panel
    try {
      const current = panelAPI?.current?.()
      if (current === PANEL_NAME || current?.name === PANEL_NAME) {
        panelAPI?.close?.()
        return
      }
    } catch {}
    let opened: any = true
    try {
      opened = panelAPI?.open?.(PANEL_NAME)
    } catch {
      opened = false
    }
    if (opened === false) {
      // Dialog fallback (no sidebar): still pass the current sessionID so
      // the live window/session/subagent blocks render when inside a session.
      const route: any = context.ui?.router?.current?.()
      const sid: string | undefined =
        route?.type === "session"
          ? (route.sessionID ?? route.params?.sessionID)
          : route?.params?.sessionID
      try {
        context.ui.dialog.set({ size: "large", centered: true })
      } catch {}
      setDetail(undefined)
      context.ui.dialog.show(() => <StatsBody sessionID={sid} />, () => {})
    }
    void ensureDetail()
  }

  // Sidebar panel contribution: the host owns sizing/focus/close (collapse
  // via escape or toggling /usage-full; "f" toggles fullscreen while focused).
  const StatsPanel = (props: { panel: any }) => {
    try {
      ;(context.keymap as any)?.layer?.(() => ({
        commands: [
          {
            id: "usage-meter.stats.fullscreen",
            title: "统计面板全屏",
            bind: "f",
            run: () => {
              try {
                props.panel?.toggleFullscreen?.()
              } catch {}
            },
          },
        ],
      }))
    } catch {}
    return <StatsBody sessionID={props.panel?.sessionID} />
  }

  return { StatsBody, StatsPanel, runTokensCommand }
}
