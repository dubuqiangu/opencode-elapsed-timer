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
    // Ticking clock drives the elapsed recompute while a run is active.
    const [now, setNow] = createSignal(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 500)

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
      if (!sessionID || typeof out !== "number" || !(out > 0)) return
      const st = rateStateOf(sessionID)
      if (!st) return
      st.sessionVocab = true
      adoptExact(st, data.assistantMessageID ?? data.messageID, out, false)
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
        if (parts.length === 0) return null

        return <text fg={context.theme?.text?.muted}>{parts.join("   ")}</text>
      },
    })

    return () => {
      clearInterval(timer)
      if (typeof unregister === "function") unregister()
      subs.forEach((stop) => {
        try {
          stop()
        } catch {}
      })
    }
  },
})
