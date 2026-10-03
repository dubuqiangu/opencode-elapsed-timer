// Unit tests for src/stats-source.ts — daily-usage fetch against the
// server-native stats API: input contract, envelope unwrapping, and the
// v0.7.6 timer split (step-refresh debounce vs missing-client retry).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createStatsSource } from "../src/stats-source.ts"
import type { TotalScope } from "../src/settings.ts"

test("localMidnight returns today's zero hour in local time", () => {
  const statsSource = createStatsSource({ client: {} })
  const midnight = statsSource.localMidnight()
  const midnightDate = new Date(midnight)
  assert.equal(midnightDate.getHours(), 0)
  assert.equal(midnightDate.getMinutes(), 0)
  assert.equal(midnightDate.getSeconds(), 0)
  assert.equal(midnightDate.toDateString(), new Date().toDateString())
})

test("unwrap passes through the SDK envelope or a raw payload", () => {
  const statsSource = createStatsSource({ client: {} })
  assert.deepEqual(statsSource.unwrap({ data: { tokens: {} } }), { tokens: {} })
  assert.deepEqual(statsSource.unwrap({ tokens: {} }), { tokens: {} })
  assert.equal(statsSource.unwrap(undefined), undefined)
})

test("fetchToday sends numeric from/to plus the local timezone and stores the result", async () => {
  let capturedInput: Record<string, unknown> | undefined
  const statsSource = createStatsSource({
    client: {
      session: {
        stats: async (input: Record<string, unknown>) => {
          capturedInput = input
          return { data: { tokens: { input: 10, output: 20, reasoning: 0 } } }
        },
      },
    },
  })
  await statsSource.fetchToday()
  assert.ok(statsSource.todayStats()?.tokens)
  // v0.6.4 contract: the SDK schema wants numbers, not epoch strings.
  assert.equal(typeof capturedInput?.from, "number")
  assert.equal(typeof capturedInput?.to, "number")
  assert.equal(capturedInput?.timezone, statsSource.timezone)
})

test("fetchRange queries the rolling window and totalFor reads it back per scope", async () => {
  const capturedInputs: Array<{ scopeTag: string; input: Record<string, unknown> }> = []
  const scopeTokensByTag: Record<string, { input: number; output: number; reasoning: number }> = {
    "24h": { input: 100, output: 200, reasoning: 0 },
    "7d": { input: 700, output: 800, reasoning: 0 },
    "30d": { input: 3000, output: 4000, reasoning: 0 },
  }
  const statsSource = createStatsSource({
    client: {
      session: {
        stats: async (input: Record<string, unknown>) => {
          // Tag the call by its window length so each scope is distinguishable:
          // 24h = 86.4M ms, 7d = 604.8M, 30d = 2.592B.
          const windowMs = (input.to as number) - (input.from as number)
          const scopeTag =
            windowMs > 20 * 86_400_000 ? "30d" : windowMs > 3 * 86_400_000 ? "7d" : "24h"
          capturedInputs.push({ scopeTag, input })
          return { data: { tokens: scopeTokensByTag[scopeTag] } }
        },
      },
    },
  })
  const beforeFetch = Date.now()
  await statsSource.fetchRange("24h")
  await statsSource.fetchRange("7d")
  await statsSource.fetchRange("30d")
  // Rolling windows: from ≈ now - window, sent as numbers with timezone.
  for (const captured of capturedInputs) {
    const expectedWindowMs =
      captured.scopeTag === "30d" ? 30 * 86_400_000 : captured.scopeTag === "7d" ? 7 * 86_400_000 : 24 * 3_600_000
    const windowMs = (captured.input.to as number) - (captured.input.from as number)
    assert.ok(
      Math.abs(windowMs - expectedWindowMs) < 5_000,
      `window ${windowMs} vs ${expectedWindowMs} for ${captured.scopeTag}`,
    )
    assert.equal(captured.input.timezone, statsSource.timezone)
  }
  assert.ok(capturedInputs.length >= 3)
  // totalFor: today falls back to the today fetch, scopes read the cache.
  assert.equal(statsSource.totalFor("24h")?.tokens.output, 200)
  assert.equal(statsSource.totalFor("7d")?.tokens.output, 800)
  assert.equal(statsSource.totalFor("30d")?.tokens.output, 4000)
  assert.equal(statsSource.totalFor("today"), undefined)
  assert.ok(beforeFetch > 0)
})

test("fetchTotals refreshes today plus the active rolling scope", async () => {
  const callCountByWindow: Array<number> = []
  let activeTotalScope: TotalScope = "7d"
  const statsSource = createStatsSource(
    {
      client: {
        session: {
          stats: async (input: Record<string, unknown>) => {
            callCountByWindow.push((input.to as number) - (input.from as number))
            return { data: { tokens: { input: 1, output: 2, reasoning: 0 } } }
          },
        },
      },
    },
    () => activeTotalScope,
  )
  await Promise.all([statsSource.fetchToday(), statsSource.fetchRange(activeTotalScope)])
  statsSource.fetchTotals()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  // One midnight-based call plus one ~7d rolling call were issued.
  const windowLengths = callCountByWindow
  assert.ok(windowLengths.some((windowMs) => windowMs < 24 * 3_600_000)) // today
  assert.ok(windowLengths.some((windowMs) => Math.abs(windowMs - 7 * 86_400_000) < 5_000)) // 7d
  assert.equal(statsSource.totalFor("today")?.tokens.output, 2)
  assert.equal(statsSource.totalFor("7d")?.tokens.output, 2)
  // Switching the scope changes what fetchTotals pulls next.
  activeTotalScope = "30d"
  statsSource.fetchTotals()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(statsSource.totalFor("30d")?.tokens.output, 2)
})

test("the step-refresh debounce survives a pending missing-client retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const originalError = console.error
  console.error = (...args: unknown[]) => {}
  try {
    // No stats client method yet — fetchToday arms the 30s retry timer.
    const client: Record<string, unknown> = {}
    const statsSource = createStatsSource({ client })
    await statsSource.fetchToday()
    assert.equal(statsSource.todayStats(), undefined)

    // The client method appears; a step ends while the retry is pending.
    // v0.7.6: the 1.5s debounce must schedule its own timer, not be
    // swallowed by the retry slot.
    let calls = 0
    client.session = {
      stats: async () => {
        calls++
        return { data: { tokens: { input: 1, output: 2, reasoning: 0 } } }
      },
    }
    statsSource.scheduleStatsRefresh(1500)
    await t.mock.timers.tick(1500)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls, 1)
    assert.ok(statsSource.todayStats()?.tokens)

    // The 30s retry still fires on its own independent schedule.
    await t.mock.timers.tick(30_000)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(calls, 2)
    statsSource.release()
  } finally {
    console.error = originalError
  }
})
