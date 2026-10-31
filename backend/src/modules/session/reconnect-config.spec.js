"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const reconnect_policy_1 = require("./reconnect-policy");
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
// an OPERATOR-supplied session.config flows into the reconnect backoff math unchecked.
// config:{reconnectBaseDelay:'x'} makes the delay NaN -> setTimeout(fn, NaN) fires at 0 (relaunch
// storm); config:{maxReconnectAttempts:'x'} would poison the terminal guard (`n >= NaN` is always
// false). These helpers coerce + clamp the config so the math is always finite and bounded.
describe('resolveReconnectConfig', () => {
    it('defaults to a 5000ms base delay and UNLIMITED attempts for absent or empty config', () => {
        // A long-lived session must keep retrying forever (the backoff parks at the 5-minute cap) instead of
        // dying permanently after ~2.5 minutes like the old 5-attempt default did.
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)(null)).toEqual({ baseDelay: 5000, maxAttempts: Number.POSITIVE_INFINITY });
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({})).toEqual({ baseDelay: 5000, maxAttempts: Number.POSITIVE_INFINITY });
    });
    it('falls back to the defaults for non-numeric (NaN) values', () => {
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ reconnectBaseDelay: 'x', maxReconnectAttempts: 'y' })).toEqual({
            baseDelay: 5000,
            maxAttempts: Number.POSITIVE_INFINITY,
        });
    });
    it('treats null, undefined and blank values as unset, the way GET /config reports them', () => {
        // GET /config reports the unlimited default as maxReconnectAttempts: null, so a client copying it into a
        // create body sends that null; Number(null) is 0, which would disable reconnect and floor the delay.
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: null, reconnectBaseDelay: null })).toEqual({
            baseDelay: 5000,
            maxAttempts: Number.POSITIVE_INFINITY,
        });
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: undefined, reconnectBaseDelay: undefined })).toEqual({
            baseDelay: 5000,
            maxAttempts: Number.POSITIVE_INFINITY,
        });
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: '', reconnectBaseDelay: '  ' })).toEqual({
            baseDelay: 5000,
            maxAttempts: Number.POSITIVE_INFINITY,
        });
    });
    it('keeps coercing numeric strings a create body may have stored', () => {
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: '5', reconnectBaseDelay: '8000' })).toEqual({
            baseDelay: 8000,
            maxAttempts: 5,
        });
    });
    it('clamps a huge baseDelay down to the 5-minute max (no infinite-timer wedge)', () => {
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ reconnectBaseDelay: 1e15 }).baseDelay).toBe(300_000);
    });
    it('clamps a negative/too-small baseDelay up to the 1s min (no immediate relaunch)', () => {
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ reconnectBaseDelay: -5 }).baseDelay).toBe(1000);
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ reconnectBaseDelay: 0 }).baseDelay).toBe(1000);
    });
    it('floors a fractional baseDelay that a row stored before validation may hold', () => {
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ reconnectBaseDelay: 2500.5 }).baseDelay).toBe(2500);
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ reconnectBaseDelay: '2500.9' }).baseDelay).toBe(2500);
    });
    it('clamps an explicit maxAttempts to the 0..20 range and floors fractions', () => {
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: 999 }).maxAttempts).toBe(20);
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: -3 }).maxAttempts).toBe(0);
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: 3.9 }).maxAttempts).toBe(3);
    });
    it('preserves a legitimate maxReconnectAttempts: 0 (disable reconnect) instead of forcing the default', () => {
        expect((0, session_engine_lifecycle_service_1.resolveReconnectConfig)({ maxReconnectAttempts: 0 }).maxAttempts).toBe(0);
    });
});
describe('clampReconnectDelay', () => {
    it('passes a finite delay through, flooring at 0', () => {
        expect((0, reconnect_policy_1.clampReconnectDelay)(8000, 5000)).toBe(8000);
        expect((0, reconnect_policy_1.clampReconnectDelay)(-1, 5000)).toBe(0);
    });
    it('falls back to baseDelay for a non-finite delay (NaN from a poisoned config)', () => {
        expect((0, reconnect_policy_1.clampReconnectDelay)(NaN, 5000)).toBe(5000);
    });
    it('caps the exponential so it never exceeds setTimeout range and fires immediately', () => {
        expect((0, reconnect_policy_1.clampReconnectDelay)(1e15, 5000)).toBe(300_000);
    });
});
