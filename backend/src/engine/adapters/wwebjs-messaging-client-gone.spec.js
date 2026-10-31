"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_messaging_1 = require("./wwebjs-messaging");
const wwebjs_status_1 = require("./wwebjs-status");
const logger_service_1 = require("../../common/services/logger.service");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const send_pacing_service_1 = require("../../modules/message/send-pacing.service");
/**
 * A teardown (logout, destroy, reconnect) nulls the adapter's client while a send is parked on an
 * await between ensureReady() and the sendMessage call: the recipient lookup, or a media fetch. The
 * host closure then hands the delegate that null as if it were a Client, so the send died as a
 * TypeError 500 and counted toward the send breaker. It answers the retryable not-ready 409 instead.
 */
const logger = (0, logger_service_1.createLogger)('wwebjs-messaging-client-gone.spec');
const CHAT = '628111@c.us';
// Base64 rather than a URL: a URL payload runs the real remote-media loader through the SSRF guard.
const IMAGE = {
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    mimetype: 'image/png',
};
function makeMessaging() {
    const sendMessage = jest.fn().mockResolvedValue({ id: { _serialized: 'M1' }, timestamp: 1 });
    let client = { sendMessage };
    const host = {
        ensureReady: jest.fn(),
        ensureNotChannelRecipient: jest.fn(),
        getClient: () => client,
        logger,
        config: {},
        // The recipient lookup is the await the teardown lands in.
        getNumberId: jest.fn(() => {
            client = null;
            return Promise.resolve(CHAT);
        }),
        capInboundMediaFor: jest.fn(),
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
    };
    return { messaging: new wwebjs_messaging_1.WwebjsMessaging(host), sendMessage };
}
describe('WwebjsMessaging when the client is torn down mid-send', () => {
    it.each([
        ['text', (m) => m.sendTextMessage(CHAT, 'hi')],
        ['image', (m) => m.sendImageMessage(CHAT, IMAGE)],
        ['location', (m) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2 })],
    ])('answers the not-ready 409 for a %s send, which the send breaker ignores', async (_kind, send) => {
        const { messaging, sendMessage } = makeMessaging();
        const error = await send(messaging).catch((e) => e);
        expect(error).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(sendMessage).not.toHaveBeenCalled();
        expect((0, send_pacing_service_1.countsTowardSendBreaker)(error)).toBe(false);
        expect((0, send_pacing_service_1.sentNothing)(error)).toBe(true);
    });
});
describe('WwebjsStatus when the client is torn down mid-post', () => {
    // A media status awaits its media before it reaches the client, so it has the same gap as a media send, and
    // a TypeError there reaches the status breaker as an account failure.
    it('answers the not-ready 409 for a media status, which the send breaker ignores', async () => {
        const sendMessage = jest.fn();
        let client = { sendMessage };
        const host = {
            // Readiness passes, then the teardown lands before the post reaches the client.
            ensureReady: jest.fn(() => {
                client = null;
            }),
            getClient: () => client,
            logger,
            config: {},
            isPageTransportError: () => false,
            reportIfPageTransportError: jest.fn(),
        };
        const error = await new wwebjs_status_1.WwebjsStatus(host).postImageStatus(IMAGE, {}).catch((e) => e);
        expect(error).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(sendMessage).not.toHaveBeenCalled();
        expect((0, send_pacing_service_1.countsTowardSendBreaker)(error)).toBe(false);
    });
});
