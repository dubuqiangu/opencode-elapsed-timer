// Unit tests for src/settings.ts — durable settings defaults, normalization
// for stores persisted by older plugin versions, and the toggle paths.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createSettings } from "../src/settings.ts"

type MockStoreState = Record<string, unknown>
type MockStorage = { store: (name: string, opts: { initial: unknown }) => [MockStoreState, (fn: (draft: MockStoreState) => void) => Promise<void>] }

const createMockStorage = (persisted?: MockStoreState): MockStorage => ({
  store: (_name, opts) => {
    const state: MockStoreState = persisted ? { ...persisted } : { ...(opts.initial as MockStoreState) }
    const update = async (fn: (draft: MockStoreState) => void) => {
      fn(state)
    }
    return [state, update]
  },
})

const createStoragelessContext = (): { storage: undefined } => ({ storage: undefined })

test("settings fall back to documented defaults when storage is unavailable", () => {
  const settings = createSettings(createStoragelessContext())
  assert.equal(settings.hitScopeEnabled(), "today")
  assert.equal(settings.footerSigmaEnabled(), false)
  assert.equal(settings.footerHitEnabled(), false)
  assert.equal(settings.sidebarMetricsEnabled(), true)
})

test("settings normalize stores persisted by pre-0.7.0 versions", () => {
  const settings = createSettings({ storage: createMockStorage({ hitScope: "session" }) })
  assert.equal(settings.hitScopeEnabled(), "session")
  assert.equal(settings.footerSigmaEnabled(), false)
  assert.equal(settings.footerHitEnabled(), false)
  assert.equal(settings.sidebarMetricsEnabled(), true)
})

test("toggleSettingsFlag persists the inverted value through the store", async () => {
  const settings = createSettings({ storage: createMockStorage() })
  assert.equal(settings.footerSigmaEnabled(), false)
  settings.toggleSettingsFlag("footerSigma", settings.footerSigmaEnabled())
  assert.equal(settings.settingsStore.footerSigma, true)
  settings.toggleSettingsFlag("sidebarMetrics", settings.sidebarMetricsEnabled())
  assert.equal(settings.settingsStore.sidebarMetrics, false)
})

test("statsBlockCollapsed defaults to expanded and the header click persists the flip", () => {
  const freshSettings = createSettings({ storage: createMockStorage() })
  assert.equal(freshSettings.statsBlockCollapsed(), false)
  const legacySettings = createSettings({
    storage: createMockStorage({ statsBlockCollapsed: "garbage" }),
  })
  assert.equal(legacySettings.statsBlockCollapsed(), false)
  freshSettings.toggleSettingsFlag("statsBlockCollapsed", freshSettings.statsBlockCollapsed())
  assert.equal(freshSettings.settingsStore.statsBlockCollapsed, true)
  freshSettings.toggleSettingsFlag("statsBlockCollapsed", freshSettings.statsBlockCollapsed())
  assert.equal(freshSettings.settingsStore.statsBlockCollapsed, false)
})

test("toggleHitScope flips between today and session and persists", () => {
  const settings = createSettings({ storage: createMockStorage() })
  settings.toggleHitScope()
  assert.equal(settings.settingsStore.hitScope, "session")
  settings.toggleHitScope()
  assert.equal(settings.settingsStore.hitScope, "today")
})

test("totalScope defaults to today when storage lacks the key or holds garbage", () => {
  const freshSettings = createSettings({ storage: createMockStorage() })
  assert.equal(freshSettings.totalScopeEnabled(), "today")
  const legacySettings = createSettings({ storage: createMockStorage({ hitScope: "session" }) })
  assert.equal(legacySettings.totalScopeEnabled(), "today")
  const corruptSettings = createSettings({
    storage: createMockStorage({ totalScope: "yesterday" }),
  })
  assert.equal(corruptSettings.totalScopeEnabled(), "today")
})

test("cycleTotalScope walks today -> 24h -> 7d -> 30d and wraps, persisting each step", () => {
  const settings = createSettings({ storage: createMockStorage() })
  assert.equal(settings.totalScopeEnabled(), "today")
  settings.cycleTotalScope()
  assert.equal(settings.settingsStore.totalScope, "24h")
  settings.cycleTotalScope()
  assert.equal(settings.settingsStore.totalScope, "7d")
  settings.cycleTotalScope()
  assert.equal(settings.settingsStore.totalScope, "30d")
  settings.cycleTotalScope()
  assert.equal(settings.settingsStore.totalScope, "today")
})

test("release is a documented no-op for the host-managed store", () => {
  const settings = createSettings({ storage: createMockStorage() })
  assert.doesNotThrow(() => settings.release())
})
