"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const fs_1 = require("fs");
const path_1 = require("path");
const http_1 = require("http");
const zlib_1 = require("zlib");
const express_1 = __importStar(require("express"));
const inflight_body_budget_1 = require("./inflight-body-budget");
const MB = 1024 * 1024;
/** Minimal req/res doubles: real EventEmitters so the middleware's listener accounting runs as-is. */
const makeReq = (headers = {}) => {
    const req = new events_1.EventEmitter();
    req.headers = headers;
    req.socket = {
        bytesRead: 0,
        remoteAddress: '203.0.113.7',
    };
    req.destroy = jest.fn();
    return req;
};
const makeRes = () => {
    const state = { code: 0, payload: undefined };
    const headers = {};
    const res = Object.assign(new events_1.EventEmitter(), {
        headersSent: false,
        writableEnded: false,
        status(code) {
            state.code = code;
            return res;
        },
        set(name, value) {
            headers[name.toLowerCase()] = value;
            return res;
        },
        json(payload) {
            state.payload = payload;
            return res;
        },
    });
    return { res, headers, state };
};
const run = (budget, req) => {
    const mock = makeRes();
    const next = jest.fn();
    budget.middleware(req, mock.res, next);
    return { ...mock, next };
};
describe('parseBodyLimitBytes', () => {
    it('parses the formats resolveBodyLimit accepts, using binary units like the body parser', () => {
        expect((0, inflight_body_budget_1.parseBodyLimitBytes)('25mb')).toBe(25 * MB);
        expect((0, inflight_body_budget_1.parseBodyLimitBytes)('1024')).toBe(1024);
        expect((0, inflight_body_budget_1.parseBodyLimitBytes)('1.5gb')).toBe(1.5 * 1024 * MB);
        expect((0, inflight_body_budget_1.parseBodyLimitBytes)('10MB')).toBe(10 * MB);
        expect((0, inflight_body_budget_1.parseBodyLimitBytes)('512kb')).toBe(512 * 1024);
    });
    it('falls back to the 25 MiB default on an impossible value rather than throwing', () => {
        expect((0, inflight_body_budget_1.parseBodyLimitBytes)('not-a-limit')).toBe(25 * MB);
    });
});
describe('resolveInflightBodyBudgetBytes', () => {
    it('defaults to 4 × the default per-request cap (25 MiB → 100 MiB)', () => {
        expect((0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)(undefined, undefined)).toBe(100 * MB);
        expect((0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)('', '')).toBe(100 * MB);
    });
    it('scales with BODY_SIZE_LIMIT so tuning the per-request cap tunes the aggregate', () => {
        expect((0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)(undefined, '5mb')).toBe(20 * MB);
    });
    it('uses the default per-request cap when BODY_SIZE_LIMIT is unparseable (matches the parser)', () => {
        expect((0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)(undefined, 'unlimited')).toBe(100 * MB);
    });
    it('lets an explicit INFLIGHT_BODY_BUDGET_BYTES win over the derived default', () => {
        expect((0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)('123456', '5mb')).toBe(123456);
        expect((0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)('  2048  ', undefined)).toBe(2048);
    });
    it('ignores an invalid explicit value (env.validation rejects it at boot anyway)', () => {
        for (const bad of ['0', '-10', 'abc', '10.5']) {
            expect((0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)(bad, undefined)).toBe(100 * MB);
        }
    });
});
describe('createInflightBodyBudget middleware', () => {
    it('admits a request under budget and reserves its declared Content-Length', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        const { next, state } = run(budget, req);
        expect(next).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(400);
        expect(state.code).toBe(0); // no response written
    });
    it('does not attach a data listener when a Content-Length was declared (stream left untouched)', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        run(budget, req);
        expect(req.listenerCount('data')).toBe(0);
    });
    it('admits a request that lands exactly on the budget', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        run(budget, makeReq({ 'content-length': '600' }));
        const { next } = run(budget, makeReq({ 'content-length': '400' }));
        expect(next).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(1000);
    });
    it('rejects with 503 + Retry-After, without reading the body, when the declared size would exceed the budget', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        run(budget, makeReq({ 'content-length': '800' }));
        const rejected = makeReq({ 'content-length': '300' });
        const { res, headers, state, next } = run(budget, rejected);
        expect(next).not.toHaveBeenCalled();
        expect(state.code).toBe(503);
        expect(headers['retry-after']).toBe('1');
        expect(headers['connection']).toBe('close');
        expect(state.payload).toEqual({
            statusCode: 503,
            message: 'Too much request body data in flight; retry later',
            error: 'Service Unavailable',
        });
        // Nothing was reserved for the rejected request and its stream was never tapped.
        expect(budget.currentBytes()).toBe(800);
        expect(rejected.listenerCount('data')).toBe(0);
        expect(res.listenerCount('finish')).toBe(0);
    });
    it('answers 413 without Retry-After, on an idle server, for a declared body that could never be admitted', () => {
        // Default share 0.5 -> a 500-byte per-client cap: 600 bytes would never fit, however long the client waits.
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000);
        const rejected = makeReq({ 'content-length': '600' });
        const { res, headers, state, next } = run(budget, rejected);
        expect(next).not.toHaveBeenCalled();
        expect(state.code).toBe(413);
        expect(headers['retry-after']).toBeUndefined();
        expect(headers['connection']).toBe('close');
        expect(state.payload).toEqual({
            statusCode: 413,
            message: 'Request body exceeds what this server can accept',
            error: 'Payload Too Large',
        });
        expect(budget.currentBytes()).toBe(0);
        expect(res.listenerCount('finish')).toBe(0);
    });
    it('answers 413 for an unkeyed body declared above the whole budget', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { classify: () => undefined, bodyLimitBytes: 250 });
        const { state, headers } = run(budget, makeReq({ 'content-length': '1001' }));
        expect(state.code).toBe(413);
        expect(headers['retry-after']).toBeUndefined();
    });
    it('sends the configured Retry-After value', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(100, { retryAfterSeconds: 5, perClientShare: 1 });
        run(budget, makeReq({ 'content-length': '100' }));
        const { headers } = run(budget, makeReq({ 'content-length': '1' }));
        expect(headers['retry-after']).toBe('5');
    });
    it('admits a zero-length body even when the budget is fully used', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        run(budget, makeReq({ 'content-length': '1000' }));
        const { next } = run(budget, makeReq({ 'content-length': '0' }));
        expect(next).toHaveBeenCalledTimes(1);
    });
    it('releases the reservation exactly once on normal completion', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        const { res } = run(budget, req);
        res.emit('finish');
        expect(budget.currentBytes()).toBe(0);
        // Late terminal events from the same request must not double-decrement.
        res.emit('close');
        req.emit('close');
        expect(budget.currentBytes()).toBe(0);
    });
    it('releases exactly once on a client abort (request close before the response)', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        const { res } = run(budget, req);
        req.emit('close');
        expect(budget.currentBytes()).toBe(0);
        res.emit('finish');
        res.emit('close');
        req.emit('error', new Error('late'));
        expect(budget.currentBytes()).toBe(0);
    });
    it('releases on stream errors (request or response side)', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const reqA = makeReq({ 'content-length': '400' });
        run(budget, reqA);
        reqA.emit('error', new Error('boom'));
        expect(budget.currentBytes()).toBe(0);
        const reqB = makeReq({ 'content-length': '400' });
        const { res: resB } = run(budget, reqB);
        resB.emit('error', new Error('boom'));
        expect(budget.currentBytes()).toBe(0);
    });
    it('takes only an opening placeholder for chunk-encoded bodies and releases it on completion', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'transfer-encoding': 'chunked' });
        const { res, next } = run(budget, req);
        expect(next).toHaveBeenCalledTimes(1);
        // Capped by the budget here (1 MiB placeholder > the 1000-byte test budget); the poller
        // reconciles it against real bytes, so a chunked body is never priced at a full slot.
        expect(budget.currentBytes()).toBe(1000);
        // The middleware must never tap the stream: a 'data' listener would switch it to flowing
        // mode and eat chunks before a late consumer (busboy attaches only after async guards).
        expect(req.listenerCount('data')).toBe(0);
        res.emit('finish');
        expect(budget.currentBytes()).toBe(0);
    });
    it('does not price a small chunked body at a whole per-request slot', () => {
        // Regression: reserving budget/4 up front turned the byte budget into a concurrency limit of 4
        // for chunked senders — four 6-byte uploads refused every further body-carrying request.
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(64 * 1024 * 1024, { perClientShare: 1 });
        for (let i = 0; i < 8; i++) {
            const { next } = run(budget, makeReq({ 'transfer-encoding': 'chunked' }));
            expect(next).toHaveBeenCalledTimes(1);
        }
        expect(budget.currentBytes()).toBe(8 * 1024 * 1024); // 8 × the 1 MiB placeholder, not 8 × 16 MiB
    });
    it('still refuses an un-declared body once the aggregate is exhausted', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(2 * 1024 * 1024, { perClientShare: 1 });
        for (let i = 0; i < 2; i++) {
            expect(run(budget, makeReq({ 'transfer-encoding': 'chunked' })).next).toHaveBeenCalledTimes(1);
        }
        const third = run(budget, makeReq({ 'transfer-encoding': 'chunked' }));
        expect(third.next).not.toHaveBeenCalled();
        expect(third.state.code).toBe(503);
    });
    it('reserves nothing for requests with neither Content-Length nor Transfer-Encoding', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        run(budget, makeReq({ 'content-length': '1000' }));
        // No body expected (health checks, GETs): admitted even with the budget fully reserved.
        const req = makeReq();
        const { next } = run(budget, req);
        expect(next).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(1000);
        expect(req.listenerCount('data')).toBe(0);
    });
    describe('with the client map at capacity', () => {
        const fromIp = (ip, headers = {}) => {
            const req = makeReq(headers);
            req.socket.remoteAddress = ip;
            return req;
        };
        const saturated = () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1_000_000, { perClientShare: 1 });
            for (let i = 0; i < 10_000; i++) {
                const ip = `10.${Math.floor(i / 65536)}.${Math.floor(i / 256) % 256}.${i % 256}`;
                expect(run(budget, fromIp(ip, { 'content-length': '10' })).next).toHaveBeenCalledTimes(1);
            }
            expect(budget.currentBytes()).toBe(100_000);
            return budget;
        };
        it('still admits bodyless requests from a new client, without tracking them', () => {
            const budget = saturated();
            for (const headers of [{}, { 'content-length': '0' }]) {
                const req = fromIp('192.0.2.200', headers);
                const { next, state, res } = run(budget, req);
                expect(next).toHaveBeenCalledTimes(1);
                expect(state.code).toBe(0);
                expect(budget.clientBytes(req)).toBe(0);
                expect(req.listenerCount('close')).toBe(0);
                expect(res.listenerCount('finish')).toBe(0);
            }
            expect(budget.currentBytes()).toBe(100_000);
        });
        it('still refuses a body-carrying request from a new client', () => {
            const budget = saturated();
            const { next, state } = run(budget, fromIp('192.0.2.200', { 'content-length': '10' }));
            expect(next).not.toHaveBeenCalled();
            expect(state.code).toBe(503);
        });
    });
    it('drops the socket instead of writing a 503 when the response is already flushing', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        run(budget, makeReq({ 'content-length': '800' }));
        const req = makeReq({ 'content-length': '300' });
        const mock = makeRes();
        mock.res.headersSent = true;
        const next = jest.fn();
        expect(() => budget.middleware(req, mock.res, next)).not.toThrow();
        expect(next).not.toHaveBeenCalled();
        expect(req.destroy).toHaveBeenCalledTimes(1);
        expect(mock.state.code).toBe(0); // no second response attempted
        expect(budget.currentBytes()).toBe(800); // nothing reserved for the rejected request
    });
    it('reuses freed budget for the next request (no leak across a full lifecycle)', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        for (let i = 0; i < 5; i++) {
            const req = makeReq({ 'content-length': '900' });
            const { res, next } = run(budget, req);
            expect(next).toHaveBeenCalledTimes(1);
            res.emit('finish');
            expect(budget.currentBytes()).toBe(0);
        }
    });
});
describe('anonymous tier', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    // Budget 1000 with a 250-byte body cap: the anonymous pool is max(2 x 250, 25% of 1000) = 500,
    // each anonymous IP's share is 250 and each key's share is half the budget, 500.
    const tiered = () => {
        const classify = jest.fn((req) => {
            const key = req.headers['x-api-key'];
            return typeof key === 'string' ? `hash-${key}` : undefined;
        });
        return { budget: (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { classify, bodyLimitBytes: 250 }), classify };
    };
    const from = (ip, headers) => {
        const req = makeReq(headers);
        req.socket.remoteAddress = ip;
        return req;
    };
    it('keeps unrecognised requests inside their pool while a keyed request still gets in', () => {
        const { budget } = tiered();
        expect(run(budget, from('198.51.100.1', { 'content-length': '250' })).next).toHaveBeenCalledTimes(1);
        expect(run(budget, from('198.51.100.2', { 'content-length': '250' })).next).toHaveBeenCalledTimes(1);
        expect(budget.anonymousBytes()).toBe(500);
        // The aggregate has 500 free, but none of it is open to a third anonymous client.
        const refused = run(budget, from('198.51.100.3', { 'content-length': '10' }));
        expect(refused.next).not.toHaveBeenCalled();
        expect(refused.state.code).toBe(503);
        const keyed = run(budget, from('198.51.100.3', { 'content-length': '400', 'x-api-key': 'k1' }));
        expect(keyed.next).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(900);
        expect(budget.anonymousBytes()).toBe(500);
    });
    it('leaves room for other unkeyed senders while one client holds a full-size body (defaults)', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(100 * MB, { classify: () => undefined, bodyLimitBytes: 25 * MB });
        const big = run(budget, from('198.51.100.1', { 'content-length': String(25 * MB) }));
        expect(big.next).toHaveBeenCalledTimes(1);
        // The same client gets no more than one full-size body.
        expect(run(budget, from('198.51.100.1', { 'content-length': '2048' })).state.code).toBe(503);
        // A small delivery from another address (an ingress webhook, say) still gets in.
        const other = run(budget, from('203.0.113.9', { 'content-length': '2048' }));
        expect(other.next).toHaveBeenCalledTimes(1);
        expect(budget.anonymousBytes()).toBe(25 * MB + 2048);
    });
    it('charges an anonymous body no more than the body cap, so the parser can still answer 413', () => {
        const { budget } = tiered();
        const { next, res } = run(budget, from('198.51.100.1', { 'content-length': '900' }));
        expect(next).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(250);
        res.emit('finish');
        expect(budget.currentBytes()).toBe(0);
        expect(budget.anonymousBytes()).toBe(0);
    });
    it('shares per key across addresses, and per address never across keys', () => {
        const { budget } = tiered();
        expect(run(budget, from('198.51.100.1', { 'content-length': '400', 'x-api-key': 'k1' })).next).toHaveBeenCalled();
        const sameKey = run(budget, from('198.51.100.2', { 'content-length': '200', 'x-api-key': 'k1' }));
        expect(sameKey.state.code).toBe(503);
        const otherKey = run(budget, from('198.51.100.1', { 'content-length': '400', 'x-api-key': 'k2' }));
        expect(otherKey.next).toHaveBeenCalledTimes(1);
    });
    it('aborts an anonymous body whose growth crosses the pool, releasing every counter once', () => {
        // Budget 8 MiB, body cap 2 MiB: pool 4 MiB, 2 MiB per anonymous IP, 1 MiB chunked placeholder.
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(8 * MB, { classify: () => undefined, bodyLimitBytes: 2 * MB });
        const slow = from('198.51.100.1', { 'transfer-encoding': 'chunked' });
        const slowRes = run(budget, slow).res;
        const second = run(budget, from('198.51.100.2', { 'content-length': String(2 * MB) }));
        const third = run(budget, from('198.51.100.3', { 'content-length': String(MB) }));
        expect(second.next).toHaveBeenCalledTimes(1);
        expect(third.next).toHaveBeenCalledTimes(1);
        expect(budget.anonymousBytes()).toBe(4 * MB);
        // Within its own share and the aggregate, but past the pool.
        slow.socket.bytesRead = 1.5 * MB;
        jest.advanceTimersByTime(5_000);
        expect(slow.destroy).toHaveBeenCalledTimes(1);
        slow.emit('close');
        slowRes.emit('finish');
        expect(budget.anonymousBytes()).toBe(3 * MB);
        expect(budget.clientBytes(slow)).toBe(0);
        second.res.emit('finish');
        third.res.emit('finish');
        expect(budget.anonymousBytes()).toBe(0);
        expect(budget.currentBytes()).toBe(0);
    });
    it('does not classify a request without a body', () => {
        const { budget, classify } = tiered();
        run(budget, from('198.51.100.1', { 'x-api-key': 'k1' }));
        expect(classify).not.toHaveBeenCalled();
    });
    it('keeps one pool with per-IP shares when no classifier is given', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { bodyLimitBytes: 250 });
        expect(run(budget, from('198.51.100.1', { 'content-length': '400' })).next).toHaveBeenCalledTimes(1);
        expect(run(budget, from('198.51.100.2', { 'content-length': '400' })).next).toHaveBeenCalledTimes(1);
        expect(budget.anonymousBytes()).toBe(0);
    });
});
describe('stall reaper', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());
    const destroyMock = (req) => req.destroy;
    it('reaps a stalled declared-length connection and releases its reservation', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        run(budget, req);
        expect(budget.currentBytes()).toBe(400);
        // Headers sent, then silence: the reservation must not survive the stall timeout.
        jest.advanceTimersByTime(60_000);
        expect(destroyMock(req)).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(0);
        // The freed budget is immediately usable again.
        const { next } = run(budget, makeReq({ 'content-length': '400' }));
        expect(next).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(400);
    });
    it('reaps a stalled chunk-encoded connection the same way', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'transfer-encoding': 'chunked' });
        run(budget, req);
        expect(budget.currentBytes()).toBe(1000);
        jest.advanceTimersByTime(60_000);
        expect(destroyMock(req)).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(0);
    });
    it('reaps a body that stops after part of it arrived, long before the pace check would', () => {
        // 10 MiB of a 20 MiB body lands in the first seconds and then nothing does. The pace the request
        // timeout allows is still far below what has arrived, so only the stall rule can release it.
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(100 * MB, { perClientShare: 1 });
        const req = makeReq({ 'content-length': String(20 * MB) });
        run(budget, req);
        const socket = req.socket;
        jest.advanceTimersByTime(1_000);
        socket.bytesRead = 10 * MB;
        jest.advanceTimersByTime(5_000);
        expect(destroyMock(req)).not.toHaveBeenCalled();
        expect(budget.currentBytes()).toBe(20 * MB);
        // 15 s of silence since the poll that saw the last byte, plus one poll to notice it.
        jest.advanceTimersByTime(25_000);
        expect(destroyMock(req)).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(0);
    });
    it('does not reap a connection that keeps making progress, and keeps its declared size', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        run(budget, req);
        const socket = req.socket;
        // Well past the stall timeout in total, but never idle for a whole timeout window.
        for (let i = 0; i < 20; i++) {
            jest.advanceTimersByTime(4_000);
            socket.bytesRead += 10; // stays below the declared 400, so only progress keeps it alive
        }
        expect(destroyMock(req)).not.toHaveBeenCalled();
        expect(budget.currentBytes()).toBe(400);
        expect(budget.clientBytes(req)).toBe(400);
    });
    describe('reservation of a slow body', () => {
        const socketOf = (req) => req.socket;
        const trickle = (reqs, bytes, ms) => {
            for (let t = 0; t < ms; t += 1_000) {
                jest.advanceTimersByTime(1_000);
                if ((t + 1_000) % 4_000 === 0)
                    for (const r of reqs)
                        socketOf(r).bytesRead += bytes;
            }
        };
        it('drops a declared body that falls behind the pace the request timeout allows, releasing it once', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
            const req = makeReq({ 'content-length': '400' });
            const { res } = run(budget, req);
            // One byte every 4 s: never idle long enough for the stall reaper, far too slow to finish.
            trickle([req], 1, 20_000);
            expect(destroyMock(req)).toHaveBeenCalledTimes(1);
            expect(budget.currentBytes()).toBe(0);
            expect(budget.clientBytes(req)).toBe(0);
            // The terminal events the destroy triggers do not release it a second time.
            const other = makeReq({ 'content-length': '1000' });
            expect(run(budget, other).next).toHaveBeenCalledTimes(1);
            req.emit('close');
            res.emit('close');
            expect(budget.currentBytes()).toBe(1000);
        });
        it('keeps a declared body that arrives fast enough to finish within the request timeout', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(2000, { perClientShare: 1, requestTimeoutMs: 100_000 });
            const req = makeReq({ 'content-length': '1000' });
            run(budget, req);
            // 10 bytes/s finishes 1000 bytes in exactly the 100 s timeout.
            trickle([req], 40, 96_000);
            expect(destroyMock(req)).not.toHaveBeenCalled();
            expect(budget.currentBytes()).toBe(1000);
        });
        it('measures the pace against the configured request timeout', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(2000, { perClientShare: 1, requestTimeoutMs: 100_000 });
            const req = makeReq({ 'content-length': '1000' });
            run(budget, req);
            // Half the pace a 100 s timeout needs; the default 300 s timeout would still allow it.
            trickle([req], 20, 40_000);
            expect(destroyMock(req)).toHaveBeenCalledTimes(1);
            expect(budget.currentBytes()).toBe(0);
        });
        it('drops a chunked body that trickles below the pace its placeholder needs, releasing it once', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(2 * MB, { perClientShare: 1 });
            const req = makeReq({ 'transfer-encoding': 'chunked' });
            const { res } = run(budget, req);
            trickle([req], 1, 20_000);
            expect(destroyMock(req)).toHaveBeenCalledTimes(1);
            expect(budget.currentBytes()).toBe(0);
            expect(budget.clientBytes(req)).toBe(0);
            const other = makeReq({ 'content-length': String(2 * MB) });
            expect(run(budget, other).next).toHaveBeenCalledTimes(1);
            req.emit('close');
            res.emit('close');
            expect(budget.currentBytes()).toBe(2 * MB);
        });
        it('keeps a chunked body that stays on pace, and stops pacing it once it passes the placeholder', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(64 * MB, { perClientShare: 1, requestTimeoutMs: 100_000 });
            const req = makeReq({ 'transfer-encoding': 'chunked' });
            run(budget, req);
            // 10.5 KB/s delivers the 1 MiB placeholder inside the 100 s timeout, then keeps going past it.
            trickle([req], 42_000, 200_000);
            expect(destroyMock(req)).not.toHaveBeenCalled();
            expect(budget.currentBytes()).toBeGreaterThan(MB);
        });
        it('paces an anonymous chunked body against the smaller amount it is charged', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(MB, { classify: () => undefined, bodyLimitBytes: 64 * 1024 });
            const req = makeReq({ 'transfer-encoding': 'chunked' });
            run(budget, req);
            expect(budget.anonymousBytes()).toBe(64 * 1024);
            // 64 KiB in 300 s is about 220 B/s; 1 KiB every 4 s keeps up, 1 MiB in 300 s would not.
            trickle([req], 1024, 60_000);
            expect(destroyMock(req)).not.toHaveBeenCalled();
        });
        it('does not let trickling unkeyed chunked bodies hold the unkeyed pool past the pace window', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(100 * MB, { classify: () => undefined, bodyLimitBytes: 25 * MB });
            const held = [];
            for (const ip of ['198.51.100.1', '198.51.100.2']) {
                for (let i = 0; i < 25; i++) {
                    const req = makeReq({ 'transfer-encoding': 'chunked' });
                    socketOf(req).remoteAddress = ip;
                    expect(run(budget, req).next).toHaveBeenCalledTimes(1);
                    held.push(req);
                }
            }
            expect(budget.anonymousBytes()).toBe(50 * MB);
            const early = makeReq({ 'content-length': '2000' });
            socketOf(early).remoteAddress = '203.0.113.9';
            expect(run(budget, early).state.code).toBe(503);
            trickle(held, 1, 20_000);
            for (const r of held)
                expect(destroyMock(r)).toHaveBeenCalledTimes(1);
            expect(budget.anonymousBytes()).toBe(0);
            const late = makeReq({ 'content-length': '2000' });
            socketOf(late).remoteAddress = '203.0.113.9';
            expect(run(budget, late).next).toHaveBeenCalledTimes(1);
        });
        it('keeps a client share held by trickling requests', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000); // share 0.5 -> cap 500
            const a = makeReq({ 'content-length': '250' });
            const b = makeReq({ 'content-length': '250' });
            run(budget, a);
            run(budget, b);
            trickle([a, b], 1, 16_000);
            expect(budget.clientBytes(a)).toBe(500);
            expect(run(budget, makeReq({ 'content-length': '200' })).state.code).toBe(503);
            // Once they fall behind the pace the request timeout allows, both are dropped and the share frees.
            trickle([a, b], 1, 10_000);
            expect(destroyMock(a)).toHaveBeenCalledTimes(1);
            expect(destroyMock(b)).toHaveBeenCalledTimes(1);
            expect(budget.clientBytes(a)).toBe(0);
            expect(run(budget, makeReq({ 'content-length': '200' })).next).toHaveBeenCalledTimes(1);
        });
        it('never lets trickling bodies that complete together exceed the budget', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
            const live = [];
            // A new 200-byte body every second for two minutes, each trickling one byte every 4 s.
            for (let s = 1; s <= 120; s++) {
                const req = makeReq({ 'content-length': '200' });
                socketOf(req).remoteAddress = `198.51.100.${s}`;
                if (run(budget, req).next.mock.calls.length > 0)
                    live.push(req);
                jest.advanceTimersByTime(1_000);
                if (s % 4 === 0)
                    for (const r of live)
                        socketOf(r).bytesRead += 4;
            }
            // Every live body then lands before the next poll.
            for (const r of live) {
                socketOf(r).bytesRead = 200;
                r.complete = true;
            }
            jest.advanceTimersByTime(5_000);
            expect(budget.currentBytes()).toBeLessThanOrEqual(1000);
            expect(live).toHaveLength(5);
            for (const r of live)
                expect(destroyMock(r)).not.toHaveBeenCalled();
        });
        it('refuses a new body while a trickling one holds its declaration, and settles it at its size', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
            const req = makeReq({ 'content-length': '400' });
            const { res } = run(budget, req);
            trickle([req], 5, 16_000);
            expect(budget.currentBytes()).toBe(400);
            expect(run(budget, makeReq({ 'content-length': '900' })).state.code).toBe(503);
            // The rest of the body lands between polls and Node marks the message complete.
            socketOf(req).bytesRead = 400;
            req.complete = true;
            jest.advanceTimersByTime(5_000);
            expect(destroyMock(req)).not.toHaveBeenCalled();
            expect(budget.currentBytes()).toBe(400);
            res.emit('finish');
            expect(budget.currentBytes()).toBe(0);
        });
    });
    it('stops reaping once the declared body has fully arrived', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        const { res } = run(budget, req);
        req.socket.bytesRead = 400;
        jest.advanceTimersByTime(120_000); // body arrived; a slow handler is not a stalled sender
        expect(destroyMock(req)).not.toHaveBeenCalled();
        expect(budget.currentBytes()).toBe(400);
        res.emit('finish');
        expect(budget.currentBytes()).toBe(0);
    });
    it('stops reaping once the downstream consumer finished reading (end)', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'transfer-encoding': 'chunked' });
        const { res } = run(budget, req);
        // A finished chunked body keeps at least its opening placeholder until the request is released.
        req.socket.bytesRead = 300;
        req.emit('end');
        jest.advanceTimersByTime(120_000);
        expect(destroyMock(req)).not.toHaveBeenCalled();
        expect(budget.currentBytes()).toBe(1000);
        res.emit('finish');
        expect(budget.currentBytes()).toBe(0);
    });
    it('keeps pricing a chunked body that arrived with its headers while the handler still holds it', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'transfer-encoding': 'chunked' });
        // The middleware runs inside the parse of the read that carried the headers, so the socket counter
        // already includes a body sent in the same write: nothing more "arrives" after admission.
        req.socket.bytesRead = 600;
        const { res } = run(budget, req);
        req.emit('end');
        expect(budget.currentBytes()).toBe(1000);
        req.complete = true;
        jest.advanceTimersByTime(10_000);
        expect(budget.currentBytes()).toBe(1000);
        res.emit('finish');
        expect(budget.currentBytes()).toBe(0);
    });
    it('reconciles a chunked reservation with the bytes that actually arrive', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(64 * 1024 * 1024, { perClientShare: 1 });
        const req = makeReq({ 'transfer-encoding': 'chunked' });
        run(budget, req);
        expect(budget.currentBytes()).toBe(1024 * 1024); // opening placeholder
        const socket = req.socket;
        socket.bytesRead = 5 * 1024 * 1024;
        jest.advanceTimersByTime(5_000);
        expect(budget.currentBytes()).toBe(5 * 1024 * 1024); // now priced at its real weight
    });
    it('aborts an un-declared body that streams past the aggregate budget', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(2 * 1024 * 1024, { perClientShare: 1 });
        const req = makeReq({ 'transfer-encoding': 'chunked' });
        run(budget, req);
        req.socket.bytesRead = 3 * 1024 * 1024;
        jest.advanceTimersByTime(5_000);
        expect(destroyMock(req)).toHaveBeenCalledTimes(1);
        expect(budget.currentBytes()).toBe(0);
    });
    // The per-client share: the DoS bound is per ATTACKER, not per deployment. The spec doubles
    // share one remoteAddress, so every request here comes from the same client.
    describe('per-client share of the budget', () => {
        const runFrom = (budget, ip, headers) => {
            const req = makeReq(headers);
            req.socket = {
                bytesRead: 0,
                remoteAddress: ip,
            };
            return run(budget, req);
        };
        it('refuses a SECOND client request once that client holds its share, while a different client is still admitted', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000); // default share 0.5 -> cap 500
            const { next: firstOk } = runFrom(budget, '198.51.100.1', { 'content-length': '400' });
            expect(firstOk).toHaveBeenCalledTimes(1);
            // Same client, over its 500-byte share now.
            const { next: refused, state } = runFrom(budget, '198.51.100.1', { 'content-length': '200' });
            expect(refused).not.toHaveBeenCalled();
            expect(state.code).toBe(503);
            // A different client sails through - the whole aggregate is still theirs to use.
            const { next: other } = runFrom(budget, '198.51.100.2', { 'content-length': '400' });
            expect(other).toHaveBeenCalledTimes(1);
        });
        it('keys an IPv6 client on its /64, so a rotated address draws on the same share', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000);
            const { next: firstOk } = runFrom(budget, '2001:db8:1:2::a', { 'content-length': '400' });
            expect(firstOk).toHaveBeenCalledTimes(1);
            const { next: sameSubnet, state } = runFrom(budget, '2001:db8:1:2::b', { 'content-length': '200' });
            expect(sameSubnet).not.toHaveBeenCalled();
            expect(state.code).toBe(503);
            const probe = makeReq();
            probe.socket.remoteAddress = '2001:db8:1:2::ffff';
            expect(budget.clientBytes(probe)).toBe(400);
            const { next: otherSubnet } = runFrom(budget, '2001:db8:1:3::a', { 'content-length': '400' });
            expect(otherSubnet).toHaveBeenCalledTimes(1);
        });
        it('releases the client ledger exactly once: a finished body frees the share', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000);
            const { res } = runFrom(budget, '198.51.100.1', { 'content-length': '400' });
            res.emit('finish');
            const { next } = runFrom(budget, '198.51.100.1', { 'content-length': '400' });
            expect(next).toHaveBeenCalledTimes(1);
            expect(budget.clientBytes(makeReq())).toBe(0);
        });
        it('X-Forwarded-For is IGNORED without trusted proxies (share keys on the socket address)', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000);
            const reqA = makeReq({ 'content-length': '400', 'x-forwarded-for': '192.0.2.1' });
            const a = run(budget, reqA);
            const reqB = makeReq({ 'content-length': '400', 'x-forwarded-for': '192.0.2.2' });
            const b = run(budget, reqB);
            // Both share one socket address -> one share -> the second is over the cap.
            expect(a.next).toHaveBeenCalledTimes(1);
            expect(b.next).not.toHaveBeenCalled();
        });
        it('X-Forwarded-For keys the share when the proxy is trusted', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { trustedProxies: ['127.0.0.1'] });
            const base = { 'x-forwarded-for': '', 'content-length': '400' };
            const reqA = makeReq({ ...base, 'x-forwarded-for': '192.0.2.1' });
            reqA.socket = {
                bytesRead: 0,
                remoteAddress: '127.0.0.1',
            };
            const reqB = makeReq({ ...base, 'x-forwarded-for': '192.0.2.2' });
            reqB.socket = {
                bytesRead: 0,
                remoteAddress: '127.0.0.1',
            };
            expect(run(budget, reqA).next).toHaveBeenCalledTimes(1);
            expect(run(budget, reqB).next).toHaveBeenCalledTimes(1);
        });
        it('perClientShare: 1 restores single-client use of the whole budget', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
            expect(runFrom(budget, '198.51.100.1', { 'content-length': '600' }).next).toHaveBeenCalledTimes(1);
            expect(runFrom(budget, '198.51.100.1', { 'content-length': '400' }).next).toHaveBeenCalledTimes(1);
        });
        it('aborts a chunked body that crosses its client share mid-stream', () => {
            const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(10 * 1024 * 1024); // cap 5 MiB
            const req = makeReq({ 'transfer-encoding': 'chunked' });
            run(budget, req);
            req.socket.bytesRead = 6 * 1024 * 1024;
            jest.advanceTimersByTime(5_000);
            expect(destroyMock(req)).toHaveBeenCalledTimes(1);
            expect(budget.currentBytes()).toBe(0);
            expect(budget.clientBytes(req)).toBe(0);
        });
    });
    it('does not reap a fully-received request whose body no parser consumed', () => {
        // The body can arrive in the same segment as the headers, so socket.bytesRead never moves again
        // and 'end' never fires when no parser reads the stream. Killing that request at the stall
        // timeout would drop a healthy connection mid-handler.
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const req = makeReq({ 'content-length': '400' });
        const { res } = run(budget, req);
        req.complete = true;
        jest.advanceTimersByTime(120_000);
        expect(destroyMock(req)).not.toHaveBeenCalled();
        expect(budget.currentBytes()).toBe(400);
        res.emit('finish');
        expect(budget.currentBytes()).toBe(0);
    });
    it('never arms the reaper for requests without a body', () => {
        const budget = (0, inflight_body_budget_1.createInflightBodyBudget)(1000, { perClientShare: 1 });
        const getReq = makeReq();
        const emptyReq = makeReq({ 'content-length': '0' });
        run(budget, getReq);
        run(budget, emptyReq);
        jest.advanceTimersByTime(120_000);
        expect(destroyMock(getReq)).not.toHaveBeenCalled();
        expect(destroyMock(emptyReq)).not.toHaveBeenCalled();
    });
});
/**
 * Compressed bodies, exercised over a REAL server with a RAW http client. The doubles above hand the
 * middleware a header bag and never move a byte, so they cannot show what a compressed body costs
 * once the parser inflates it. A raw client (rather than an assertion library) is deliberate: the
 * exact bytes on the wire are the subject here, and a serializer that helpfully re-encodes a Buffer
 * would test itself instead of the middleware.
 */
describe('compressed request bodies', () => {
    const BUDGET = 64 * 1024;
    /** Compresses ~1000:1, so its declared length is a small fraction of what inflating it costs. */
    const INFLATED_PAYLOAD = Buffer.from(JSON.stringify({ data: 'a'.repeat(2 * MB) }));
    let server;
    let budget;
    let port = 0;
    const listen = async () => {
        budget = (0, inflight_body_budget_1.createInflightBodyBudget)(BUDGET);
        const app = (0, express_1.default)();
        app.use(budget.middleware);
        app.use((0, express_1.json)({ limit: '25mb' }));
        app.post('/echo', (_req, res) => {
            res.status(200).json({ ok: true });
        });
        server = (0, http_1.createServer)(app);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        port = server.address().port;
    };
    /**
     * Resolves on the response even when the server drops the socket mid-upload — which is exactly
     * what a refusal does here (it answers, sets Connection: close and never reads the body), so a
     * client that treated the reset as fatal could not observe the status it is meant to assert.
     */
    const send = (headers, body) => new Promise((resolve, reject) => {
        let reply;
        const req = (0, http_1.request)({ host: '127.0.0.1', port, path: '/echo', method: 'POST', headers }, res => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                reply = { status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() };
                resolve(reply);
            });
        });
        req.on('error', (error) => {
            if (reply)
                return;
            // A refusal answers and drops the socket without reading the body, so the reset can beat
            // the parsed response. Settle with a sentinel rather than swallowing it: a bare timeout
            // would report as "test timed out" instead of "expected 415, got a connection reset".
            if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
                resolve({ status: 0, body: '' });
                return;
            }
            reject(error);
        });
        req.end(body);
    });
    beforeEach(() => jest.useRealTimers());
    afterEach(async () => {
        if (server)
            await new Promise(resolve => server.close(() => resolve()));
        server = undefined;
    });
    it('refuses a gzip-encoded body with 415 instead of admitting it on its compressed length', async () => {
        await listen();
        const gzipped = (0, zlib_1.gzipSync)(INFLATED_PAYLOAD);
        // The premise: compressed, this body is small enough to sail through admission control.
        expect(gzipped.length).toBeLessThan(BUDGET);
        expect(INFLATED_PAYLOAD.length).toBeGreaterThan(BUDGET);
        const reply = await send({
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': String(gzipped.length),
        }, gzipped);
        expect(reply.status).toBe(415);
        expect(JSON.parse(reply.body)).toEqual({
            statusCode: 415,
            message: 'Compressed request bodies are not supported',
            error: 'Unsupported Media Type',
        });
        expect(budget.currentBytes()).toBe(0);
    });
    it('refuses an oversized UNCOMPRESSED body through the budget, not the encoding guard', async () => {
        await listen();
        const plain = Buffer.alloc(BUDGET + 1, 0x20);
        const reply = await send({ 'Content-Type': 'application/json', 'Content-Length': String(plain.length) }, plain);
        // Larger than the whole budget, so it could never be admitted: 413, not a retryable 503.
        expect(reply.status).toBe(413);
    });
    it('refuses a compressed body whose Content-Length is zero', async () => {
        await listen();
        // `reserved` is 0 here, so a gate keyed on the reservation would wave this through to the
        // parser and the client would get body-parser's HTML error instead of the documented shape.
        const reply = await send({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '0' }, Buffer.alloc(0));
        expect(reply.status).toBe(415);
        expect(JSON.parse(reply.body).error).toBe('Unsupported Media Type');
    });
    it('refuses a compressed body whose Content-Length is not a safe integer', async () => {
        await listen();
        const gzipped = (0, zlib_1.gzipSync)(INFLATED_PAYLOAD);
        // parseDeclaredLength refuses to reserve for this, but type-is `hasBody` still hands it to the
        // parser — the one shape that escaped both the reservation AND admission control.
        const reply = await send({
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
            'Content-Length': String(Number.MAX_SAFE_INTEGER + 2),
        }, gzipped);
        expect(reply.status).toBe(415);
        expect(JSON.parse(reply.body).error).toBe('Unsupported Media Type');
    });
    it('refuses an encoding LIST, matching what the parser would do with it', async () => {
        await listen();
        const plain = Buffer.from(JSON.stringify({ data: 'small' }));
        // "identity, identity" transforms nothing, but body-parser compares the whole header against
        // 'identity' and refuses it — so the middleware refuses it too and both layers answer the same
        // documented shape instead of disagreeing about who rejects it.
        const reply = await send({
            'Content-Type': 'application/json',
            'Content-Encoding': 'identity, identity',
            'Content-Length': String(plain.length),
        }, plain);
        expect(reply.status).toBe(415);
        expect(JSON.parse(reply.body).error).toBe('Unsupported Media Type');
    });
    it('admits an ordinary body declaring Content-Encoding: identity', async () => {
        await listen();
        const plain = Buffer.from(JSON.stringify({ data: 'small' }));
        const reply = await send({
            'Content-Type': 'application/json',
            'Content-Encoding': 'identity',
            'Content-Length': String(plain.length),
        }, plain);
        expect(reply.status).toBe(200);
    });
});
/**
 * The `inflate: false` backstop is unreachable while the guard above stands, so no behavioural test
 * can lock it — yet it is the only thing standing if the guard is ever bypassed. Assert it in the
 * source instead, the way load-env.spec.ts locks main.js's import order.
 */
describe('body-parser inflate backstop', () => {
    const read = (relative) => (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, relative), 'utf8');
    it('disables inflate on both global parsers', () => {
        // The parsers live in configure-app.ts, which is where the production stack is assembled; they
        // sat inline in main.ts until that stack was extracted so the e2e lane could run it too.
        const source = read('../configure-app.js');
        expect(source.match(/^\s+inflate: false,$/gm)).toHaveLength(2);
    });
    it('mirrors the global cap and disabled inflate on the MCP route-level fallback parser', () => {
        expect(read('../modules/mcp/mcp.server.js')).toContain('express_1.default.json({ limit: bodyLimit, inflate: false })');
    });
});
