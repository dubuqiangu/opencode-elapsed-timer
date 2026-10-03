// Test-only module-resolution hook. The plugin's src/ uses extensionless
// relative TS imports (resolved by the OpenCode runtime); Node's native
// type stripping requires explicit extensions. This hook retries failed
// relative resolutions with a ".ts" appended, so `npm test` runs with zero
// dev dependencies.
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith(".") || specifier.startsWith("file:")) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },
})
