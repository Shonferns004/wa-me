"use strict";
/**
 * The reconnect backoff *decision*, separated from its effects.
 *
 * `SessionEngineLifecycle.scheduleReconnect` interleaves three rules (budget exhaustion, exponential
 * backoff with jitter, periodic loop alerting) with the side effects they trigger
 * (status writes, engine eviction, webhooks, timers). The rules are the subtle part and the effects
 * are the untestable part, so the rules live here as a pure function over explicit state.
 *
 * Pure by construction: no timers, no I/O, and `jitter` is injected, so every branch,
 * including the capped long-streak ones, is directly reachable in a test.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.STABLE_READY_MS = exports.RECONNECT_DELAY_CAP_MS = exports.RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS = void 0;
exports.clampNumber = clampNumber;
exports.clampReconnectDelay = clampReconnectDelay;
exports.decideReconnect = decideReconnect;
/**
 * A reconnect-loop alert fires once per this many CONSECUTIVE attempts of a session — one signal per
 * ongoing episode, not spam per attempt. A broken-forever setup retries without limit (by design), so
 * the 5th/10th/15th… scheduled attempt is the operator-facing tell; the streak resets only once the
 * session has held READY for STABLE_READY_MS, so a later episode re-arms the alert from attempt 5 again.
 */
exports.RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS = 5;
/**
 * Upper bound on a computed backoff delay (see clampReconnectDelay). Kept at 5 minutes so a session
 * recovers within about that long once a lengthy outage ends.
 */
exports.RECONNECT_DELAY_CAP_MS = 300_000;
/**
 * How long a session must stay READY before its next drop starts a fresh streak. A READY that drops
 * sooner is part of the same flapping episode: the backoff keeps growing and the loop alert still
 * fires, instead of relaunching at the base delay forever.
 */
exports.STABLE_READY_MS = exports.RECONNECT_DELAY_CAP_MS;
function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}
/**
 * Clamp a computed backoff delay finite and within setTimeout's safe range (a huge value would
 * overflow its 32-bit ms field and fire immediately). NaN falls back to baseDelay; +Infinity is
 * simply huge, so it takes the cap like any other oversized delay.
 */
function clampReconnectDelay(rawDelay, baseDelay) {
    return clampNumber(Number.isNaN(rawDelay) ? baseDelay : rawDelay, 0, exports.RECONNECT_DELAY_CAP_MS);
}
/**
 * Decide what should happen for the next reconnect of a session, and advance `state` accordingly.
 *
 * MUTATES `state` (attempts) exactly as the original inline code did, so the caller
 * keeps a single source of truth for the session's streak across calls.
 *
 * @param jitter  Injected jitter in ms, added before clamping (production passes `Math.random() * 1000`).
 */
function decideReconnect(state, jitter = Math.random() * 1000) {
    // The attempt counter only resets after the session has held READY for STABLE_READY_MS (the
    // lifecycle does that). The window is measured from READY, never from the last attempt: a reset
    // keyed on time between attempts would fire as soon as the backoff delay itself grew past the
    // window, so an explicit cap would never be reached.
    if (state.attempts >= state.maxAttempts) {
        // maxAttempts:0 means auto-reconnect is disabled, not that N attempts were tried and failed — say
        // so instead of the misleading "failed after 0 attempts".
        return {
            kind: 'exhausted',
            reason: state.maxAttempts === 0
                ? 'Auto-reconnect is disabled (max attempts set to 0), so the dropped session was marked failed. Start it again manually.'
                : `Reconnection failed after ${state.attempts} attempts — restart the session.`,
        };
    }
    // Exponential backoff: baseDelay * 2^attempts (with jitter), clamped finite + within
    // setTimeout's safe range so the timer can't overflow and fire immediately. With the default
    // unlimited budget the delay parks at RECONNECT_DELAY_CAP_MS once the exponent outgrows it; the
    // exponent is bounded so a very long streak never overflows the product to Infinity.
    const delayMs = clampReconnectDelay(state.baseDelay * Math.pow(2, Math.min(state.attempts, 30)) + jitter, state.baseDelay);
    state.attempts++;
    return {
        kind: 'schedule',
        delayMs,
        attempt: state.attempts,
        loopAlert: state.attempts > 0 && state.attempts % exports.RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS === 0,
    };
}
