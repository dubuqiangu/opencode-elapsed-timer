// Live-estimate calibration: per-session EMA of exact/estimated output,
// persisted per model across sessions/restarts. Split from tui.tsx in
// v0.7.x — behavior unchanged.

export type CalibrationApi = {
  calibOf: (sessionID: string) => number
  learnCalibration: (sessionID: string, before: number, out: number) => void
  rememberSessionModel: (sessionID: string, model: any) => void
  release: () => void
}

export function createCalibration(context: any): CalibrationApi {
  // v0.6.2: live-estimate calibration factor per session (EMA of exact/est),
  // applied to streaming tok/s so it converges toward native accounting.
  const calibs = new Map<string, number>()
  // v0.6.3: calibration persists per model across sessions/restarts via
  // durable storage, so a new session starts already-calibrated.
  let calibStore: Record<string, number> = {}
  let updateCalibStore: ((fn: (draft: Record<string, number>) => void) => Promise<void>) | undefined
  try {
    const store = (context.storage as any)?.store
    if (typeof store === "function") {
      const [s, u] = store("usage-meter.calib", { initial: {} })
      calibStore = s ?? {}
      updateCalibStore = u
    }
  } catch {}

  // Last-seen model per session ("provider/model"), used to key persisted
  // calibration; falls back to the session record.
  const sessionModels = new Map<string, string>()
  const modelKeyOf = (sessionID: string): string | undefined => {
    const cached = sessionModels.get(sessionID)
    if (cached) return cached
    try {
      const s = context.data?.session?.get?.(sessionID)
      if (s?.model) return `${s.model.providerID}/${s.model.id}`
    } catch {}
    return undefined
  }
  const calibOf = (sessionID: string): number => {
    const live = calibs.get(sessionID)
    if (live !== undefined) return live
    const key = modelKeyOf(sessionID)
    const persisted = key ? calibStore[key] : undefined
    return typeof persisted === "number" && persisted > 0 ? persisted : 1
  }

  // Fold a new exact/estimated reading into the session calibration factor
  // and persist it per model. Extracted verbatim from the former adoptExact.
  const learnCalibration = (sessionID: string, before: number, out: number): void => {
    // v0.6.2: learn the estimator's correction ratio (exact/estimated)
    // and fold it into the session calibration factor for live rates.
    // v0.6.3: also persist it per model so new sessions start calibrated.
    if (out > 0 && before > 20) {
      const prev = calibs.get(sessionID) ?? calibOf(sessionID)
      const next = Math.min(4, Math.max(0.25, prev * 0.7 + (out / before) * 0.3))
      calibs.set(sessionID, next)
      const modelKey = modelKeyOf(sessionID)
      if (modelKey && updateCalibStore) {
        try {
          void updateCalibStore((draft: Record<string, number>) => {
            draft[modelKey] = next
          })
        } catch {}
      }
    }
  }

  // v0.6.3: remember the session's model to key persisted calibration.
  const rememberSessionModel = (sessionID: string, model: any): void => {
    sessionModels.set(sessionID, `${model.providerID}/${model.id}`)
  }

  // The durable store is host-managed; the original cleanup released
  // nothing for it, so release is a deliberate no-op kept for the
  // factory interface.
  const release = (): void => {}

  return { calibOf, learnCalibration, rememberSessionModel, release }
}
