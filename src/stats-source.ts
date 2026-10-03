// --- Daily usage stats (server-native SessionStats aggregation) -------
// Read-only queries against GET /api/experimental/session/stats.
// The server aggregates every session (TUI, headless, subagents); the
// plugin only renders. `from`/`to` are epoch milliseconds (SDK `number`).
// Split from tui.tsx in v0.7.x — behavior unchanged.
import { createSignal } from "solid-js"

export type StatsSourceApi = {
  todayStats: () => any
  setTodayStats: (value: any) => void
  fetchToday: () => Promise<void>
  scheduleStatsRefresh: (delayMs?: number) => void
  bindPanelRefresh: (refresh: () => void) => void
  checkMidnightRollover: () => void
  statsCall: () => ((input: any) => Promise<any>) | undefined
  localMidnight: () => number
  unwrap: (res: any) => any
  timezone: string | undefined
  release: () => void
}

export function createStatsSource(context: any): StatsSourceApi {
  const [todayStats, setTodayStats] = createSignal<any>(undefined)
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
      void fetchToday()
      try {
        panelRefresh?.()
      } catch {}
    }, delayMs)
  }

  // Midnight rollover for the daily usage stats, invoked from the 500ms
  // tick in tui.tsx (same cadence and reset semantics as the original).
  const checkMidnightRollover = (): void => {
    const day = new Date().toDateString()
    if (day !== statsDay) {
      statsDay = day
      statsFailed = false
      void fetchToday()
    }
  }

  const release = (): void => {
    if (statsTimer !== undefined) clearTimeout(statsTimer)
    if (statsRetryTimer !== undefined) clearTimeout(statsRetryTimer)
  }

  return {
    todayStats,
    setTodayStats,
    fetchToday,
    scheduleStatsRefresh,
    bindPanelRefresh,
    checkMidnightRollover,
    statsCall,
    localMidnight,
    unwrap,
    timezone,
    release,
  }
}
