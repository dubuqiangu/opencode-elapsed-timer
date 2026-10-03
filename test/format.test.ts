// Unit tests for src/format.ts — duration/number formatting and the
// streaming token estimator. Run: npm test
import { test } from "node:test"
import assert from "node:assert/strict"
import { estimateTokens, format, fmtNum, fmtUSD } from "../src/format.ts"

test("format renders sub-minute durations with one decimal", () => {
  assert.equal(format(0), "0.0s")
  assert.equal(format(1_750), "1.8s")
  assert.equal(format(17_500), "17.5s")
  assert.equal(format(59_949), "59.9s")
})

test("format renders minutes with zero-padded seconds and whole hours", () => {
  assert.equal(format(60_000), "1m 00s")
  assert.equal(format(62_000), "1m 02s")
  assert.equal(format(3_660_000), "1h 01m")
  assert.equal(format(7_262_000), "2h 01m")
})

test("format clamps negative durations to zero", () => {
  assert.equal(format(-5_000), "0.0s")
})

test("fmtNum compacts token counts", () => {
  assert.equal(fmtNum(0), "0")
  assert.equal(fmtNum(-3), "0")
  assert.equal(fmtNum(999), "999")
  assert.equal(fmtNum(1_234), "1.2k")
  assert.equal(fmtNum(12_345), "12k")
  assert.equal(fmtNum(1_500_000), "1.5M")
  assert.equal(fmtNum(12_000_000), "12M")
})

test("fmtUSD hides zero cost and adapts precision", () => {
  assert.equal(fmtUSD(0), "")
  assert.equal(fmtUSD(0.005), "$0.0050")
  assert.equal(fmtUSD(1.5), "$1.50")
})

test("estimateTokens counts CJK per character and the rest per four chars", () => {
  assert.equal(estimateTokens("你好世界"), 4)
  assert.equal(estimateTokens("hello world"), 3)
  assert.equal(estimateTokens("abc"), 1)
  assert.equal(estimateTokens(""), 1)
  assert.equal(estimateTokens("你好abc"), 3)
})
