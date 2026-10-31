"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const request_context_middleware_1 = require("./request-context.middleware");
const request_context_1 = require("../services/request-context");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function makeReqRes(headers = {}) {
    const req = { header: (name) => headers[name.toLowerCase()] };
    const setHeaders = {};
    const res = { setHeader: (name, value) => void (setHeaders[name] = value) };
    return { req, res, setHeaders };
}
describe('requestContextMiddleware', () => {
    it('generates a UUID when no X-Request-ID header is supplied', () => {
        const { req, res, setHeaders } = makeReqRes();
        (0, request_context_middleware_1.requestContextMiddleware)(req, res, () => undefined);
        expect(setHeaders['X-Request-ID']).toMatch(UUID_RE);
    });
    it('echoes a valid client-supplied X-Request-ID', () => {
        const { req, res, setHeaders } = makeReqRes({ 'x-request-id': 'trace-abc-123' });
        (0, request_context_middleware_1.requestContextMiddleware)(req, res, () => undefined);
        expect(setHeaders['X-Request-ID']).toBe('trace-abc-123');
    });
    it('replaces an invalid X-Request-ID (CRLF injection attempt) with a generated UUID', () => {
        const { req, res, setHeaders } = makeReqRes({ 'x-request-id': 'bad\r\nInject: yes' });
        (0, request_context_middleware_1.requestContextMiddleware)(req, res, () => undefined);
        expect(setHeaders['X-Request-ID']).not.toContain('\r');
        expect(setHeaders['X-Request-ID']).toMatch(UUID_RE);
    });
    it('runs downstream next() inside the request scope (getRequestId resolves the id)', () => {
        const { req, res } = makeReqRes({ 'x-request-id': 'trace-xyz' });
        let seen;
        (0, request_context_middleware_1.requestContextMiddleware)(req, res, () => void (seen = (0, request_context_1.getRequestId)()));
        expect(seen).toBe('trace-xyz');
    });
    it('clears the request scope after next() returns (no leak across requests)', () => {
        const { req, res } = makeReqRes({ 'x-request-id': 'trace-xyz' });
        (0, request_context_middleware_1.requestContextMiddleware)(req, res, () => undefined);
        expect((0, request_context_1.getRequestId)()).toBeUndefined();
    });
});
