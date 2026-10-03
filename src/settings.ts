// Durable user settings (footer/sidebar dimension toggles). Split from
// tui.tsx in v0.7.x — behavior unchanged.

export type SettingsApi = {
  settingsStore: any
  updateSettings: ((fn: (draft: any) => void) => Promise<void>) | undefined
  hitScopeEnabled: () => "today" | "session"
  footerSigmaEnabled: () => boolean
  footerHitEnabled: () => boolean
  sidebarMetricsEnabled: () => boolean
  toggleSettingsFlag: (flagKey: string, currentValue: boolean) => void
  toggleHitScope: () => void
  release: () => void
}

export function createSettings(context: any): SettingsApi {
  // v0.6.6: user-facing footer dimension settings (durable, synced across
  // TUI instances). The user host (2.0.21) has no plugin-options config
  // channel yet, so settings persist here and toggle via /usage-settings.
  let settingsStore: any = {}
  let updateSettingsStore: ((fn: (draft: any) => void) => Promise<void>) | undefined
  try {
    const store = (context.storage as any)?.store
    if (typeof store === "function") {
      const [s, u] = store("usage-meter.settings", {
        initial: {
          hitScope: "today" as "today" | "session",
          // v0.7.0: the footer defaults to waited + tok/s only; the Σ and
          // hit segments are opt-in. The right-sidebar metrics block is on
          // by default. Absent keys fall back to these defaults on read.
          footerSigma: false,
          footerHit: false,
          sidebarMetrics: true,
        },
      })
      settingsStore = s ?? {}
      updateSettingsStore = u
    }
  } catch {}

  // Normalized settings readers: persisted stores from older versions lack
  // the newer keys, so each reader applies the documented default itself.
  const hitScopeEnabled = (): "today" | "session" =>
    settingsStore?.hitScope === "session" ? "session" : "today"
  const footerSigmaEnabled = (): boolean => settingsStore?.footerSigma === true
  const footerHitEnabled = (): boolean => settingsStore?.footerHit === true
  const sidebarMetricsEnabled = (): boolean => settingsStore?.sidebarMetrics !== false
  const toggleSettingsFlag = (flagKey: string, currentValue: boolean): void => {
    try {
      void updateSettingsStore?.((draft: any) => {
        draft[flagKey] = !currentValue
      })
    } catch {}
  }

  const toggleHitScope = (): void => {
    try {
      const nextHitScope = hitScopeEnabled() === "session" ? "today" : "session"
      void updateSettingsStore?.((draft: any) => {
        draft.hitScope = nextHitScope
      })
    } catch {}
  }

  // The durable store is host-managed; the original cleanup released
  // nothing for it, so release is a deliberate no-op kept for the
  // factory interface.
  const release = (): void => {}

  return {
    settingsStore,
    updateSettings: updateSettingsStore,
    hitScopeEnabled,
    footerSigmaEnabled,
    footerHitEnabled,
    sidebarMetricsEnabled,
    toggleSettingsFlag,
    toggleHitScope,
    release,
  }
}
