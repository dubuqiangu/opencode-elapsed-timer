// Unit tests for src/stats-source.ts — daily-usage fetch against the
// server-native stats API: input contract, envelope unwrapping, and the
// v0.7.6 timer split (step-refresh debounce vs missing-client retry).
import { test } from "node:test"
import assert from "node:assert/strict"
import { createStatsSource } from "../src/stats-source.ts"

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
