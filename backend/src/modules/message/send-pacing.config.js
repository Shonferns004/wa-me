"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeSendPacingConfig = computeSendPacingConfig;
exports.resolveSendPacingConfig = resolveSendPacingConfig;
/** A cautious two-week ramp: ~1 message every 3 minutes on day one, ~2/minute by the second week. */
const DEFAULT_WARMUP_SCHEDULE = [20, 40, 80, 160, 320, 640, 1000];
/** Deliberately far below the overall ramp: a stranger costs more standing than a reply does. */
const DEFAULT_COLD_SCHEDULE = [5, 10, 20, 40, 60, 80, 100];
const DEFAULT_BREAKER_THRESHOLD = 5;
const DEFAULT_BREAKER_COOLDOWN_MS = 15 * 60_000;
// A cap of 0 would refuse every send, which is never what a misconfigured value should mean, so the
// floor is 1. The ceiling is a sanity bound, not a WhatsApp limit — nobody's real allowance is 100k,
// and a fat-fingered value that large would silently disable the whole mechanism.
const MIN_DAILY_CAP = 1;
const MAX_DAILY_CAP = 100_000;
const MIN_BREAKER_THRESHOLD = 1;
const MIN_BREAKER_COOLDOWN_MS = 1000;
/**
 * Parse a comma-separated warm-up schedule (`"20,40,80"`). Any malformed entry falls the WHOLE
 * schedule back to the default rather than being skipped: a schedule with a hole in it would apply a
 * silently different ramp than the operator wrote, and quietly sending more than intended is the one
 * failure this feature exists to prevent.
 */
function parseSchedule(raw, fallback) {
    // An explicit off value is a deliberate "no rule", distinct from an unset one. Only the cold cap
    // uses it; the overall cap has no off switch short of disabling pacing. `0` and `off` exist because
    // boot deletes a blank container env var, so the empty value only ever reaches here from a .env file.
    if (raw !== undefined && ['', '0', 'off'].includes(raw.trim().toLowerCase())) {
        return fallback === DEFAULT_COLD_SCHEDULE ? [] : fallback;
    }
    if (!raw)
        return fallback;
    const parts = raw.split(',').map(part => Number(part.trim()));
    if (parts.length === 0 || parts.some(n => !Number.isFinite(n) || n < MIN_DAILY_CAP || n > MAX_DAILY_CAP)) {
        return fallback;
    }
    return parts.map(n => Math.floor(n));
}
function parsePositiveInt(raw, fallback, min) {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min)
        return fallback;
    return Math.floor(value);
}
/** Derive the policy from an environment map. Pure and parameterised for testability. */
function computeSendPacingConfig(env = process.env) {
    return {
        enabled: env.SEND_PACING_ENABLED === 'true',
        warmupSchedule: parseSchedule(env.SEND_PACING_WARMUP_SCHEDULE, DEFAULT_WARMUP_SCHEDULE),
        coldSchedule: parseSchedule(env.SEND_PACING_COLD_DAILY_CAP, DEFAULT_COLD_SCHEDULE),
        breakerThreshold: parsePositiveInt(env.SEND_PACING_BREAKER_THRESHOLD, DEFAULT_BREAKER_THRESHOLD, MIN_BREAKER_THRESHOLD),
        breakerCooldownMs: parsePositiveInt(env.SEND_PACING_BREAKER_COOLDOWN_MS, DEFAULT_BREAKER_COOLDOWN_MS, MIN_BREAKER_COOLDOWN_MS),
    };
}
/**
 * Resolve the policy, preferring the ConfigService snapshot and falling back to a live `process.env`
 * read when ConfigService is absent — the same arrangement `resolveFeatureFlags` uses, and for the
 * same reason: unit tests construct services without the global ConfigModule and mutate `process.env`.
 */
function resolveSendPacingConfig(configService) {
    return configService?.get('sendPacing') ?? computeSendPacingConfig();
}
