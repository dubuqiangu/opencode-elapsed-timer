// Unit tests for src/rate-model.ts — message/turn token accounting, the
// sliding sample window, live-rate math and the tolerant event accessors.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  dataOf,
  liveRate,
  msgTotal,
  pushSample,
  sessionIDOf,
  tsOf,
  turnTotal,
  type RateState,
} from "../src/rate-model.ts"

const newRateState = (): RateState => ({
  sessionID: "ses_under_test",
  msgs: new Map(),
  samples: [],
  sessionVocab: false,
})

test("msgTotal uses est until an exact reading is adopted", () => {
  assert.equal(msgTotal({ est: 42, refEst: 0 }), 42)
  assert.equal(msgTotal({ est: 50, refEst: 30, exact: 40 }), 60)
})

test("msgTotal never lets est drop below the adopted exact snapshot", () => {
  assert.equal(msgTotal({ est: 20, refEst: 30, exact: 40 }), 40)
})

test("turnTotal sums every message in the turn", () => {
  const state = newRateState()
  state.msgs.set("msg_alpha", { est: 10, refEst: 0 })
  state.msgs.set("msg_beta", { est: 15, refEst: 0 })
  assert.equal(turnTotal(state), 25)
})

test("pushSample records cumulative tokens and trims samples older than 10s", async () => {
  const state = newRateState()
  state.msgs.set("msg_alpha", { est: 10, refEst: 0 })
  const staleSample = { t: Date.now() - 11_000, tok: 0 }
  state.samples.push(staleSample)
  pushSample(state)
  assert.equal(state.samples.length, 1)
  assert.notEqual(state.samples[0], staleSample)
  assert.equal(state.samples[0].tok, 10)
})

test("liveRate stays hidden without a usable window", () => {
  const singleSample = newRateState()
  assert.equal(liveRate(singleSample, Date.now()), undefined)

  const tooFresh = newRateState()
  tooFresh.samples = [
    { t: Date.now() - 200, tok: 10 },
    { t: Date.now() - 100, tok: 12 },
  ]
  assert.equal(liveRate(tooFresh, Date.now()), undefined)

  const stale = newRateState()
  stale.samples = [
    { t: Date.now() - 6_000, tok: 10 },
    { t: Date.now() - 5_000, tok: 20 },
  ]
  assert.equal(liveRate(stale, Date.now()), undefined)
})

test("liveRate computes tokens per second across a spread window", () => {
  const streaming = newRateState()
  const windowEnd = Date.now() - 1_000
  streaming.samples = [
    { t: windowEnd - 4_000, tok: 10 },
    { t: windowEnd, tok: 30 },
  ]
  assert.equal(liveRate(streaming, Date.now()), 5)
})

test("liveRate returns undefined for non-positive rates", () => {
  const declining = newRateState()
  const windowEnd = Date.now() - 1_000
  declining.samples = [
    { t: windowEnd - 4_000, tok: 30 },
    { t: windowEnd, tok: 10 },
  ]
  assert.equal(liveRate(declining, Date.now()), undefined)
})

test("tsOf accepts epoch numbers and ISO strings, rejects garbage", () => {
  assert.equal(tsOf(1_700_000_000_000), 1_700_000_000_000)
  assert.equal(tsOf("2026-10-03T00:00:00.000Z"), Date.parse("2026-10-03T00:00:00.000Z"))
  assert.equal(tsOf("not-a-date"), undefined)
  assert.equal(tsOf(undefined), undefined)
  assert.equal(tsOf({}), undefined)
})

test("dataOf unwraps the TUI bus envelope, SDK envelope or flat shape", () => {
  assert.deepEqual(dataOf({ data: { sessionID: "ses_a" } }), { sessionID: "ses_a" })
  assert.deepEqual(dataOf({ properties: { sessionID: "ses_b" } }), { sessionID: "ses_b" })
  assert.deepEqual(dataOf({ sessionID: "ses_c" }), { sessionID: "ses_c" })
})

test("sessionIDOf reads the session id from any envelope", () => {
  assert.equal(sessionIDOf({ data: { sessionID: "ses_a" } }), "ses_a")
  assert.equal(sessionIDOf({ properties: { sessionID: "ses_b" } }), "ses_b")
  assert.equal(sessionIDOf({ data: { sessionID: "" } }), undefined)
  assert.equal(sessionIDOf({}), undefined)
})
