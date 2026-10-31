"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_scope_1 = require("./session-scope");
// The key's allowedSessions is authoritative: a query-supplied sessionId may only NARROW within it,
// never broaden it. null = "no filter (see all)"; [] = "requested session outside scope, see nothing".
describe('resolveSessionScope', () => {
    it('unrestricted key (null/empty/undefined allowlist) with no requested session => no filter', () => {
        expect((0, session_scope_1.resolveSessionScope)(null)).toBeNull();
        expect((0, session_scope_1.resolveSessionScope)([])).toBeNull();
        expect((0, session_scope_1.resolveSessionScope)(undefined)).toBeNull();
    });
    it('unrestricted key narrows to the requested session', () => {
        expect((0, session_scope_1.resolveSessionScope)(null, 'X')).toEqual(['X']);
        expect((0, session_scope_1.resolveSessionScope)([], 'X')).toEqual(['X']);
    });
    it('scoped key with no requested session => the whole allowlist', () => {
        expect((0, session_scope_1.resolveSessionScope)(['A', 'B'])).toEqual(['A', 'B']);
    });
    it('scoped key narrows to a requested session that is inside its allowlist', () => {
        expect((0, session_scope_1.resolveSessionScope)(['A', 'B'], 'A')).toEqual(['A']);
    });
    it('scoped key requesting a session OUTSIDE its allowlist => empty (match nothing), not the request', () => {
        expect((0, session_scope_1.resolveSessionScope)(['A', 'B'], 'C')).toEqual([]);
    });
});
// sessionScopeVisible fences resources whose session binding travels in a body field or a persisted
// row (plugin instances), which the guard's route-param fence cannot reach. null/'*' = all sessions.
describe('sessionScopeVisible', () => {
    it('unrestricted key (null/empty/undefined allowlist) sees every scope', () => {
        expect((0, session_scope_1.sessionScopeVisible)(null, 'A')).toBe(true);
        expect((0, session_scope_1.sessionScopeVisible)([], 'A')).toBe(true);
        expect((0, session_scope_1.sessionScopeVisible)(undefined, null)).toBe(true);
        expect((0, session_scope_1.sessionScopeVisible)(null, null)).toBe(true);
        expect((0, session_scope_1.sessionScopeVisible)(null, '*')).toBe(true);
    });
    it('scoped key sees resources bound to one of its own sessions only', () => {
        expect((0, session_scope_1.sessionScopeVisible)(['A', 'B'], 'A')).toBe(true);
        expect((0, session_scope_1.sessionScopeVisible)(['A', 'B'], 'C')).toBe(false);
    });
    it('scoped key never sees the all-sessions scope (null/undefined/*)', () => {
        expect((0, session_scope_1.sessionScopeVisible)(['A'], null)).toBe(false);
        expect((0, session_scope_1.sessionScopeVisible)(['A'], undefined)).toBe(false);
        expect((0, session_scope_1.sessionScopeVisible)(['A'], '*')).toBe(false);
    });
});
