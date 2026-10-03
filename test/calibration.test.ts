// Unit tests for src/calibration.ts — per-model persisted calibration:
// defaults, EMA learning with clamping, and the model-key fallback chain.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createCalibration } from "../src/calibration.ts"

type MockStoreState = Record<string, unknown>

// One shared state per store name so persistence assertions can observe
// what the factory actually wrote.
const createMockStorage = (persisted?: MockStoreState) => {
  const statesByName = new Map<string, MockStoreState>()
  return {
    store: (name: string, opts: { initial: unknown }) => {
      if (!statesByName.has(name)) {
        statesByName.set(
          name,
          persisted ? { ...persisted } : { ...(opts.initial as MockStoreState) },
        )
      }
      const state = statesByName.get(name) as MockStoreState
      const update = async (fn: (draft: MockStoreState) => void) => {
        fn(state)
      }
      return [state, update]
    },
    statesByName,
  }
}

type MockStorage = ReturnType<typeof createMockStorage>

const createContextWith = (storage: MockStorage, sessionRecord?: unknown) => ({
  storage,
  data: { session: { get: (_sessionID: string) => sessionRecord } },
})

test("calibration defaults to a neutral factor for unknown sessions", () => {
  const calibration = createCalibration(createContextWith(createMockStorage()))
  assert.equal(calibration.calibOf("ses_unknown"), 1)
})

test("calibration reads the persisted factor for the session's model", () => {
  const calibration = createCalibration(
    createContextWith(createMockStorage({ "prov/model-a": 1.5 }), {
      model: { providerID: "prov", id: "model-a" },
    }),
  )
  assert.equal(calibration.calibOf("ses_any"), 1.5)
})

test("rememberSessionModel keys the lookup without touching session records", () => {
  const calibration = createCalibration(
    createContextWith(createMockStorage({ "prov/model-b": 0.75 })),
  )
  calibration.rememberSessionModel("ses_seen", { providerID: "prov", id: "model-b" })
  assert.equal(calibration.calibOf("ses_seen"), 0.75)
})

test("learnCalibration skips tiny samples below the trust threshold", () => {
  const calibration = createCalibration(createContextWith(createMockStorage()))
  calibration.learnCalibration("ses_tiny", 5, 100)
  assert.equal(calibration.calibOf("ses_tiny"), 1)
})

test("learnCalibration folds the exact/estimated ratio with EMA weighting", () => {
  const calibration = createCalibration(createContextWith(createMockStorage()))
  calibration.learnCalibration("ses_learn", 100, 200)
  assert.equal(calibration.calibOf("ses_learn"), 1 * 0.7 + 2 * 0.3)
})

test("learnCalibration clamps extreme ratios to the 0.25-4 band", () => {
  const calibration = createCalibration(createContextWith(createMockStorage()))
  // A single extreme-high sample jumps straight to the 4.0 ceiling.
  calibration.learnCalibration("ses_spike", 100, 10_000)
  assert.equal(calibration.calibOf("ses_spike"), 4)
  // The 0.25 floor is reached by EMA convergence: each low sample multiplies
  // the factor by 0.7, so repeated readings walk down into the clamp
  // (1 -> 0.7 -> 0.49 -> 0.343 -> 0.25).
  for (let sampleIndex = 0; sampleIndex < 5; sampleIndex++) {
    calibration.learnCalibration("ses_dip", 10_000, 1)
  }
  assert.equal(calibration.calibOf("ses_dip"), 0.25)
})

test("learnCalibration persists the learned factor under the model key", () => {
  const storage = createMockStorage()
  const calibration = createCalibration(createContextWith(storage, {
    model: { providerID: "prov", id: "model-c" },
  }))
  calibration.learnCalibration("ses_persist", 100, 300)
  const persistedState = storage.statesByName.get("usage-meter.calib") as MockStoreState
  // EMA folds from the neutral default: 1 * 0.7 + (300/100) * 0.3 = 1.6
  assert.ok(Math.abs((persistedState["prov/model-c"] as number) - 1.6) < 1e-9)
})

test("release is a documented no-op for the host-managed store", () => {
  const calibration = createCalibration(createContextWith(createMockStorage()))
  assert.doesNotThrow(() => calibration.release())
})
