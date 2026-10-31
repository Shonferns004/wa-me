"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_timeouts_1 = require("./http-timeouts");
describe('resolveRequestTimeoutMs', () => {
    it("defaults to Node's 300 s and honours REQUEST_TIMEOUT_MS", () => {
        expect((0, http_timeouts_1.resolveRequestTimeoutMs)(undefined)).toBe(300000);
        expect((0, http_timeouts_1.resolveRequestTimeoutMs)('')).toBe(300000);
        expect((0, http_timeouts_1.resolveRequestTimeoutMs)('120000')).toBe(120000);
    });
});
describe('applyHttpTimeouts', () => {
    const sink = () => ({ requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0 });
    it('writes requestTimeout, headersTimeout, and keepAliveTimeout onto the server from the config', () => {
        const s = sink();
        (0, http_timeouts_1.applyHttpTimeouts)(s, { requestTimeoutMs: 300000, headersTimeoutMs: 70000, keepAliveTimeoutMs: 5000 });
        expect(s.requestTimeout).toBe(300000);
        expect(s.headersTimeout).toBe(70000);
        expect(s.keepAliveTimeout).toBe(5000);
    });
    it('keeps a valid headersTimeout (> keepAliveTimeout) unchanged', () => {
        const s = sink();
        (0, http_timeouts_1.applyHttpTimeouts)(s, { requestTimeoutMs: 300000, headersTimeoutMs: 65000, keepAliveTimeoutMs: 5000 });
        expect(s.headersTimeout).toBe(65000);
    });
    it('auto-bumps headersTimeout above keepAliveTimeout when misconfigured (Node requires headers > keepAlive)', () => {
        const s = sink();
        (0, http_timeouts_1.applyHttpTimeouts)(s, { requestTimeoutMs: 300000, headersTimeoutMs: 5000, keepAliveTimeoutMs: 5000 });
        expect(s.headersTimeout).toBeGreaterThan(s.keepAliveTimeout);
    });
    it('reports the resolved (post-bump) values so boot can log what was actually applied', () => {
        const report = (0, http_timeouts_1.applyHttpTimeouts)(sink(), {
            requestTimeoutMs: 300000,
            headersTimeoutMs: 5000,
            keepAliveTimeoutMs: 5000,
        });
        expect(report.requestTimeoutMs).toBe(300000);
        expect(report.keepAliveTimeoutMs).toBe(5000);
        expect(report.headersTimeoutMs).toBeGreaterThan(report.keepAliveTimeoutMs);
    });
});
