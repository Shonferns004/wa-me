"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
jest.mock('../metrics/request-metrics', () => ({
    recordHttpRequest: jest.fn(),
    renderHttpRequestMetrics: jest.fn(() => []),
    resetHttpRequestMetrics: jest.fn(),
}));
const rxjs_1 = require("rxjs");
const request_metrics_interceptor_1 = require("./request-metrics.interceptor");
const request_metrics_1 = require("../metrics/request-metrics");
const request_metrics_middleware_1 = require("../middleware/request-metrics.middleware");
const mockedRecord = request_metrics_1.recordHttpRequest;
function makeContext(opts) {
    const req = { method: opts.method ?? 'GET', route: opts.routePath ? { path: opts.routePath } : undefined };
    const listeners = {};
    const res = {
        statusCode: opts.statusCode ?? 200,
        on: (event, cb) => {
            listeners[event] = cb;
        },
    };
    const ctx = {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
        getClass: () => ({ name: opts.className ?? 'SessionController' }),
        getHandler: () => ({ name: opts.handlerName ?? 'list' }),
    };
    return { ctx, req, listeners };
}
const noopHandler = { handle: () => new rxjs_1.Observable() };
describe('RequestMetricsInterceptor', () => {
    beforeEach(() => mockedRecord.mockClear());
    it('records on response finish with method/route/status and a duration', () => {
        const { ctx, listeners } = makeContext({ method: 'GET', routePath: '/api/sessions', statusCode: 200 });
        new request_metrics_interceptor_1.RequestMetricsInterceptor().intercept(ctx, noopHandler);
        listeners.finish?.();
        expect(mockedRecord).toHaveBeenCalledTimes(1);
        const [method, route, status, seconds] = mockedRecord.mock.calls[0];
        expect(method).toBe('GET');
        expect(route).toBe('/api/sessions');
        expect(status).toBe(200);
        expect(seconds).toBeGreaterThanOrEqual(0);
    });
    it('skips /api/health and /api/metrics entirely (no observation, no listener)', () => {
        for (const path of ['/api/health', '/api/health/live', '/api/metrics']) {
            const { ctx, listeners } = makeContext({ routePath: path });
            new request_metrics_interceptor_1.RequestMetricsInterceptor().intercept(ctx, noopHandler);
            listeners.finish?.();
            expect(mockedRecord).not.toHaveBeenCalled();
            mockedRecord.mockClear();
        }
    });
    it('records the final status set by exception filters (e.g. 500)', () => {
        const { ctx, listeners } = makeContext({ routePath: '/api/sessions', statusCode: 500 });
        new request_metrics_interceptor_1.RequestMetricsInterceptor().intercept(ctx, noopHandler);
        listeners.finish?.();
        expect(mockedRecord.mock.calls[0][2]).toBe(500);
    });
    it('falls back to Controller#handler when the Express route is unavailable', () => {
        const { ctx, listeners } = makeContext({
            routePath: undefined,
            className: 'MessageController',
            handlerName: 'sendText',
        });
        new request_metrics_interceptor_1.RequestMetricsInterceptor().intercept(ctx, noopHandler);
        listeners.finish?.();
        expect(mockedRecord.mock.calls[0][1]).toBe('MessageController#sendText');
    });
    it('records once even if both finish and close fire', () => {
        const { ctx, listeners } = makeContext({ routePath: '/api/sessions' });
        new request_metrics_interceptor_1.RequestMetricsInterceptor().intercept(ctx, noopHandler);
        listeners.finish?.();
        listeners.close?.();
        expect(mockedRecord).toHaveBeenCalledTimes(1);
    });
    it('claims the request so the boundary middleware does not record it a second time', () => {
        const { ctx, req } = makeContext({ routePath: '/api/sessions' });
        new request_metrics_interceptor_1.RequestMetricsInterceptor().intercept(ctx, noopHandler);
        expect(req[request_metrics_middleware_1.HTTP_REQUEST_METRICS_CLAIMED]).toBe(true);
    });
    it('does NOT claim skipped prefixes — nothing records those at all', () => {
        const { ctx, req } = makeContext({ routePath: '/api/health' });
        new request_metrics_interceptor_1.RequestMetricsInterceptor().intercept(ctx, noopHandler);
        expect(req[request_metrics_middleware_1.HTTP_REQUEST_METRICS_CLAIMED]).toBeUndefined();
    });
});
