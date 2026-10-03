/** @jsxImportSource @opentui/solid */
// v0.7.0: right-sidebar metrics block. The right column (session title +
// Context + MCP + agents sections) is the host's sidebar and exposes the
// `sidebar.content` slot — the same channel the native Context/MCP
// feature-plugins claim. Our block lands below them and mirrors the
// footer's live session readout plus today's Σ and the hit metric whose
// dimension follows the /usage-settings hitScope.
// Split from tui.tsx in v0.7.x — behavior unchanged.
import { fmtNum, format } from "../format"
import { liveRate } from "../rate-model"
import type { CalibrationApi } from "../calibration"
import type { SessionMetricsApi } from "../session-metrics"
import type { SettingsApi } from "../settings"
import type { StatsSourceApi } from "../stats-source"

export type SidebarMetricsApi = {
  SidebarMetrics: (props: { sessionID: string }) => any
}

export function createSidebarMetrics(deps: {
  context: any
  sessionMetrics: SessionMetricsApi
  settings: SettingsApi
  statsSource: StatsSourceApi
  calibration: CalibrationApi
  now: () => number
}): SidebarMetricsApi {
  const { context, now } = deps
  const { starts, lastDurations, lastAvgRates, lastExactRates, rates, backfillLastTurn } =
    deps.sessionMetrics
  const { sidebarMetricsEnabled, hitScopeEnabled, totalScopeEnabled } = deps.settings
  const { todayStats, totalFor } = deps.statsSource
  const { calibOf } = deps.calibration

  const SidebarMetrics = (props: { sessionID: string }) => {
    if (!sidebarMetricsEnabled()) return null
    const sessionID = props.sessionID
    // v0.7.5: sessions opened after a TUI restart have no in-memory turn
    // history yet — replay the last turn from synced records once (guarded).
    backfillLastTurn(sessionID)
    const running = context.data?.session?.status?.(sessionID) === "running"
    const started = starts.get(sessionID)
    const last = lastDurations.get(sessionID)
    const currentTime = now()
    const metricLines: string[] = []
    // v0.7.1: narrow column — split time and rate onto separate lines,
    // English-only labels, and unify the scope suffix in parentheses.
    if (running && started !== undefined) {
      metricLines.push(`⏱ ${format(currentTime - started)}`)
      const rate = rates.get(sessionID)
      const liveTokPerSec = rate ? liveRate(rate, currentTime) : undefined
      if (liveTokPerSec !== undefined) {
        metricLines.push(`⚡ ${Math.round(liveTokPerSec * calibOf(sessionID))} tok/s`)
      }
    } else if (running) {
      metricLines.push("⏳")
    } else if (last !== undefined) {
      metricLines.push(`🏁 ${format(last)}`)
      const exact = lastExactRates.get(sessionID)
      const avgRate = lastAvgRates.get(sessionID)
      if (exact !== undefined) metricLines.push(`⚡ ${exact} tok/s`)
      else if (avgRate !== undefined) metricLines.push(`⚡ ${avgRate} tok/s avg`)
    }
    const stats = todayStats()
    const hitScope = hitScopeEnabled()
    // v0.7.7: the 📊 total follows the persisted scope — today is the
    // default; rolling windows (24h/7d/30d) are separate read-only queries
    // fetched by the stats source on demand.
    const totalScope = totalScopeEnabled()
    const scopeStats = totalFor(totalScope)
    if (scopeStats) {
      const scopeTokens = scopeStats?.tokens
      const total =
        (scopeTokens?.input ?? 0) + (scopeTokens?.output ?? 0) + (scopeTokens?.reasoning ?? 0)
      if (total > 0) metricLines.push(`📊 ${fmtNum(total)} (${totalScope})`)
    }
    if (hitScope === "session") {
      try {
        const sessionTokens = context.data?.session?.get?.(sessionID)?.tokens
        const cacheRead = sessionTokens?.cache?.read ?? 0
        const denominator =
          (sessionTokens?.input ?? 0) + cacheRead + (sessionTokens?.cache?.write ?? 0)
        if (denominator > 0)
          metricLines.push(`🎯 ${((cacheRead / denominator) * 100).toFixed(1)}% (session)`)
      } catch {}
    } else if (stats) {
      const cacheRead = stats?.tokens?.cache?.read ?? 0
      const denominator = cacheRead + (stats?.tokens?.input ?? 0)
      if (denominator > 0)
        metricLines.push(`🎯 ${((cacheRead / denominator) * 100).toFixed(1)}% (today)`)
    }
    if (metricLines.length === 0) return null
    const muted = context.theme?.text?.muted
    return (
      <box flexDirection="column">
        <text fg={(context.theme as any)?.text?.base}>Stats</text>
        <text fg={muted}>{metricLines.join("\n")}</text>
      </box>
    )
  }

  return { SidebarMetrics }
}
