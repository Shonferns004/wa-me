"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeFeatureFlags = computeFeatureFlags;
exports.resolveFeatureFlags = resolveFeatureFlags;
const env_int_1 = require("../common/utils/env-int");
/**
 * Derive the feature-flag set from an environment map. Pure and parameterised for testability. The
 * comparisons intentionally mirror the exact semantics of the original inline reads so behaviour is
 * unchanged:
 *   - `=== 'true'`  → opt-in flag (default false)
 *   - `!== 'false'` → opt-out flag (default true)
 * The max-ms read keeps a positive number (a fraction is floored); 0, negative, empty and non-numeric
 * values all fall back to 5000 (note this differs from `parseInt`, which would keep a literal 0).
 */
function computeFeatureFlags(env = process.env) {
    return {
        autoStartSessions: env.AUTO_START_SESSIONS === 'true',
        storeEphemeralMessages: env.STORE_EPHEMERAL_MESSAGES !== 'false',
        resolveLidToPhone: env.RESOLVE_LID_TO_PHONE === 'true',
        simulateTyping: env.SIMULATE_TYPING !== 'false',
        simulateTypingMaxMs: (0, env_int_1.positiveIntOrDefault)(env.SIMULATE_TYPING_MAX_MS, 5000),
    };
}
/**
 * Resolve the flags, preferring the `ConfigService`-loaded set (the boot-time snapshot built by
 * `configuration.ts`) and falling back to a live `process.env` read when `ConfigService` is absent —
 * e.g. a unit test that constructs a service without the global `ConfigModule`. Environment variables
 * do not change during a process's lifetime, so the snapshot and a live read are equivalent in
 * production; the fallback exists purely to preserve the live-read behaviour that unit tests rely on
 * when they mutate `process.env`.
 */
function resolveFeatureFlags(configService) {
    const fromConfig = configService?.get('features');
    return fromConfig ?? computeFeatureFlags();
}
