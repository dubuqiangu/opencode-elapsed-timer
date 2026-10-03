// Runtime per-session token-flow state and the session.* / message.*
// event handlers that feed it. Split from tui.tsx in v0.7.x — behavior
// unchanged; the handlers keep their original bodies and are registered
// by tui.tsx in the original listen() order.
import { estimateTokens } from "./format"
import { dataOf, msgTotal, pushSample, sessionIDOf, tsOf, turnTotal } from "./rate-model"
import type { RateState } from "./rate-model"
import type { CalibrationApi } from "./calibration"

export type SessionMetricsApi = {
  onExecutionStarted: (event: any) => void
  onStepStarted: (event: any) => void
  onSessionDelta: (event: any) => void
  onStepEnded: (event: any) => void
  onLegacyDelta: (event: any) => void
  onMessageUpdated: (event: any) => void
  finishTurn: (event: any) => void
  starts: Map<string, number>
  lastDurations: Map<string, number>
  lastAvgRates: Map<string, number>
  lastExactRates: Map<string, number>
  rates: Map<string, RateState>
  rateStateOf: (sessionID: string) => RateState | undefined
}

export function createSessionMetrics(deps: {
  context: any
  calibration: CalibrationApi
  scheduleStatsRefresh: (delayMs?: number) => void
}): SessionMetricsApi {
  const { context, calibration, scheduleStatsRefresh } = deps

  // Turn start times and last finished durations, keyed by session ID.
  const starts = new Map<string, number>()
  const lastDurations = new Map<string, number>()
  const lastAvgRates = new Map<string, number>()
  // v0.6.2: exact per-message generation rate (output+reasoning over the
  // message's own created→completed span) — replaces the heuristic idle avg.
  const lastExactRates = new Map<string, number>()

  // Token-flow tracking per session, active only during a run.
  const rates = new Map<string, RateState>()
  const newRateState = (sessionID: string): RateState =>
    ({ sessionID, msgs: new Map(), samples: [], sessionVocab: false })

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
      // v0.6.2/v0.6.3: learn the estimator's correction ratio and fold it
      // into the session calibration factor (persisted per model) — the
      // calibration module owns that logic now.
      calibration.learnCalibration(st.sessionID, msgTotal(m), out)
      m.exact = out
      m.refEst = m.est
      st.msgs.set(key, m)
    }
    pushSample(st)
  }

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

  const onExecutionStarted = (event: any): void => {
    const sessionID = sessionIDOf(event)
    if (!sessionID) return
    starts.set(sessionID, Date.now())
    rates.set(sessionID, newRateState(sessionID))
  }

  const onStepStarted = (event: any): void => {
    // Recovery if the execution.started event was missed (e.g. TUI opened mid-run).
    const sessionID = sessionIDOf(event)
    const data = dataOf(event)
    const started = data?.started
    if (sessionID && typeof started === "number" && !starts.has(sessionID)) {
      starts.set(sessionID, started)
      rates.set(sessionID, newRateState(sessionID))
    }
  }

  const finishTurn = (event: any): void => {
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

  // --- Live streaming chunks (current V2 event family) ---
  const onSessionDelta = (event: any): void => {
    const data = dataOf(event)
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
    const delta = typeof data?.delta === "string" ? data.delta : undefined
    if (!sessionID || !delta) return
    const st = rateStateOf(sessionID)
    if (!st) return
    st.sessionVocab = true
    addEst(st, data.assistantMessageID ?? data.messageID, delta)
  }

  // --- Exact cumulative tokens when a step completes ---
  const onStepEnded = (event: any): void => {
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

  // --- Legacy event family fallbacks ---
  // message.part.delta: only counted when no session.* delta was seen this
  // turn, so the same chunk is never counted twice.
  const onLegacyDelta = (event: any): void => {
    const data = dataOf(event)
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
    const delta = typeof data?.delta === "string" ? data.delta : undefined
    if (!sessionID || !delta) return
    const st = rateStateOf(sessionID)
    if (!st || st.sessionVocab) return
    addEst(st, data.assistantMessageID ?? data.messageID, delta)
  }

  const onMessageUpdated = (event: any): void => {
    const data = dataOf(event)
    const info = data?.info
    if (info?.role !== "assistant" || typeof info?.tokens?.output !== "number") return
    const sessionID = typeof data?.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID) return
    // v0.6.3: remember the session's model to key persisted calibration.
    if (info.model) calibration.rememberSessionModel(sessionID, info.model)
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
  }

  return {
    onExecutionStarted,
    onStepStarted,
    onSessionDelta,
    onStepEnded,
    onLegacyDelta,
    onMessageUpdated,
    finishTurn,
    starts,
    lastDurations,
    lastAvgRates,
    lastExactRates,
    rates,
    rateStateOf,
  }
}
