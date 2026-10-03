/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI plugin "usage-meter": usage indicators in the prompt footer status row.
// Shows for the current session: a ticking "waited" timer while a run is active,
// a live output tok/s rate while tokens are streaming, and the finished duration
// (plus average tok/s) of the last turn when idle.
//
// Token sources (current OpenCode emits the session.* event family):
//   session.text.delta / session.reasoning.delta / session.tool.input.delta
//     -> real-time streaming chunks { sessionID, assistantMessageID, ordinal, delta }
//   session.step.ended / session.step.failed -> exact tokens { tokens: { output, ... } }
//   message.part.delta / message.updated kept as legacy fallbacks (guarded).
//
// v0.3.0 — Daily usage stats (server-native aggregation, read-only):
//   footer appends today's total token usage (Σ), "/usage-full" opens a detail view
//   (today per model, 7-day trend, cumulative totals). Queries the server's own
//   GET /api/experimental/session/stats; no local accumulation, storage or RPC.
//   Degrades silently (Σ hidden, panel shows the error) if the API is unavailable.
// v0.4.0 — the detail view becomes a toggleable session.panel sidebar contribution
//   (live per-session timer/tok/s header + detail tables; "f" toggles fullscreen,
//   escape or /usage-full collapses); plain dialog fallback outside a session.
// v0.5.0 — renamed from "elapsed-timer" to "usage-meter"; slash command is
//   /usage-full (old /tokens with aliases removed). Feature set unchanged.
import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal } from "solid-js"

function format(ms: number): string {
  const clamped = Math.max(0, ms)
  // Sub-minute durations get one decimal (matches the native "17.5s" readout).
  if (clamped < 60_000) return `${(clamped / 1000).toFixed(1)}s`
  const total = Math.floor(clamped / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) {
    return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, "0")}s` : `${seconds}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
}

// Rough output-token estimate for a streamed chunk: CJK ≈ 1 token/char,
// everything else ≈ 4 chars/token. Used between exact token readings.
function estimateTokens(text: string): number {
  const cjk =
    text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g)?.length ?? 0
  const other = Math.max(0, text.length - cjk)
  return Math.max(1, Math.round(cjk + other / 4))
}

// Compact token counts: 1_234 -> "1.2k", 12_345_678 -> "12.3M".
function fmtNum(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) {
    const v = n / 1_000_000
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}M`
  }
  if (n >= 1_000) {
    const v = n / 1_000
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)}k`
  }
  return String(Math.round(n))
}

function fmtUSD(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ""
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}

type MsgRate = { est: number; exact?: number; refEst: number }
type RateState = {
  sessionID: string
  msgs: Map<string, MsgRate>
  samples: Array<{ t: number; tok: number }>
  sessionVocab: boolean // saw a session.* delta this turn -> ignore legacy deltas
}

function msgTotal(m: MsgRate): number {
  return m.exact !== undefined ? m.exact + Math.max(0, m.est - m.refEst) : m.est
}

function turnTotal(st: RateState): number {
  let total = 0
  for (const m of st.msgs.values()) total += msgTotal(m)
  return total
}

function pushSample(st: RateState): void {
  const t = Date.now()
  const s = st.samples
  while (s.length > 0 && t - s[0].t > 10_000) s.shift()
  s.push({ t, tok: turnTotal(st) })
}

// Rolling output rate from recent stream samples. Returns undefined when the
// stream is idle (tool run / long gap) or there is not yet a usable window.
function liveRate(st: RateState, now: number): number | undefined {
  const s = st.samples
  if (s.length < 2) return undefined
  const last = s[s.length - 1]
  if (now - last.t > 4000) return undefined
  let base = s[0]
  for (const cand of s) {
    if (last.t - cand.t >= 2500) {
      base = cand
      break
    }
  }
  const dt = (last.t - base.t) / 1000
  if (dt < 0.4) return undefined
  const rate = Math.round((last.tok - base.tok) / dt)
  return rate > 0 ? rate : undefined
}

export default Plugin.define({
  id: "usage-meter",
  setup(context: any) {
    // Ticking clock drives the elapsed recompute while a run is active, and
    // detects the midnight rollover for the daily usage stats.
    const [now, setNow] = createSignal(Date.now())
    let statsDay = new Date().toDateString()
    const timer = setInterval(() => {
      setNow(Date.now())
      const day = new Date().toDateString()
      if (day !== statsDay) {
        statsDay = day
        statsFailed = false
        void fetchToday()
      }
    }, 500)

    // Turn start times and last finished durations, keyed by session ID.
    const starts = new Map<string, number>()
    const lastDurations = new Map<string, number>()
    const lastAvgRates = new Map<string, number>()
    // v0.6.2: exact per-message generation rate (output+reasoning over the
    // message's own created→completed span) — replaces the heuristic idle avg.
    const lastExactRates = new Map<string, number>()
    // v0.6.2: live-estimate calibration factor per session (EMA of exact/est),
    // applied to streaming tok/s so it converges toward native accounting.
    const calibs = new Map<string, number>()
    // v0.6.3: calibration persists per model across sessions/restarts via
    // durable storage, so a new session starts already-calibrated.
    let calibStore: Record<string, number> = {}
    let updateCalibStore: ((fn: (draft: Record<string, number>) => void) => Promise<void>) | undefined
    try {
      const store = (context.storage as any)?.store
      if (typeof store === "function") {
        const [s, u] = store("usage-meter.calib", { initial: {} })
        calibStore = s ?? {}
        updateCalibStore = u
      }
    } catch {}
    // v0.6.6: user-facing footer dimension settings (durable, synced across
    // TUI instances). The user host (2.0.21) has no plugin-options config
    // channel yet, so settings persist here and toggle via /usage-settings.
    let settingsStore: any = {}
    let updateSettingsStore: ((fn: (draft: any) => void) => Promise<void>) | undefined
    try {
      const store = (context.storage as any)?.store
      if (typeof store === "function") {
        const [s, u] = store("usage-meter.settings", {
          initial: {
            hitScope: "today" as "today" | "session",
            // v0.7.0: the footer defaults to waited + tok/s only; the Σ and
            // hit segments are opt-in. The right-sidebar metrics block is on
            // by default. Absent keys fall back to these defaults on read.
            footerSigma: false,
            footerHit: false,
            sidebarMetrics: true,
          },
        })
        settingsStore = s ?? {}
        updateSettingsStore = u
      }
    } catch {}

    // Last-seen model per session ("provider/model"), used to key persisted
    // calibration; falls back to the session record.
    const sessionModels = new Map<string, string>()
    const modelKeyOf = (sessionID: string): string | undefined => {
      const cached = sessionModels.get(sessionID)
      if (cached) return cached
      try {
        const s = context.data?.session?.get?.(sessionID)
        if (s?.model) return `${s.model.providerID}/${s.model.id}`
      } catch {}
      return undefined
    }
    const calibOf = (sessionID: string): number => {
      const live = calibs.get(sessionID)
      if (live !== undefined) return live
      const key = modelKeyOf(sessionID)
      const persisted = key ? calibStore[key] : undefined
      return typeof persisted === "number" && persisted > 0 ? persisted : 1
    }

    // Token-flow tracking per session, active only during a run.
    const rates = new Map<string, RateState>()
    const newRateState = (sessionID: string): RateState =>
      ({ sessionID, msgs: new Map(), samples: [], sessionVocab: false })

    const dataOf = (event: any): any => event?.data ?? event?.properties ?? event

    // v0.6.5: tolerant timestamp coercion — hosts may deliver message times
    // as epoch numbers (openapi) or ISO strings; both must feed the exact-rate
    // math. Returns undefined for anything unusable.
    const tsOf = (v: any): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v
      if (typeof v === "string") {
        const parsed = Date.parse(v)
        if (!Number.isNaN(parsed)) return parsed
      }
      return undefined
    }

    const sessionIDOf = (event: any): string | undefined => {
      // The TUI data bus exposes the payload at `event.data`; accept the raw
      // SDK envelope's `properties` and a flat shape as fallbacks.
      const data = dataOf(event)
      return typeof data?.sessionID === "string" && data.sessionID ? data.sessionID : undefined
    }

    const subs: Array<() => void> = []
    const listen = (type: string, handler: (event: any) => void) => {
      try {
        subs.push(context.data.on(type, handler))
      } catch (error) {
        console.error(`[usage-meter] ${type} subscription failed:`, error)
      }
    }

    const rateStateOf = (sessionID: string): RateState | undefined => {
      if (!starts.has(sessionID)) return undefined // only track during a run
      let st = rates.get(sessionID)
      if (!st) {
        st = newRateState(sessionID)
        rates.set(sessionID, st)
      }
      return st
    }

    // Add estimated tokens from a streaming chunk for a message.
    const addEst = (st: RateState, messageID: string | undefined, delta: string): void => {
      if (!delta) return
      const key = messageID ?? "_anon"
      const m = st.msgs.get(key) ?? { est: 0, refEst: 0 }
      m.est += estimateTokens(delta)
      st.msgs.set(key, m)
      pushSample(st)
    }

    // Adopt an exact cumulative output reading; only trust it when it is at
    // least our running estimate (guards against per-step / partial numbers),
    // or when authoritative (message completed).
    const adoptExact = (
      st: RateState,
      messageID: string | undefined,
      out: number,
      force: boolean,
    ): void => {
      const key = messageID ?? "_anon"
      const m = st.msgs.get(key) ?? { est: 0, refEst: 0 }
      if (force || out > msgTotal(m)) {
        // v0.6.2: learn the estimator's correction ratio (exact/estimated)
        // and fold it into the session calibration factor for live rates.
        // v0.6.3: also persist it per model so new sessions start calibrated.
        const before = msgTotal(m)
        if (out > 0 && before > 20) {
          const prev = calibs.get(st.sessionID) ?? calibOf(st.sessionID)
          const next = Math.min(4, Math.max(0.25, prev * 0.7 + (out / before) * 0.3))
          calibs.set(st.sessionID, next)
          const modelKey = modelKeyOf(st.sessionID)
          if (modelKey && updateCalibStore) {
            try {
              void updateCalibStore((draft: Record<string, number>) => {
                draft[modelKey] = next
              })
            } catch {}
          }
        }
        m.exact = out
        m.refEst = m.est
        st.msgs.set(key, m)
      }
      pushSample(st)
    }

    // --- Daily usage stats (server-native SessionStats aggregation) -------
    // Read-only queries against GET /api/experimental/session/stats.
    // The server aggregates every session (TUI, headless, subagents); the
    // plugin only renders. `from`/`to` are epoch milliseconds (SDK `number`).
    const [todayStats, setTodayStats] = createSignal<any>(undefined)
    let statsFailed = false // reserved: hard-fail gate (reset at day rollover); missing client method now retries on a timer
    let statsBusy = false
    let statsTimer: ReturnType<typeof setTimeout> | undefined

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
        if (!statsMethodMissingLogged) {
          statsMethodMissingLogged = true
          console.error("[usage-meter] session stats client method unavailable (will retry)")
        }
        if (statsTimer === undefined) {
          statsTimer = setTimeout(() => {
            statsTimer = undefined
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

    // Debounced refresh after each completed step keeps the footer Σ current
    // without hammering the API during multi-step turns. An open stats panel
    // is refreshed too (today + all-time detail).
    const scheduleStatsRefresh = (delayMs = 1500): void => {
      if (statsTimer !== undefined) return
      statsTimer = setTimeout(() => {
        statsTimer = undefined
        void fetchToday()
        try {
          const current = (context.ui as any)?.panel?.current?.()
          if (current === PANEL_NAME || current?.name === PANEL_NAME) void ensureDetail()
        } catch {}
      }, delayMs)
    }

    // --- /usage-full stats view: sidebar panel (in-session) + dialog fallback ---
    const [detail, setDetail] = createSignal<any>(undefined)
    const PANEL_NAME = "usage-meter.stats"

    // --- Current-session context window + cumulative usage (v0.6.0) ---
    // Window occupancy mirrors the native sidebar Context panel: the last
    // assistant message with output tokens, summed as
    // input + output + reasoning + cache.read + cache.write, over the model's
    // context limit. Everything reads already-synced TUI state — no server call.
    const EMPTY_TOKENS: any = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    const CTX_WARN_PCT = 80

    const sumTokens = (t: any): number =>
      (t?.input ?? 0) + (t?.output ?? 0) + (t?.reasoning ?? 0)
      + (t?.cache?.read ?? 0) + (t?.cache?.write ?? 0)

    const ctxModelLimit = (message: any): number | undefined => {
      try {
        const models = context.data?.location?.model?.list?.(context.location) ?? []
        const m = models.find((c: any) =>
          c?.providerID === message?.model?.providerID &&
          (c?.modelID === message?.model?.id || c?.id === message?.model?.id))
        const limit = m?.limit?.context
        return typeof limit === "number" && limit > 0 ? limit : undefined
      } catch {
        return undefined
      }
    }

    // Last assistant message that reported output tokens (the window snapshot).
    const lastAssistant = (sessionID: string): any | undefined => {
      try {
        const messages = context.data?.session?.message?.list?.(sessionID) ?? []
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m?.type === "assistant" && (m?.tokens?.output ?? 0) > 0) return m
        }
      } catch {}
      return undefined
    }

    // Window occupancy: percent + warning flag (>= 80%).
    // v0.6.4: retained implementation — no longer rendered in the footer
    // (moved out as redundant next to tok/s); reserved for a future surface
    // and documents the formula the panel's 当前窗口 block mirrors.
    const ctxPercent = (sessionID: string): { pct: number; warn: boolean } | undefined => {
      const m = lastAssistant(sessionID)
      if (!m) return undefined
      const limit = ctxModelLimit(m)
      if (!limit) return undefined
      const tokens = sumTokens(m.tokens)
      const pct = Math.round((tokens / limit) * 100)
      return { pct, warn: pct >= CTX_WARN_PCT }
    }

    // Delegation tree under this session (task subagents run in child
    // sessions that can have their own children). Best-effort, capped at 200.
    const descendantSessions = (rootID: string): any[] => {
      try {
        const all = context.data?.session?.list?.() ?? []
        const found: any[] = []
        const seen = new Set<string>([rootID])
        const queue: string[] = [rootID]
        while (queue.length > 0 && found.length < 200) {
          const parentID = queue.shift()!
          for (const s of all) {
            if (s?.parentID !== parentID || seen.has(s.id)) continue
            seen.add(s.id)
            found.push(s)
            queue.push(s.id)
          }
        }
        return found
      } catch {
        return []
      }
    }

    // Panel block: current window snapshot + authoritative session cumulative
    // (session.tokens survives the TUI's partial message window) + subagents.
    // Session hit rate uses the stricter read / (input + read + write) formula,
    // matching the native panel; the footer's daily hit keeps its own formula.
    const syncedChildren = new Set<string>() // child sessions already refreshed
    const sessionUsageLines = (sessionID: string): string[] => {
      const lines: string[] = []
      try {
        const m = lastAssistant(sessionID)
        if (m) {
          const t = m.tokens ?? EMPTY_TOKENS
          const limit = ctxModelLimit(m)
          lines.push("── 当前窗口(最后一次请求) ──")
          lines.push(`  in ${fmtNum(t.input ?? 0)}  out ${fmtNum(t.output ?? 0)}  reasoning ${fmtNum(t.reasoning ?? 0)}`)
          lines.push(`  cache R ${fmtNum(t.cache?.read ?? 0)}  W ${fmtNum(t.cache?.write ?? 0)}`)
          if (limit) {
            const pct = Math.round((sumTokens(t) / limit) * 100)
            lines.push(`  占用 ${fmtNum(sumTokens(t))} / ${fmtNum(limit)} (${pct}%)${pct >= CTX_WARN_PCT ? "  ▲ 接近压缩阈值" : ""}`)
          } else {
            lines.push(`  占用 ${fmtNum(sumTokens(t))}(模型窗口上限未知)`)
          }
          lines.push("")
        }
        const session = context.data?.session?.get?.(sessionID)
        const agg = session?.tokens
        if (agg && sumTokens(agg) > 0) {
          let turns = 0
          let msgTokens = 0
          try {
            const messages = context.data?.session?.message?.list?.(sessionID) ?? []
            const asst = messages.filter((x: any) => x?.type === "assistant")
            turns = asst.length
            for (const a of asst) msgTokens += sumTokens(a?.tokens)
          } catch {}
          // v0.6.3: the TUI keeps only a window of recent messages on long
          // sessions; when the authoritative aggregate exceeds the visible
          // sum the turn count is a floor -> mark it with "+".
          const partial = sumTokens(agg) > msgTokens + 10
          const input = agg.input ?? 0
          const output = agg.output ?? 0
          const reasoning = agg.reasoning ?? 0
          const read = agg.cache?.read ?? 0
          const write = agg.cache?.write ?? 0
          const prompt = input + read + write
          const hit = prompt > 0 ? Math.round((read / prompt) * 100) : undefined
          const cost = fmtUSD(session?.cost ?? 0)
          lines.push("── 本会话累计 ──")
          lines.push(`  ${turns}${partial ? "+" : ""} 轮 · in ${fmtNum(input)}  out ${fmtNum(output)}  reasoning ${fmtNum(reasoning)}`)
          lines.push(`  cache R ${fmtNum(read)}  W ${fmtNum(write)} · 过流 ${fmtNum(sumTokens(agg))}${hit !== undefined ? `  命中 ${hit}%` : ""}${cost ? ` · ${cost}` : ""}`)
          const children = descendantSessions(sessionID)
          // v0.6.3: background child sessions may not be synced by the host
          // until viewed; refresh each one once (async, best-effort) so the
          // block stops hiding or showing stale numbers. The next 500ms tick
          // picks the synced values up.
          for (const c of children) {
            if (!c?.id || syncedChildren.has(c.id)) continue
            syncedChildren.add(c.id)
            try {
              void context.data?.session?.sync?.(c.id)
            } catch {}
          }
          if (children.length > 0) {
            let ci = 0, co = 0, cr = 0, cc = 0, cw = 0, ccost = 0
            let anyTok = false
            for (const c of children) {
              const ct = c?.tokens
              if (!ct) continue
              if (sumTokens(ct) > 0) anyTok = true
              ci += ct.input ?? 0; co += ct.output ?? 0; cr += ct.reasoning ?? 0
              cc += ct.cache?.read ?? 0; cw += ct.cache?.write ?? 0
              ccost += c?.cost ?? 0
            }
            // Hide the block while no child has reported any usage yet.
            if (anyTok) {
              const cp = ci + cc + cw
              const chit = cp > 0 ? Math.round((cc / cp) * 100) : undefined
              const cCost = fmtUSD(ccost)
              lines.push("")
              lines.push(`── 子代理(${children.length} 个会话) ──`)
              lines.push(`  in ${fmtNum(ci)}  out ${fmtNum(co)}  reasoning ${fmtNum(cr)}`)
              lines.push(`  cache R ${fmtNum(cc)}  W ${fmtNum(cw)} · 过流 ${fmtNum(ci + co + cr + cc + cw)}${chit !== undefined ? `  命中 ${chit}%` : ""}${cCost ? ` · ${cCost}` : ""}`)
              lines.push("")
              const sCost = fmtUSD((session?.cost ?? 0) + ccost)
              lines.push(`  会话+子代理合计:过流 ${fmtNum(sumTokens(agg) + ci + co + cr + cc + cw)}${sCost ? ` · ${sCost}` : ""}`)
            }
          }
          lines.push("")
        }
      } catch {}
      return lines
    }

    // Live per-session readout (timer / tok/s / today Σ) for the panel header.
    const sessionLines = (sessionID: string | undefined): string[] => {
      if (!sessionID) return []
      const lines: string[] = ["── 当前会话 ──"]
      const running = context.data?.session?.status?.(sessionID) === "running"
      const started = starts.get(sessionID)
      const last = lastDurations.get(sessionID)
      const currentTime = now()
      if (running && started !== undefined) {
        let line = `  ⏱ waited ${format(currentTime - started)}`
        const rate = rates.get(sessionID)
        const tps = rate ? liveRate(rate, currentTime) : undefined
        if (tps !== undefined) line += `   ⚡ ${Math.round(tps * calibOf(sessionID))} tok/s`
        lines.push(line)
      } else if (running) {
        lines.push("  ⏱ running")
      } else if (last !== undefined) {
        let line = `  ✓ last ${format(last)}`
        const exact = lastExactRates.get(sessionID)
        if (exact !== undefined) {
          line += `   ⚡ ${exact} tok/s`
        } else {
          const avg = lastAvgRates.get(sessionID)
          if (avg !== undefined) line += `   ⚡ ${avg} tok/s avg`
        }
        lines.push(line)
      } else {
        lines.push("  (空闲)")
      }
      const ts = todayStats()
      if (ts) {
        const tk = ts?.tokens
        const total = (tk?.input ?? 0) + (tk?.output ?? 0) + (tk?.reasoning ?? 0)
        if (total > 0) lines.push(`  Σ 今日 ${fmtNum(total)}`)
      }
      lines.push(...sessionUsageLines(sessionID))
      lines.push("")
      return lines
    }

    const detailLines = (st: any): string[] => {
      const today = st?.today as any
      const all = st?.all as any
      const lines: string[] = []

      // Cache hit rate: share of the model's input context served from cache.
      // Undefined when there is no input context at all (nothing to rate).
      const cacheHit = (tk: any): number | undefined => {
        const read = tk?.cache?.read ?? 0
        const input = tk?.input ?? 0
        const denom = read + input
        return denom > 0 ? Math.round((read / denom) * 100) : undefined
      }

      const modelRow = (u: any): string => {
        const name = `${u.model?.providerID ?? "?"}/${u.model?.id ?? "?"}`.slice(0, 36)
        const cost = fmtUSD(u.cost ?? 0)
        return (
          `  ${name.padEnd(36)} ${String(u.steps ?? 0).padStart(5)}步` +
          `  in ${fmtNum(u.tokens?.input ?? 0).padStart(6)}` +
          `  out ${fmtNum(u.tokens?.output ?? 0).padStart(6)}` +
          `${cost ? `  ${cost}` : ""}`
        )
      }

      lines.push("── 今日 ──")
      const models: any[] = Array.isArray(today?.models) ? [...today.models] : []
      models.sort((a, b) => (b.tokens?.output ?? 0) - (a.tokens?.output ?? 0))
      for (const u of models.slice(0, 12)) lines.push(modelRow(u))
      if (models.length > 12) lines.push(`  …另有 ${models.length - 12} 个模型`)
      const tk = today?.tokens ?? {}
      const todayCost = fmtUSD(today?.cost ?? 0)
      const todayHit = cacheHit(tk)
      lines.push(
        `  合计 ${String(today?.steps ?? 0)}步 · ` +
          `in ${fmtNum(tk.input ?? 0)}  out ${fmtNum(tk.output ?? 0)}  ` +
          `reasoning ${fmtNum(tk.reasoning ?? 0)} · ` +
          `cache R ${fmtNum(tk.cache?.read ?? 0)}  W ${fmtNum(tk.cache?.write ?? 0)}` +
          `${todayHit !== undefined ? `  命中 ${todayHit}%` : ""}` +
          `${todayCost ? ` · ${todayCost}` : ""}`,
      )

      lines.push("")
      lines.push("── 近 7 日(steps) ──")
      const activity: any[] = Array.isArray(all?.activity) ? all.activity : []
      const week = activity.slice(-7)
      const maxSteps = Math.max(1, ...week.map((a) => a?.steps ?? 0))
      for (const a of week) {
        const steps = a?.steps ?? 0
        const bar = "█".repeat(Math.max(1, Math.round((steps / maxSteps) * 18)))
        lines.push(`  ${String(a?.date ?? "").padEnd(12)} ${bar.padEnd(20)} ${String(steps)}`)
      }
      if (week.length === 0) lines.push("  (暂无数据)")

      lines.push("")
      lines.push("── 累计 ──")
      const atk = all?.tokens ?? {}
      const allHit = cacheHit(atk)
      lines.push(
        `  tokens  in ${fmtNum(atk.input ?? 0)}  out ${fmtNum(atk.output ?? 0)}  ` +
          `reasoning ${fmtNum(atk.reasoning ?? 0)}`,
      )
      lines.push(
        `  cache  R ${fmtNum(atk.cache?.read ?? 0)}  W ${fmtNum(atk.cache?.write ?? 0)}` +
          `${allHit !== undefined ? `  命中 ${allHit}%` : ""}`,
      )
      const allCost = fmtUSD(all?.cost ?? 0)
      lines.push(
        `  ${String(all?.steps ?? 0)}步 · ${String(all?.sessions ?? 0)}会话 · ` +
          `活跃 ${String(all?.activeDays ?? 0)}天 · 连续 ${String(all?.streak ?? 0)}天` +
          `${allCost ? ` · ${allCost}` : ""}`,
      )

      const top: any[] = Array.isArray(all?.models) ? [...all.models] : []
      top.sort((a, b) => (b.tokens?.output ?? 0) - (a.tokens?.output ?? 0))
      const topModels = top.filter((u) => (u.tokens?.output ?? 0) > 0).slice(0, 5)
      if (topModels.length > 0) {
        lines.push("")
        lines.push("── 累计 Top 模型(按输出) ──")
        for (const u of topModels) lines.push(modelRow(u))
      }

      return lines
    }

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

    // Fetch today + all-time detail once per open/refresh (two API calls).
    const ensureDetail = async (): Promise<void> => {
      const call = statsCall()
      if (!call) {
        setDetail({ error: "stats client method unavailable(OpenCode 版本过旧?)" })
        return
      }
      try {
        const baseInput: any = timezone ? { timezone } : {}
        const [todayRes, allRes] = await Promise.all([
          // v0.6.4: numbers, not strings — the SDK input schema is `number`.
          call({ ...baseInput, from: localMidnight(), to: Date.now() }),
          call(baseInput),
        ])
        const today = unwrap(todayRes)
        const all = unwrap(allRes)
        if (!today?.tokens || !all?.tokens) throw new Error("空响应")
        setTodayStats(today) // keep the footer Σ in sync too
        setDetail({ today, all })
      } catch (error: any) {
        setDetail({ error: String(error?.message ?? error) })
      }
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

    // v0.6.7: /usage-settings — extensible settings dialog (currently one
    // item: the footer hit dimension). Reactive reads from the settings
    // store mean the body re-renders the moment a value changes.
    // Normalized settings readers: persisted stores from older versions lack
    // the newer keys, so each reader applies the documented default itself.
    const hitScopeEnabled = (): "today" | "session" =>
      settingsStore?.hitScope === "session" ? "session" : "today"
    const footerSigmaEnabled = (): boolean => settingsStore?.footerSigma === true
    const footerHitEnabled = (): boolean => settingsStore?.footerHit === true
    const sidebarMetricsEnabled = (): boolean => settingsStore?.sidebarMetrics !== false
    const toggleSettingsFlag = (flagKey: string, currentValue: boolean): void => {
      try {
        void updateSettingsStore?.((draft: any) => {
          draft[flagKey] = !currentValue
        })
      } catch {}
    }

    const toggleHitScope = (): void => {
      try {
        const nextHitScope = hitScopeEnabled() === "session" ? "today" : "session"
        void updateSettingsStore?.((draft: any) => {
          draft.hitScope = nextHitScope
        })
      } catch {}
    }
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
      const lines = [
        "用量设置",
        "──────────────────────────────",
        `hit 维度:${hitScopeLabel}`,
        `footer Σ 段:${onOff(footerSigmaEnabled())}`,
        `footer hit 段:${onOff(footerHitEnabled())}`,
        `右栏指标块:${onOff(sidebarMetricsEnabled())}`,
        "",
        "d hit 维度 · f footer Σ · h footer hit · b 右栏块 · Esc 关闭",
        "(footer 默认只显示 ⏱ 与 ⚡,其余段按需开启;选择自动持久化)",
      ]
      return <text fg={(context.theme as any)?.text?.base}>{lines.join("\n")}</text>
    }

    // v0.7.0: right-sidebar metrics block. The right column (session title +
    // Context + MCP + agents sections) is the host's sidebar and exposes the
    // `sidebar.content` slot — the same channel the native Context/MCP
    // feature-plugins claim. Our block lands below them and mirrors the
    // footer's live session readout plus today's Σ and the hit metric whose
    // dimension follows the /usage-settings hitScope.
    const SidebarMetrics = (props: { sessionID: string }) => {
      if (!sidebarMetricsEnabled()) return null
      const sessionID = props.sessionID
      const running = context.data?.session?.status?.(sessionID) === "running"
      const started = starts.get(sessionID)
      const last = lastDurations.get(sessionID)
      const currentTime = now()
      const metricLines: string[] = []
      if (running && started !== undefined) {
        const rate = rates.get(sessionID)
        const liveTokPerSec = rate ? liveRate(rate, currentTime) : undefined
        metricLines.push(
          `⏱ ${format(currentTime - started)}` +
            `${liveTokPerSec !== undefined ? `   ⚡ ${Math.round(liveTokPerSec * calibOf(sessionID))} tok/s` : ""}`,
        )
      } else if (running) {
        metricLines.push("⏱ running")
      } else if (last !== undefined) {
        const exact = lastExactRates.get(sessionID)
        const avgRate = lastAvgRates.get(sessionID)
        const rateText =
          exact !== undefined
            ? `${exact} tok/s`
            : avgRate !== undefined
              ? `${avgRate} tok/s avg`
              : undefined
        metricLines.push(`✓ last ${format(last)}${rateText ? `   ⚡ ${rateText}` : ""}`)
      }
      const stats = todayStats()
      const hitScope = hitScopeEnabled()
      if (stats) {
        const todayTokens = stats?.tokens
        const total =
          (todayTokens?.input ?? 0) + (todayTokens?.output ?? 0) + (todayTokens?.reasoning ?? 0)
        if (total > 0) metricLines.push(`Σ 今日 ${fmtNum(total)}`)
      }
      if (hitScope === "session") {
        try {
          const sessionTokens = context.data?.session?.get?.(sessionID)?.tokens
          const cacheRead = sessionTokens?.cache?.read ?? 0
          const denominator =
            (sessionTokens?.input ?? 0) + cacheRead + (sessionTokens?.cache?.write ?? 0)
          if (denominator > 0)
            metricLines.push(`hit·s ${((cacheRead / denominator) * 100).toFixed(1)}%(本会话)`)
        } catch {}
      } else if (stats) {
        const cacheRead = stats?.tokens?.cache?.read ?? 0
        const denominator = cacheRead + (stats?.tokens?.input ?? 0)
        if (denominator > 0)
          metricLines.push(`hit ${((cacheRead / denominator) * 100).toFixed(1)}%(今日)`)
      }
      if (metricLines.length === 0) return null
      const muted = context.theme?.text?.muted
      return (
        <box flexDirection="column">
          <text fg={(context.theme as any)?.text?.base}>用量</text>
          <text fg={muted}>{metricLines.join("\n")}</text>
        </box>
      )
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
                      toggleHitScope()
                      try {
                        const next = settingsStore?.hitScope
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

    // --- Session lifecycle events ------------------------------------------
    listen("session.execution.started", (event: any) => {
      const sessionID = sessionIDOf(event)
      if (!sessionID) return
      starts.set(sessionID, Date.now())
      rates.set(sessionID, newRateState(sessionID))
    })
    listen("session.step.started", (event: any) => {
      // Recovery if the execution.started event was missed (e.g. TUI opened mid-run).
      const sessionID = sessionIDOf(event)
      const data = dataOf(event)
      const started = data?.started
      if (sessionID && typeof started === "number" && !starts.has(sessionID)) {
        starts.set(sessionID, started)
        rates.set(sessionID, newRateState(sessionID))
      }
    })
    // v0.6.5: exact idle rate from authoritative message records — sum
    // (output+reasoning) over the turn's assistant messages ÷ sum of their
    // created→completed spans. Same basis as the native turn stats; replaces
    // sole dependence on the message.updated event (real-machine reports
    // show that channel is unreliable, which made the footer fall back to
    // the whole-wall-clock "avg" and under-report tok/s).
    const exactRateFromRecords = (sessionID: string, startedMs: number): void => {
      try {
        const messages = context.data?.session?.message?.list?.(sessionID) ?? []
        let toks = 0
        let genMs = 0
        for (const m of messages) {
          if (m?.type !== "assistant") continue
          const created = tsOf(m?.time?.created)
          const completed = tsOf(m?.time?.completed)
          const out = (m?.tokens?.output ?? 0) + (m?.tokens?.reasoning ?? 0)
          if (created === undefined || completed === undefined || out <= 0) continue
          if (created < startedMs - 2_000) continue // message from a previous turn
          toks += out
          genMs += Math.max(0, completed - created)
        }
        if (toks > 0 && genMs >= 500) {
          lastExactRates.set(sessionID, Math.round(toks / (genMs / 1000)))
        }
      } catch {}
    }

    const finishTurn = (event: any) => {
      const sessionID = sessionIDOf(event)
      if (!sessionID) return
      const started = starts.get(sessionID)
      if (started !== undefined) {
        const elapsed = Date.now() - started
        lastDurations.set(sessionID, elapsed)
        const st = rates.get(sessionID)
        const total = st ? turnTotal(st) : 0
        if (total > 0 && elapsed > 0) {
          lastAvgRates.set(sessionID, Math.round(total / (elapsed / 1000)))
        }
        exactRateFromRecords(sessionID, started)
        // The message record may not be synced yet when execution.succeeded
        // fires; one delayed recompute catches it (idempotent).
        setTimeout(() => {
          try {
            exactRateFromRecords(sessionID, started)
          } catch {}
        }, 1_500)
      }
      starts.delete(sessionID)
      rates.delete(sessionID)
      scheduleStatsRefresh()
    }
    listen("session.execution.succeeded", finishTurn)
    listen("session.execution.failed", finishTurn)
    listen("session.execution.interrupted", finishTurn)

    // --- Live streaming chunks (current V2 event family) ---
    const sessionDelta = (event: any) => {
      const data = dataOf(event)
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
      const delta = typeof data?.delta === "string" ? data.delta : undefined
      if (!sessionID || !delta) return
      const st = rateStateOf(sessionID)
      if (!st) return
      st.sessionVocab = true
      addEst(st, data.assistantMessageID ?? data.messageID, delta)
    }
    listen("session.text.delta", sessionDelta)
    listen("session.reasoning.delta", sessionDelta)
    listen("session.tool.input.delta", sessionDelta)

    // --- Exact cumulative tokens when a step completes ---
    const stepEnded = (event: any) => {
      const data = dataOf(event)
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
      const out = data?.tokens?.output
      if (sessionID && typeof out === "number" && out > 0) {
        const st = rateStateOf(sessionID)
        if (st) {
          st.sessionVocab = true
          adoptExact(st, data.assistantMessageID ?? data.messageID, out, false)
        }
      }
      // Exact per-step usage means the server-side daily aggregate moved too.
      scheduleStatsRefresh()
    }
    listen("session.step.ended", stepEnded)
    listen("session.step.failed", stepEnded)

    // --- Legacy event family fallbacks ---
    // message.part.delta: only counted when no session.* delta was seen this
    // turn, so the same chunk is never counted twice.
    listen("message.part.delta", (event: any) => {
      const data = dataOf(event)
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
      const delta = typeof data?.delta === "string" ? data.delta : undefined
      if (!sessionID || !delta) return
      const st = rateStateOf(sessionID)
      if (!st || st.sessionVocab) return
      addEst(st, data.assistantMessageID ?? data.messageID, delta)
    })
    listen("message.updated", (event: any) => {
      const data = dataOf(event)
      const info = data?.info
      if (info?.role !== "assistant" || typeof info?.tokens?.output !== "number") return
      const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
      if (!sessionID) return
      // v0.6.3: remember the session's model to key persisted calibration.
      if (info.model) sessionModels.set(sessionID, `${info.model.providerID}/${info.model.id}`)
      // v0.6.2: exact generation rate once the message completes —
      // (output + reasoning) / (completed - created), the same basis the
      // native per-message statistics use. v0.6.5: tolerant timestamp
      // coercion; the authoritative recompute at turn end (finishTurn)
      // no longer depends on this event firing.
      const t = info.time
      const created = tsOf(t?.created)
      const completed = tsOf(t?.completed)
      if (created !== undefined && completed !== undefined) {
        const dur = (completed - created) / 1000
        const toks = (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0)
        if (dur >= 0.5 && toks > 0) lastExactRates.set(sessionID, Math.round(toks / dur))
      }
      const st = rateStateOf(sessionID)
      if (!st) return
      const out = info.tokens.output
      if (out > 0) adoptExact(st, info.id, out, info.time?.completed !== undefined)
    })

    // Initial daily-usage load for the footer Σ.
    void fetchToday()
    // v0.6.8: periodic refresh (60s) — background sessions (subagents,
    // headless runs) consume usage without firing this session's turn
    // events, so the daily footer stats could lag indefinitely while idle.
    const statsInterval = setInterval(() => void fetchToday(), 60_000)

    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render: (props: any) => {
        const sessionID: string | undefined = props?.sessionID
          ?? context.ui?.router?.current?.()?.params?.sessionID
        if (!sessionID) return null

        const running = context.data?.session?.status?.(sessionID) === "running"
        const started = starts.get(sessionID)
        const last = lastDurations.get(sessionID)
        const currentTime = now()

        const parts: string[] = []
        if (running && started !== undefined) {
          parts.push(`⏱ waited ${format(currentTime - started)}`)
          const rate = rates.get(sessionID)
          const tps = rate ? liveRate(rate, currentTime) : undefined
          if (tps !== undefined) parts.push(`⚡ ${Math.round(tps * calibOf(sessionID))} tok/s`)
        } else if (running) {
          parts.push(`⏱ running`)
        } else if (last !== undefined) {
          parts.push(`✓ last ${format(last)}`)
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
        // block). ctxPercent() stays implemented above for a future surface.
        if (parts.length === 0) return null
        const muted = context.theme?.text?.muted
        return <text fg={muted}>{parts.join("   ")}</text>
      },
    })

    return () => {
      clearInterval(timer)
      clearInterval(statsInterval)
      if (statsTimer !== undefined) clearTimeout(statsTimer)
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
    }
  },
})
