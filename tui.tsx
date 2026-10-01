/** @jsxImportSource @opentui/solid */
// OpenCode V2 TUI plugin: live elapsed-time indicator in the prompt footer status row.
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
//   footer appends today's total token usage (Σ), "/tokens" opens a detail dialog
//   (today per model, 7-day trend, cumulative totals). Queries the server's own
//   GET /api/experimental/session/stats; no local accumulation, storage or RPC.
//   Degrades silently (Σ hidden, dialog shows the error) if the API is unavailable.
import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"

function format(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
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
  id: "elapsed-timer",
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

    // Token-flow tracking per session, active only during a run.
    const rates = new Map<string, RateState>()
    const newRateState = (): RateState => ({ msgs: new Map(), samples: [], sessionVocab: false })

    const dataOf = (event: any): any => event?.data ?? event?.properties ?? event

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
        console.error(`[elapsed-timer] ${type} subscription failed:`, error)
      }
    }

    const rateStateOf = (sessionID: string): RateState | undefined => {
      if (!starts.has(sessionID)) return undefined // only track during a run
      let st = rates.get(sessionID)
      if (!st) {
        st = newRateState()
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
        m.exact = out
        m.refEst = m.est
        st.msgs.set(key, m)
      }
      pushSample(st)
    }

    // --- Daily usage stats (server-native SessionStats aggregation) -------
    // Read-only queries against GET /api/experimental/session/stats.
    // The server aggregates every session (TUI, headless, subagents); the
    // plugin only renders. `from`/`to` are epoch-millisecond strings.
    const [todayStats, setTodayStats] = createSignal<any>(undefined)
    const [dialogStats, setDialogStats] = createSignal<any>(undefined)
    let statsFailed = false // one-shot: stop retrying until next day / restart
    let statsBusy = false
    let statsTimer: ReturnType<typeof setTimeout> | undefined

    let timezone: string | undefined
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {}

    const statsCall = (): ((input: any) => Promise<any>) | undefined => {
      const call = (context.client as any)?.experimental?.session?.stats
      return typeof call === "function" ? call : undefined
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
        statsFailed = true
        console.error("[elapsed-timer] session stats client method unavailable")
        return
      }
      statsBusy = true
      try {
        const input: any = { from: String(localMidnight()), to: String(Date.now()) }
        if (timezone) input.timezone = timezone
        const data = unwrap(await call(input))
        if (data?.tokens) setTodayStats(data)
      } catch (error) {
        console.error("[elapsed-timer] session stats fetch failed:", error)
      } finally {
        statsBusy = false
      }
    }

    // Debounced refresh after each completed step keeps the footer Σ current
    // without hammering the API during multi-step turns.
    const scheduleStatsRefresh = (delayMs = 1500): void => {
      if (statsTimer !== undefined) return
      statsTimer = setTimeout(() => {
        statsTimer = undefined
        void fetchToday()
      }, delayMs)
    }

    // --- /tokens detail dialog ---------------------------------------------
    const TokensDialog = () => {
      const st = dialogStats()
      const base = (context.theme as any)?.text?.base
      const muted = (context.theme as any)?.text?.muted
      if (!st) return <text fg={muted}>Token 统计加载中…</text>
      if (st.error) return <text fg={muted}>统计加载失败:{st.error}</text>

      const today = st.today as any
      const all = st.all as any
      const lines: string[] = []

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
      lines.push(
        `  合计 ${String(today?.steps ?? 0)}步 · ` +
          `in ${fmtNum(tk.input ?? 0)}  out ${fmtNum(tk.output ?? 0)}  ` +
          `reasoning ${fmtNum(tk.reasoning ?? 0)} · ` +
          `cache R ${fmtNum(tk.cache?.read ?? 0)}  W ${fmtNum(tk.cache?.write ?? 0)}` +
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
      lines.push(
        `  tokens  in ${fmtNum(atk.input ?? 0)}  out ${fmtNum(atk.output ?? 0)}  ` +
          `reasoning ${fmtNum(atk.reasoning ?? 0)}`,
      )
      lines.push(
        `  cache  R ${fmtNum(atk.cache?.read ?? 0)}  W ${fmtNum(atk.cache?.write ?? 0)}`,
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

      return <text fg={base}>{lines.join("\n")}</text>
    }

    const openTokensDialog = async (): Promise<void> => {
      try {
        context.ui.dialog.set({ size: "large", centered: true })
      } catch {}
      setDialogStats(undefined)
      context.ui.dialog.show(() => <TokensDialog />, () => {})
      const call = statsCall()
      if (!call) {
        setDialogStats({ error: "stats client method unavailable(OpenCode 版本过旧?)" })
        return
      }
      try {
        const baseInput: any = timezone ? { timezone } : {}
        const [todayRes, allRes] = await Promise.all([
          call({ ...baseInput, from: String(localMidnight()), to: String(Date.now()) }),
          call(baseInput),
        ])
        const today = unwrap(todayRes)
        const all = unwrap(allRes)
        if (!today?.tokens || !all?.tokens) throw new Error("空响应")
        setTodayStats(today) // keep the footer Σ in sync too
        setDialogStats({ today, all })
      } catch (error: any) {
        setDialogStats({ error: String(error?.message ?? error) })
      }
    }

    // /tokens (aliases /tok, /usage) + palette command "Token 消耗统计".
    let layerDispose: any
    try {
      layerDispose = (context.keymap as any)?.layer?.(() => ({
        mode: "global",
        commands: [
          {
            id: "elapsed-timer.tokens",
            title: "Token 消耗统计",
            group: "elapsed-timer",
            palette: true,
            slash: { name: "tokens", aliases: ["tok", "usage"] },
            run: () => {
              void openTokensDialog()
            },
          },
        ],
      }))
    } catch (error) {
      console.error("[elapsed-timer] keymap layer failed:", error)
    }

    // --- Session lifecycle events ------------------------------------------
    listen("session.execution.started", (event: any) => {
      const sessionID = sessionIDOf(event)
      if (!sessionID) return
      starts.set(sessionID, Date.now())
      rates.set(sessionID, newRateState())
    })
    listen("session.step.started", (event: any) => {
      // Recovery if the execution.started event was missed (e.g. TUI opened mid-run).
      const sessionID = sessionIDOf(event)
      const data = dataOf(event)
      const started = data?.started
      if (sessionID && typeof started === "number" && !starts.has(sessionID)) {
        starts.set(sessionID, started)
        rates.set(sessionID, newRateState())
      }
    })
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
      const st = rateStateOf(sessionID)
      if (!st) return
      const out = info.tokens.output
      if (out > 0) adoptExact(st, info.id, out, info.time?.completed !== undefined)
    })

    // Initial daily-usage load for the footer Σ.
    void fetchToday()

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
          if (tps !== undefined) parts.push(`⚡ ${tps} tok/s`)
        } else if (running) {
          parts.push(`⏱ running`)
        } else if (last !== undefined) {
          parts.push(`✓ last ${format(last)}`)
          const avg = lastAvgRates.get(sessionID)
          if (avg !== undefined) parts.push(`⚡ ${avg} tok/s avg`)
        }
        // Today's total usage across all sessions (server aggregate), same row
        // as the tok/s readout. Hidden when unavailable or zero.
        const stats = todayStats()
        if (stats) {
          const tk = stats?.tokens
          const total = (tk?.input ?? 0) + (tk?.output ?? 0) + (tk?.reasoning ?? 0)
          if (total > 0) parts.push(`Σ ${fmtNum(total)}`)
        }
        if (parts.length === 0) return null

        return <text fg={context.theme?.text?.muted}>{parts.join("   ")}</text>
      },
    })

    return () => {
      clearInterval(timer)
      if (statsTimer !== undefined) clearTimeout(statsTimer)
      if (typeof unregister === "function") unregister()
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
