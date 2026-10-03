// Pure formatting and token-estimation helpers. Split from tui.tsx in
// v0.7.x — behavior unchanged.

export function format(ms: number): string {
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
export function estimateTokens(text: string): number {
  const cjk =
    text.match(/[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/g)?.length ?? 0
  const other = Math.max(0, text.length - cjk)
  return Math.max(1, Math.round(cjk + other / 4))
}

// Compact token counts: 1_234 -> "1.2k", 12_000_000 -> "12M" (>=10 rounds to whole).
export function fmtNum(n: number): string {
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

export function fmtUSD(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ""
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
}
