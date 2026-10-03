// Panel content builders for the /usage-full stats view: the live session
// header, the current-window / cumulative / subagent blocks, and the daily +
// all-time detail tables. Split from tui.tsx in v0.7.x — behavior unchanged.
import { createSignal } from "solid-js"
import { fmtNum, fmtUSD, format } from "./format"
import { liveRate } from "./rate-model"
import type { CalibrationApi } from "./calibration"
import type { SessionMetricsApi } from "./session-metrics"
import type { StatsSourceApi } from "./stats-source"

export const PANEL_NAME = "usage-meter.stats"

export type PanelContentApi = {
  detail: () => any
  setDetail: (value: any) => void
  sumTokens: (t: any) => number
  ctxModelLimit: (message: any) => number | undefined
  lastAssistant: (sessionID: string) => any | undefined
  ctxPercent: (sessionID: string) => { pct: number; warn: boolean } | undefined
  descendantSessions: (rootID: string) => any[]
  sessionUsageLines: (sessionID: string) => string[]
  sessionLines: (sessionID: string | undefined) => string[]
  detailLines: (st: any) => string[]
  ensureDetail: () => Promise<void>
}

export function createPanelContent(deps: {
  context: any
  sessionMetrics: SessionMetricsApi
  statsSource: StatsSourceApi
  calibration: CalibrationApi
  now: () => number
}): PanelContentApi {
  const { context, now } = deps
  const { starts, lastDurations, lastAvgRates, lastExactRates, rates } = deps.sessionMetrics
  const { todayStats, setTodayStats, statsCall, localMidnight, unwrap, timezone } = deps.statsSource
  const { calibOf } = deps.calibration

  const [detail, setDetail] = createSignal<any>(undefined)

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
      let line = `  ⏱ ${format(currentTime - started)}`
      const rate = rates.get(sessionID)
      const tps = rate ? liveRate(rate, currentTime) : undefined
      if (tps !== undefined) line += `   ⚡ ${Math.round(tps * calibOf(sessionID))} tok/s`
      lines.push(line)
    } else if (running) {
      lines.push("  ⏳")
    } else if (last !== undefined) {
      let line = `  🏁 ${format(last)}`
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

  return {
    detail,
    setDetail,
    sumTokens,
    ctxModelLimit,
    lastAssistant,
    ctxPercent,
    descendantSessions,
    sessionUsageLines,
    sessionLines,
    detailLines,
    ensureDetail,
  }
}
