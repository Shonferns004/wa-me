"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
const engine_not_ready_error_1 = require("../../../common/errors/engine-not-ready.error");
const engine_send_failure_1 = require("../../../common/errors/engine-send-failure");
const engine_not_sent_error_1 = require("../../../common/errors/engine-not-sent.error");
const engine_throttled_error_1 = require("../../../common/errors/engine-throttled.error");
const engine_transport_error_1 = require("../../../common/errors/engine-transport.error");
const send_idempotency_interceptor_1 = require("./send-idempotency.interceptor");
const send_idempotency_service_1 = require("./send-idempotency.service");
describe('SendIdempotencyInterceptor', () => {
    let store;
    let interceptor;
    let setHeader;
    const contextFor = (headers, body = { chatId: 'c', text: 't' }, rawHeaders, sessionId = 's1') => {
        setHeader = jest.fn();
        return {
            getType: () => 'http',
            getHandler: () => ({ name: 'sendText' }),
            switchToHttp: () => ({
                getRequest: () => ({ headers, params: { sessionId }, body, rawHeaders }),
                getResponse: () => ({ setHeader }),
            }),
        };
    };
    beforeEach(() => {
        store = {
            claim: jest.fn().mockResolvedValue({ kind: 'claimed', id: 'row-1' }),
            complete: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined),
            markFailed: jest.fn().mockResolvedValue(undefined),
        };
        interceptor = new send_idempotency_interceptor_1.SendIdempotencyInterceptor(store);
    });
    const run = async (ctx, handler) => (0, rxjs_1.lastValueFrom)(await interceptor.intercept(ctx, { handle: () => handler() }));
    it('rejects duplicate raw headers even when Node joins their values', async () => {
        const handler = jest.fn(() => (0, rxjs_1.of)({}));
        await expect(run(contextFor({ 'idempotency-key': 'a, b' }, {}, ['Idempotency-Key', 'a', 'idempotency-key', 'b']), handler)).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(store.claim).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });
    it('passes a request without the header straight through, touching no storage', async () => {
        const out = await run(contextFor({}), () => (0, rxjs_1.of)({ messageId: 'm1' }));
        expect(out).toEqual({ messageId: 'm1' });
        expect(store.claim).not.toHaveBeenCalled();
    });
    it('claims (session, key) with the route and body hash, and stores the response on success', async () => {
        const body = { chatId: 'c', text: 't' };
        const out = await run(contextFor({ 'idempotency-key': 'k-1' }, body), () => (0, rxjs_1.of)({ messageId: 'm1' }));
        expect(out).toEqual({ messageId: 'm1' });
        expect(store.claim).toHaveBeenCalledWith({
            sessionId: 's1',
            key: 'k-1',
            route: 'sendText',
            requestHash: (0, send_idempotency_service_1.hashSendRequest)('sendText', body),
        });
        expect(store.complete).toHaveBeenCalledWith('row-1', { messageId: 'm1' });
    });
    it('leaves a path segment no session id can be to the handler, claiming nothing', async () => {
        const headers = { 'idempotency-key': 'k-1' };
        const out = await run(contextFor(headers, undefined, undefined, 'x'.repeat(256)), () => (0, rxjs_1.of)({ answered: 'by handler' }));
        expect(out).toEqual({ answered: 'by handler' });
        expect(store.claim).not.toHaveBeenCalled();
        await run(contextFor(headers, undefined, undefined, 'x'.repeat(255)), () => (0, rxjs_1.of)({}));
        expect(store.claim).toHaveBeenCalledTimes(1);
    });
    it('replays a completed key without running the send, marking the response', async () => {
        store.claim.mockResolvedValue({ kind: 'replay', body: { messageId: 'm1' } });
        const handler = jest.fn(() => (0, rxjs_1.of)({ messageId: 'NEW' }));
        const out = await run(contextFor({ 'idempotency-key': 'k-1' }), handler);
        expect(out).toEqual({ messageId: 'm1' });
        expect(handler).not.toHaveBeenCalled();
        expect(setHeader).toHaveBeenCalledWith('idempotent-replayed', 'true');
    });
    it.each([
        ['mismatch', common_1.UnprocessableEntityException, 'IDEMPOTENCY_KEY_REUSED'],
        ['in_progress', common_1.ConflictException, 'IDEMPOTENCY_KEY_IN_PROGRESS'],
        ['outcome_unknown', common_1.ConflictException, 'IDEMPOTENCY_OUTCOME_UNKNOWN'],
    ])('answers a %s claim with %p (%s) and never sends', async (kind, Exc, code) => {
        store.claim.mockResolvedValue({ kind });
        const handler = jest.fn(() => (0, rxjs_1.of)({}));
        const error = await run(contextFor({ 'idempotency-key': 'k-1' }), handler).catch((e) => e);
        expect(error).toBeInstanceOf(Exc);
        expect(error.getResponse()).toEqual(expect.objectContaining({ code }));
        expect(handler).not.toHaveBeenCalled();
    });
    it.each([[''], ['has space'], [['a', 'b']]])('refuses a malformed key %p with 400 before claiming', async (key) => {
        const error = await run(contextFor({ 'idempotency-key': key }), () => (0, rxjs_1.of)({})).catch((e) => e);
        expect(error).toBeInstanceOf(common_1.BadRequestException);
        expect(error.getResponse()).toEqual(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_INVALID' }));
        expect(store.claim).not.toHaveBeenCalled();
    });
    it('frees the key when the send was refused before reaching WhatsApp', async () => {
        const refusal = new engine_not_ready_error_1.EngineNotReadyError();
        await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => (0, rxjs_1.throwError)(() => refusal))).rejects.toBe(refusal);
        expect(store.release).toHaveBeenCalledWith('row-1');
        expect(store.markFailed).not.toHaveBeenCalled();
    });
    it('keeps the key taken when the send failed ambiguously', async () => {
        const boom = new Error('Evaluation failed');
        await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => (0, rxjs_1.throwError)(() => boom))).rejects.toBe(boom);
        expect(store.markFailed).toHaveBeenCalledWith('row-1');
        expect(store.release).not.toHaveBeenCalled();
    });
    it('releases the key when engine transport explicitly reports nothing was sent', async () => {
        const error = (0, engine_send_failure_1.markEngineSendFailure)(new engine_not_sent_error_1.EngineNotSentError('recipient lookup timed out'));
        await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => (0, rxjs_1.throwError)(() => error))).rejects.toBe(error);
        expect(store.release).toHaveBeenCalledWith('row-1');
        expect(store.markFailed).not.toHaveBeenCalled();
    });
    it('releases the key when WhatsApp rate-limited the request before it ran', async () => {
        const error = (0, engine_send_failure_1.markEngineSendFailure)(new engine_throttled_error_1.EngineThrottledError('WhatsApp rate-limited the send (code 429)'));
        await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => (0, rxjs_1.throwError)(() => error))).rejects.toBe(error);
        expect(store.release).toHaveBeenCalledWith('row-1');
        expect(store.markFailed).not.toHaveBeenCalled();
    });
    it('still answers the send when recording its outcome fails', async () => {
        store.complete.mockRejectedValue(new Error('db down'));
        await expect(run(contextFor({ 'idempotency-key': 'k-1' }), () => (0, rxjs_1.of)({ messageId: 'm1' }))).resolves.toEqual({
            messageId: 'm1',
        });
    });
});
describe('sendFailureProvesNothingSent', () => {
    it.each([new common_1.BadRequestException(), new engine_not_ready_error_1.EngineNotReadyError(), new common_1.NotImplementedException()])('keeps an engine-stage %p uncertain regardless of HTTP status', error => {
        expect((0, send_idempotency_interceptor_1.sendFailureProvesNothingSent)((0, engine_send_failure_1.markEngineSendFailure)(error))).toBe(false);
    });
    it.each([
        [new common_1.BadRequestException(), true],
        [new common_1.ConflictException(), true],
        [new common_1.UnprocessableEntityException(), true],
        [new common_1.NotImplementedException(), true],
        [new common_1.InternalServerErrorException(), false],
        [new common_1.ServiceUnavailableException(), false],
        [new Error('timeout'), false],
        ['string', false],
    ])('%p -> %p', (error, expected) => {
        expect((0, send_idempotency_interceptor_1.sendFailureProvesNothingSent)(error)).toBe(expected);
    });
    // Media the engine could not fetch or read is refused before anything reaches WhatsApp: the proof
    // outranks the engine-stage marker, and the error keeps its own status.
    it.each([new common_1.BadRequestException(), new common_1.PayloadTooLargeException(), new common_1.InternalServerErrorException()])('frees the key for an engine-stage %p raised before anything was sent', error => {
        expect((0, send_idempotency_interceptor_1.sendFailureProvesNothingSent)((0, engine_send_failure_1.markEngineSendFailure)((0, engine_not_sent_error_1.markNothingSent)(error)))).toBe(true);
    });
    it('frees the key for a WhatsApp rate limit, which turned the request away, but not for a timeout', () => {
        expect((0, send_idempotency_interceptor_1.sendFailureProvesNothingSent)((0, engine_send_failure_1.markEngineSendFailure)(new engine_throttled_error_1.EngineThrottledError('rate limited')))).toBe(true);
        expect((0, send_idempotency_interceptor_1.sendFailureProvesNothingSent)((0, engine_send_failure_1.markEngineSendFailure)(new engine_transport_error_1.EngineTransportError('timed out')))).toBe(false);
    });
    it('treats 501 as a refusal', () => {
        expect(common_1.HttpStatus.NOT_IMPLEMENTED).toBe(501);
    });
});
