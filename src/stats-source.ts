// --- Daily usage stats (server-native SessionStats aggregation) -------
// Read-only queries against GET /api/experimental/session/stats.
// The server aggregates every session (TUI, headless, subagents); the
// plugin only renders. `from`/`to` are epoch milliseconds (SDK `number`).
// v0.7.7: besides "today" (local midnight), the Σ/📊 total can follow a
// rolling window (last 24h / 7d / 30d) — each scope is one extra read-only
// query; only the active scope is fetched.
// Split from tui.tsx in v0.7.x — behavior unchanged.
import { createSignal } from "solid-js"
import type { TotalScope } from "./settings"

export type StatsSourceApi = {
  todayStats: () => any
  setTodayStats: (value: any) => void
  rangeStats: () => Partial<Record<TotalScope, any>>
  totalFor: (scope: TotalScope) => any
  fetchToday: () => Promise<void>
  fetchRange: (scope: TotalScope) => Promise<void>
  fetchTotals: () => void
  scheduleStatsRefresh: (delayMs?: number) => void
  bindPanelRefresh: (refresh: () => void) => void
  checkMidnightRollover: () => void
  statsCall: () => ((input: any) => Promise<any>) | undefined
  localMidnight: () => number
  scopeStartMs: (scope: TotalScope) => number
  unwrap: (res: any) => any
  timezone: string | undefined
  release: () => void
}

// Rolling-window lengths for the non-"today" total scopes.
const ROLLING_WINDOW_MS: Record<Exclude<TotalScope, "today">, number> = {
  "24h": 24 * 3_600_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
}

export function createStatsSource(
  context: any,
  totalScopeEnabled: () => TotalScope = () => "today",
): StatsSourceApi {
  const [todayStats, setTodayStats] = createSignal<any>(undefined)
  // v0.7.7: aggregates per rolling scope, keyed by scope. Only the active
  // scope is fetched; switching scopes triggers one extra read-only query.
  const [rangeStats, setRangeStats] = createSignal<Partial<Record<TotalScope, any>>>({})
  let statsDay = new Date().toDateString()
  let statsFailed = false // reserved: hard-fail gate (reset at day rollover); missing client method now retries on a timer
  let statsBusy = false
  // v0.7.6: the step-refresh debounce and the missing-client retry are two
  // independent lifecycles — sharing one timer slot made the 30s retry wait
  // silently swallow every debounced refresh in between.
  let statsTimer: ReturnType<typeof setTimeout> | undefined
  let statsRetryTimer: ReturnType<typeof setTimeout> | undefined

  let timezone: string | undefined
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {}

  let statsMethodMissingLogged = false

  const statsCall = (): ((input: any) => Promise<any>) | undefined => {
    // v0.6.4 runtime fix: the v2.0.x effect client namespaces stats under
    // `session` (SessionApi.stats, verified against v2.0.21
    // packages/client/src/effect/api/api.ts) — the previous
    // `experimental.session.stats` path does not exist there, which silently
    // killed Σ/hit. Newer hosts may expose it under `experimental.session`
    // (the openapi operationId); try both, whatever is callable.
    const client = context.client as any
    const candidates = [client?.session?.stats, client?.experimental?.session?.stats]
    for (const c of candidates) if (typeof c === "function") return c
    return undefined
  }

  const localMidnight = (): number => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }

  // Window start for a total scope: "today" = local midnight, the rest are
  // rolling windows ending at now.
  const scopeStartMs = (scope: TotalScope): number =>
    scope === "today" ? localMidnight() : Date.now() - ROLLING_WINDOW_MS[scope]

  const unwrap = (res: any): any => res?.data ?? res

  const fetchToday = async (): Promise<void> => {
    if (statsBusy || statsFailed) return
    const call = statsCall()
    if (!call) {
      // v0.6.4: the client may simply not be ready when setup runs; retry on
      // a timer instead of one-shot failing until the next day / restart.
      // v0.7.6: dedicated retry timer — must not block the step-refresh
      // debounce (they previously shared one slot).
      if (!statsMethodMissingLogged) {
        statsMethodMissingLogged = true
        console.error("[usage-meter] session stats client method unavailable (will retry)")
      }
      if (statsRetryTimer === undefined) {
        statsRetryTimer = setTimeout(() => {
          statsRetryTimer = undefined
          void fetchToday()
        }, 30_000)
      }
      return
    }
    statsBusy = true
    try {
      // v0.6.4: pass numbers — v2.0.21 SDK SessionStatsInput.from/to are
      // `number` and the effect client validates input schemas at runtime
      // (the query wire format is handled by the client itself).
      const input: any = { from: localMidnight(), to: Date.now() }
      if (timezone) input.timezone = timezone
      const data = unwrap(await call(input))
      if (data?.tokens) setTodayStats(data)
    } catch (error) {
      console.error("[usage-meter] session stats fetch failed:", error)
    } finally {
      statsBusy = false
    }
  }

  // v0.7.7: fetch one rolling-scope aggregate. Skipped while another fetch
  // is in flight; a missing client method is retried indirectly — fetchToday's
  // retry timer keeps firing and the next 60s tick picks the range up once
  // the client is ready.
  let rangeBusy = false
  const fetchRange = async (scope: TotalScope): Promise<void> => {
    if (scope === "today" || rangeBusy) return
    const call = statsCall()
    if (!call) return
    rangeBusy = true
    try {
      const input: any = { from: scopeStartMs(scope), to: Date.now() }
      if (timezone) input.timezone = timezone
      const data = unwrap(await call(input))
      if (data?.tokens) setRangeStats((previous) => ({ ...previous, [scope]: data }))
    } catch (error) {
      console.error(`[usage-meter] session stats fetch (${scope}) failed:`, error)
    } finally {
      rangeBusy = false
    }
  }

  // The aggregate for whatever scope the UI currently renders.
  const totalFor = (scope: TotalScope): any =>
    scope === "today" ? todayStats() : rangeStats()?.[scope]

  // Refresh everything the UI can show right now: today (always — the hit
  // metric stays daily) plus the active rolling scope.
  const fetchTotals = (): void => {
    void fetchToday()
    const activeScope = totalScopeEnabled()
    if (activeScope !== "today") void fetchRange(activeScope)
  }
  // The debounced refresh also refreshes an open stats panel; tui.tsx binds
  // the callback (panel-name check + ensureDetail) after assembling the
  // panel content, preserving the original guarded call.
  let panelRefresh: (() => void) | undefined
  const bindPanelRefresh = (refresh: () => void): void => {
    panelRefresh = refresh
  }

  // Debounced refresh after each completed step keeps the footer Σ current
  // without hammering the API during multi-step turns. An open stats panel
  // is refreshed too (today + all-time detail).
  const scheduleStatsRefresh = (delayMs = 1500): void => {
    if (statsTimer !== undefined) return
    statsTimer = setTimeout(() => {
      statsTimer = undefined
      // v0.7.7: step ends move the active rolling scope too, not just today.
      fetchTotals()
      try {
        panelRefresh?.()
      } catch {}
    }, delayMs)
  }

  // Midnight rollover for the daily usage stats, invoked from the 500ms
  // tick in tui.tsx (same cadence and reset semantics as the original).
  // Rolling windows are unaffected by the calendar day, but re-fetching
  // keeps them fresh in one place.
  const checkMidnightRollover = (): void => {
    const day = new Date().toDateString()
    if (day !== statsDay) {
      statsDay = day
      statsFailed = false
      fetchTotals()
    }
  }

  const release = (): void => {
    if (statsTimer !== undefined) clearTimeout(statsTimer)
    if (statsRetryTimer !== undefined) clearTimeout(statsRetryTimer)
  }

  return {
    todayStats,
    setTodayStats,
    rangeStats,
    totalFor,
    fetchToday,
    fetchRange,
    fetchTotals,
    scheduleStatsRefresh,
    bindPanelRefresh,
    checkMidnightRollover,
    statsCall,
    localMidnight,
    scopeStartMs,
    unwrap,
    timezone,
    release,
  }
}
