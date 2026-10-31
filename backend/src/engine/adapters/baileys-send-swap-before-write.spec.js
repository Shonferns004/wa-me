"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const baileys_messaging_1 = require("./baileys-messaging");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const engine_send_failure_1 = require("../../common/errors/engine-send-failure");
const send_idempotency_interceptor_1 = require("../../modules/message/idempotency/send-idempotency.interceptor");
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const fakeSock = (id) => ({
    onWhatsApp: jest.fn((jid) => Promise.resolve([{ jid, exists: true }])),
    sendMessage: jest.fn().mockResolvedValue({ key: { id }, messageTimestamp: 1 }),
    waUploadToServer: jest.fn(),
});
/**
 * A Baileys send refuses with 409 when its socket was replaced (a reconnect, or a logout and a relink) while
 * it waited, and never moves to the new socket. Found before sock.sendMessage is called, that 409 proves
 * nothing was sent, so a keyed send frees its Idempotency-Key; found after, it proves nothing.
 */
describe('a Baileys send whose socket is replaced while it waits', () => {
    let server;
    let base;
    let oldSock;
    let newSock;
    let current;
    let messaging;
    /** The interceptor's own decision on an error escaping the engine call, which the send service marks. */
    const freesKey = (error) => (0, send_idempotency_interceptor_1.sendFailureProvesNothingSent)((0, engine_send_failure_1.markEngineSendFailure)(error));
    /** What a close followed by a reconnect leaves behind: the session holds a different socket. */
    const reconnect = () => {
        current = newSock;
    };
    const failureOf = (promise) => promise.then(() => {
        throw new Error('expected the send to fail');
    }, (error) => error);
    beforeAll(async () => {
        await (0, baileys_messaging_1.blockSvgDecoding)();
        server = (0, http_1.createServer)((_req, res) => {
            // The connection drops and the reconnect lands while the image is still downloading.
            reconnect();
            res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_BYTES);
        });
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
    });
    beforeEach(() => {
        process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
        oldSock = fakeSock('OLD');
        newSock = fakeSock('NEW');
        current = oldSock;
        const prepareWAMessageMedia = jest
            .fn()
            .mockResolvedValue({ imageMessage: { directPath: '/d', jpegThumbnail: new Uint8Array([1]) } });
        const host = {
            ensureReady: () => undefined,
            sessionProxyUrl: () => undefined,
            getSocket: () => {
                if (!current)
                    throw new engine_not_ready_error_1.EngineNotReadyError();
                return current;
            },
            getSocketOrNull: () => current,
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            toNeutralJid: (j) => j.replace('@s.whatsapp.net', '@c.us'),
            toEngineJid: (j) => j.replace('@c.us', '@s.whatsapp.net'),
            normalizedSelfJid: () => '628177@s.whatsapp.net',
            getEphemeralExpiration: () => undefined,
            toUnixSeconds: () => 1,
            loadLib: () => Promise.resolve({ prepareWAMessageMedia }),
            putStoredMessage: () => undefined,
            recordMessage: () => undefined,
            rememberOwnSend: () => undefined,
            recordLidMapping: () => undefined,
            getOnMessageCreate: () => undefined,
        };
        messaging = new baileys_messaging_1.BaileysMessaging(host);
    });
    afterEach(() => {
        delete process.env.SSRF_ALLOWED_HOSTS;
    });
    const sendText = (chatId, thumbnailUrl) => messaging.sendTextMessage(chatId, 'see https://example.com', undefined, {
        customPreview: { url: 'https://example.com', title: 'Example', ...(thumbnailUrl ? { thumbnailUrl } : {}) },
    });
    it.each([
        ['a phone number', '628123456789@c.us'],
        ['a group', '120363000000000000@g.us'],
    ])('frees the key after a reconnect during the preview image fetch to %s', async (_label, chatId) => {
        const error = await failureOf(sendText(chatId, `${base}/a.png`));
        expect(error).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(oldSock.sendMessage).not.toHaveBeenCalled();
        expect(newSock.sendMessage).not.toHaveBeenCalled();
        expect(freesKey(error)).toBe(true);
    });
    it('frees the key after a reconnect while the recipient lookup was answered', async () => {
        oldSock.onWhatsApp.mockImplementation((jid) => {
            reconnect();
            return Promise.resolve([{ jid, exists: true }]);
        });
        const error = await failureOf(sendText('628123456789@c.us'));
        expect(error).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(newSock.sendMessage).not.toHaveBeenCalled();
        expect(freesKey(error)).toBe(true);
    });
    it('frees the key after a reconnect under a recipient lookup that failed', async () => {
        oldSock.onWhatsApp.mockImplementation(() => {
            reconnect();
            return Promise.reject(new Error('Connection Closed'));
        });
        const error = await failureOf(sendText('628123456789@c.us'));
        expect(error).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(freesKey(error)).toBe(true);
    });
    // The message may have been written before the socket went: that 409 still keeps the key.
    it('keeps the key for a swap found after sock.sendMessage was called', async () => {
        oldSock.sendMessage.mockImplementation(() => {
            reconnect();
            return Promise.reject(new Error('Connection Closed'));
        });
        const error = await failureOf(sendText('628123456789@c.us'));
        expect(error).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(oldSock.sendMessage).toHaveBeenCalledTimes(1);
        expect(freesKey(error)).toBe(false);
    });
});
