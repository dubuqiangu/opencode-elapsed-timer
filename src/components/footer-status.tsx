/** @jsxImportSource @opentui/solid */
// Footer slot component: waited timer / live tok/s / last-turn readout in
// the prompt footer status row, plus the opt-in Σ and hit segments.
// Split from tui.tsx in v0.7.x — behavior unchanged (same segment order,
// formulas and reactive reads as the original slot render).
import { fmtNum, format } from "../format"
import { liveRate } from "../rate-model"
import type { CalibrationApi } from "../calibration"
import type { SessionMetricsApi } from "../session-metrics"
import type { SettingsApi } from "../settings"
import type { StatsSourceApi } from "../stats-source"

export type FooterStatusApi = {
  FooterStatus: (componentProps: { slotProps?: any }) => any
}

export function createFooterStatus(deps: {
  context: any
  sessionMetrics: SessionMetricsApi
  settings: SettingsApi
  statsSource: StatsSourceApi
  calibration: CalibrationApi
  now: () => number
}): FooterStatusApi {
  const { context, now } = deps
  const { starts, lastDurations, lastAvgRates, lastExactRates, rates } = deps.sessionMetrics
  const { hitScopeEnabled, footerHitEnabled, footerSigmaEnabled } = deps.settings
  const { todayStats } = deps.statsSource
  const { calibOf } = deps.calibration

  const FooterStatus = (componentProps: { slotProps?: any }) => {
    const slotProps = componentProps.slotProps
    const sessionID: string | undefined = slotProps?.sessionID
      ?? context.ui?.router?.current?.()?.params?.sessionID
    if (!sessionID) return null

    const running = context.data?.session?.status?.(sessionID) === "running"
    const started = starts.get(sessionID)
    const last = lastDurations.get(sessionID)
    const currentTime = now()

    const parts: string[] = []
    if (running && started !== undefined) {
      // v0.7.3: icon-only state labels — ⏱ elapsed while waiting, ⏳ running
      // without a start timestamp, 🏁 last turn. No textual state words.
      parts.push(`⏱ ${format(currentTime - started)}`)
      const rate = rates.get(sessionID)
      const tps = rate ? liveRate(rate, currentTime) : undefined
      if (tps !== undefined) parts.push(`⚡ ${Math.round(tps * calibOf(sessionID))} tok/s`)
    } else if (running) {
      parts.push(`⏳`)
    } else if (last !== undefined) {
      // v0.7.2: checkered flag replaces the "✓ last" wording (icon-only
      // labels, consistent with ⏱/⚡/📊/🎯).
      parts.push(`🏁 ${format(last)}`)
      const exact = lastExactRates.get(sessionID)
      if (exact !== undefined) {
        parts.push(`⚡ ${exact} tok/s`)
      } else {
        const avg = lastAvgRates.get(sessionID)
        if (avg !== undefined) parts.push(`⚡ ${avg} tok/s avg`)
      }
    }
    // v0.7.0: Σ/hit footer segments are opt-in via /usage-settings (the
    // footer defaults to waited + tok/s only). The hit scope stays
    // configurable: "today" (all-session daily aggregate, read/(read+input))
    // or "session" (strict read/(input+read+write), shown as "hit·s").
    // Reads are reactive: toggling updates at once.
    const hitScope = hitScopeEnabled()
    const showHitInFooter = footerHitEnabled()
    if (showHitInFooter && hitScope === "session") {
      try {
        const sessionTokens = context.data?.session?.get?.(sessionID)?.tokens
        const cacheRead = sessionTokens?.cache?.read ?? 0
        const denominator = (sessionTokens?.input ?? 0) + cacheRead + (sessionTokens?.cache?.write ?? 0)
        // One decimal: the daily/session ratio is naturally stable, so an
        // integer percent looks frozen while the underlying counts move.
        if (denominator > 0) parts.push(`hit·s ${((cacheRead / denominator) * 100).toFixed(1)}%`)
      } catch {}
    }
    const stats = todayStats()
    if (stats) {
      const todayTokens = stats?.tokens
      const total =
        (todayTokens?.input ?? 0) + (todayTokens?.output ?? 0) + (todayTokens?.reasoning ?? 0)
      if (footerSigmaEnabled() && total > 0) {
        parts.push(`Σ ${fmtNum(total)}`)
      }
      if (showHitInFooter && hitScope !== "session") {
        const cacheRead = todayTokens?.cache?.read ?? 0
        const denominator = cacheRead + (todayTokens?.input ?? 0)
        if (denominator > 0) parts.push(`hit ${((cacheRead / denominator) * 100).toFixed(1)}%`)
      }
    }
    // v0.6.4: the ctx readout moved out of the footer (redundant at the
    // same level as tok/s; the /usage-full panel keeps the full 当前窗口
    // block). ctxPercent() stays implemented in panel-content for a future
    // surface.
    if (parts.length === 0) return null
    const muted = context.theme?.text?.muted
    return <text fg={muted}>{parts.join("   ")}</text>
  }

  return { FooterStatus }
}
