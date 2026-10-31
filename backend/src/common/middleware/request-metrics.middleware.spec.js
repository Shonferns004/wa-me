"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
jest.mock('../metrics/request-metrics', () => ({
    recordHttpRequest: jest.fn(),
    renderHttpRequestMetrics: jest.fn(() => []),
    resetHttpRequestMetrics: jest.fn(),
}));
const request_metrics_middleware_1 = require("./request-metrics.middleware");
const request_metrics_1 = require("../metrics/request-metrics");
const mockedRecord = request_metrics_1.recordHttpRequest;
function makeReqRes(opts) {
    const req = {
        method: opts.method ?? 'GET',
        route: opts.routePath ? { path: opts.routePath } : undefined,
    };
    const listeners = {};
    const res = {
        statusCode: opts.statusCode ?? 200,
        on: (event, cb) => {
            listeners[event] = cb;
        },
    };
    const next = jest.fn();
    (0, request_metrics_middleware_1.requestMetricsBoundaryMiddleware)(req, res, next);
    return { req, listeners, next };
}
describe('requestMetricsBoundaryMiddleware', () => {
    beforeEach(() => mockedRecord.mockClear());
    it('calls next() immediately (never blocks the chain)', () => {
        const { next } = makeReqRes({ routePath: '/api/sessions' });
        expect(next).toHaveBeenCalledTimes(1);
    });
    it.each([401, 403, 429])('records an unclaimed request rejected by a guard with its final status (%i)', statusCode => {
        const { listeners } = makeReqRes({ routePath: '/api/sessions', statusCode });
        listeners.finish?.();
        expect(mockedRecord).toHaveBeenCalledTimes(1);
        const [method, route, status, seconds] = mockedRecord.mock.calls[0];
        expect(method).toBe('GET');
        expect(route).toBe('/api/sessions');
        expect(status).toBe(statusCode);
        expect(seconds).toBeGreaterThanOrEqual(0);
    });
    it('skips a request claimed by the interceptor (no double-count on requests that pass the guards)', () => {
        const { req, listeners } = makeReqRes({ routePath: '/api/sessions', statusCode: 200 });
        (0, request_metrics_middleware_1.claimHttpRequestMetrics)(req);
        listeners.finish?.();
        expect(mockedRecord).not.toHaveBeenCalled();
    });
    it('skips /api/health and /api/metrics even when unclaimed', () => {
        for (const path of ['/api/health', '/api/health/live', '/api/metrics']) {
            const { listeners } = makeReqRes({ routePath: path });
            listeners.finish?.();
            expect(mockedRecord).not.toHaveBeenCalled();
            mockedRecord.mockClear();
        }
    });
    it('collapses unmatched routes (404) into one constant label', () => {
        const { listeners } = makeReqRes({ routePath: undefined, statusCode: 404 });
        listeners.finish?.();
        expect(mockedRecord).toHaveBeenCalledTimes(1);
        expect(mockedRecord.mock.calls[0][1]).toBe('(unmatched)');
        expect(mockedRecord.mock.calls[0][2]).toBe(404);
    });
    it('records once even if both finish and close fire', () => {
        const { listeners } = makeReqRes({ routePath: '/api/sessions', statusCode: 401 });
        listeners.finish?.();
        listeners.close?.();
        expect(mockedRecord).toHaveBeenCalledTimes(1);
    });
    it('claim marker lives on the request object under the shared symbol', () => {
        const { req } = makeReqRes({ routePath: '/api/sessions' });
        expect(req[request_metrics_middleware_1.HTTP_REQUEST_METRICS_CLAIMED]).toBeUndefined();
        (0, request_metrics_middleware_1.claimHttpRequestMetrics)(req);
        expect(req[request_metrics_middleware_1.HTTP_REQUEST_METRICS_CLAIMED]).toBe(true);
    });
});
