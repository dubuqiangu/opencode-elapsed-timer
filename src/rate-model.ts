// Rate math types and pure helpers, plus the tolerant event-envelope
// accessors. Split from tui.tsx in v0.7.x — behavior unchanged.

export type MsgRate = { est: number; exact?: number; refEst: number }
export type RateState = {
  sessionID: string
  msgs: Map<string, MsgRate>
  samples: Array<{ t: number; tok: number }>
  sessionVocab: boolean // saw a session.* delta this turn -> ignore legacy deltas
}

export function msgTotal(m: MsgRate): number {
  return m.exact !== undefined ? m.exact + Math.max(0, m.est - m.refEst) : m.est
}

export function turnTotal(st: RateState): number {
  let total = 0
  for (const m of st.msgs.values()) total += msgTotal(m)
  return total
}

export function pushSample(st: RateState): void {
  const t = Date.now()
  const s = st.samples
  while (s.length > 0 && t - s[0].t > 10_000) s.shift()
  s.push({ t, tok: turnTotal(st) })
}

// Rolling output rate from recent stream samples. Returns undefined when the
// stream is idle (tool run / long gap) or there is not yet a usable window.
export function liveRate(st: RateState, now: number): number | undefined {
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

export const dataOf = (event: any): any => event?.data ?? event?.properties ?? event

// v0.6.5: tolerant timestamp coercion — hosts may deliver message times
// as epoch numbers (openapi) or ISO strings; both must feed the exact-rate
// math. Returns undefined for anything unusable.
export const tsOf = (v: any): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const parsed = Date.parse(v)
    if (!Number.isNaN(parsed)) return parsed
  }
  return undefined
}

export const sessionIDOf = (event: any): string | undefined => {
  // The TUI data bus exposes the payload at `event.data`; accept the raw
  // SDK envelope's `properties` and a flat shape as fallbacks.
  const data = dataOf(event)
  return typeof data?.sessionID === "string" && data.sessionID ? data.sessionID : undefined
}
