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
        console.error(`[usage-meter] ${type} subscription failed:`, error)
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
        console.error("[usage-meter] session stats client method unavailable")
        return
      }
      statsBusy = true
      try {
        const input: any = { from: String(localMidnight()), to: String(Date.now()) }
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
        if (tps !== undefined) line += `   ⚡ ${tps} tok/s`
        lines.push(line)
      } else if (running) {
        lines.push("  ⏱ running")
      } else if (last !== undefined) {
        let line = `  ✓ last ${format(last)}`
        const avg = lastAvgRates.get(sessionID)
        if (avg !== undefined) line += `   ⚡ ${avg} tok/s avg`
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
          call({ ...baseInput, from: String(localMidnight()), to: String(Date.now()) }),
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
        // Outside a session: dialog fallback (no live section available).
        try {
          context.ui.dialog.set({ size: "large", centered: true })
        } catch {}
        setDetail(undefined)
        context.ui.dialog.show(() => <StatsBody />, () => {})
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

    // /usage-full + palette command "用量统计".
    let layerDispose: any
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
        ],
      }))
    } catch (error) {
      console.error("[usage-meter] keymap layer failed:", error)
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
        // as the tok/s readout. Hidden when unavailable or zero. The cache hit
        // rate (cache.read / (cache.read + input)) rides along with it.
        const stats = todayStats()
        if (stats) {
          const tk = stats?.tokens
          const total = (tk?.input ?? 0) + (tk?.output ?? 0) + (tk?.reasoning ?? 0)
          if (total > 0) {
            parts.push(`Σ ${fmtNum(total)}`)
            const read = tk?.cache?.read ?? 0
            const denom = read + (tk?.input ?? 0)
            if (denom > 0) parts.push(`hit ${Math.round((read / denom) * 100)}%`)
          }
        }
        if (parts.length === 0) return null

        return <text fg={context.theme?.text?.muted}>{parts.join("   ")}</text>
      },
    })

    return () => {
      clearInterval(timer)
      if (statsTimer !== undefined) clearTimeout(statsTimer)
      if (typeof unregister === "function") unregister()
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
