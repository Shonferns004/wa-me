"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = require("http");
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
const sharp_1 = __importDefault(require("sharp"));
const message_send_service_1 = require("./message-send.service");
const message_entity_1 = require("./entities/message.entity");
const session_service_1 = require("../session/session.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const hooks_1 = require("../../core/hooks");
const template_service_1 = require("../template/template.service");
const send_pacing_service_1 = require("./send-pacing.service");
const send_idempotency_key_entity_1 = require("./entities/send-idempotency-key.entity");
const send_idempotency_service_1 = require("./idempotency/send-idempotency.service");
const send_idempotency_interceptor_1 = require("./idempotency/send-idempotency.interceptor");
const baileys_messaging_1 = require("../../engine/adapters/baileys-messaging");
const whatsapp_web_js_adapter_1 = require("../../engine/adapters/whatsapp-web-js.adapter");
const engine_not_sent_error_1 = require("../../common/errors/engine-not-sent.error");
const ssrf_guard_1 = require("../../common/security/ssrf-guard");
const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
/**
 * A send the gateway refuses before anything reaches WhatsApp (a media or preview image it cannot fetch or
 * read) frees its Idempotency-Key, keeping its status and body, so the identical retry runs again instead of
 * answering 409 IDEMPOTENCY_OUTCOME_UNKNOWN. Real service, real interceptor on a SQLite store, real Baileys
 * messaging code with real sharp, and the real loader against a local server.
 */
describe('a keyed send refused before anything reaches WhatsApp', () => {
    let server;
    let base;
    let handler;
    let service;
    let repository;
    let release;
    let ds;
    let interceptor;
    let sock;
    let prepareWAMessageMedia;
    let proxy;
    let truncatedJpeg;
    let engines;
    /** A local port nothing listens on, so a fetch to it fails to connect. */
    let closedPort;
    const servePng = () => {
        handler = (_req, res) => res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_BYTES);
    };
    beforeAll(async () => {
        await (0, baileys_messaging_1.blockSvgDecoding)();
        server = (0, http_1.createServer)((req, res) => handler(req, res));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        const full = await (0, sharp_1.default)({
            create: {
                width: 600,
                height: 300,
                channels: 3,
                background: '#000000',
                noise: { type: 'gaussian', mean: 128, sigma: 30 },
            },
        })
            .jpeg()
            .toBuffer();
        truncatedJpeg = full.subarray(0, Math.floor(full.length / 3));
        const spare = (0, http_1.createServer)();
        await new Promise(resolve => spare.listen(0, '127.0.0.1', resolve));
        closedPort = spare.address().port;
        await new Promise(resolve => spare.close(() => resolve()));
    });
    afterAll(async () => {
        server.closeAllConnections();
        await new Promise(resolve => server.close(() => resolve()));
    });
    beforeEach(async () => {
        process.env.SIMULATE_TYPING = 'false';
        process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
        proxy = undefined;
        servePng();
        repository = {
            create: jest.fn().mockImplementation((d) => ({ id: 'row-1', ...d })),
            save: jest.fn().mockImplementation((m) => Promise.resolve(m)),
            findOne: jest.fn().mockResolvedValue(null),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
        };
        sock = {
            onWhatsApp: jest.fn((jid) => Promise.resolve([{ jid, exists: true }])),
            sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
            waUploadToServer: jest.fn(),
        };
        prepareWAMessageMedia = jest
            .fn()
            .mockResolvedValue({ imageMessage: { directPath: '/d', jpegThumbnail: new Uint8Array([1]) } });
        const host = {
            ensureReady: () => undefined,
            sessionProxyUrl: () => proxy,
            getSocket: () => sock,
            getSocketOrNull: () => sock,
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
        const messaging = new baileys_messaging_1.BaileysMessaging(host);
        engines = new engine_registry_service_1.EngineRegistry();
        engines.set('sess-1', {
            sendTextMessage: (...args) => messaging.sendTextMessage(...args),
            sendImageMessage: (...args) => messaging.sendImageMessage(...args),
            sendStickerMessage: (...args) => messaging.sendStickerMessage(...args),
        });
        release = jest.fn();
        const module = await testing_1.Test.createTestingModule({
            providers: [
                message_send_service_1.MessageSendService,
                {
                    provide: send_pacing_service_1.SendPacingService,
                    useValue: {
                        assertSendAllowed: jest.fn().mockResolvedValue(release),
                        recordSendFailure: jest.fn(),
                        recordSendSuccess: jest.fn(),
                    },
                },
                { provide: (0, typeorm_1.getRepositoryToken)(message_entity_1.Message, 'data'), useValue: repository },
                { provide: session_service_1.SessionService, useValue: { findOne: jest.fn().mockResolvedValue({ id: 'sess-1' }) } },
                { provide: engine_registry_service_1.EngineRegistry, useValue: engines },
                {
                    provide: hooks_1.HookManager,
                    useValue: { execute: jest.fn((_e, data) => Promise.resolve({ continue: true, data })) },
                },
                { provide: template_service_1.TemplateService, useValue: { resolve: jest.fn() } },
            ],
        }).compile();
        service = module.get(message_send_service_1.MessageSendService);
        ds = new typeorm_2.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [send_idempotency_key_entity_1.SendIdempotencyKey],
            synchronize: true,
        });
        await ds.initialize();
        interceptor = new send_idempotency_interceptor_1.SendIdempotencyInterceptor(new send_idempotency_service_1.SendIdempotencyService(ds.getRepository(send_idempotency_key_entity_1.SendIdempotencyKey)));
    });
    afterEach(async () => {
        delete process.env.SIMULATE_TYPING;
        delete process.env.SSRF_ALLOWED_HOSTS;
        await ds.destroy();
    });
    const withKey = async (route, body) => {
        const context = {
            getType: () => 'http',
            getHandler: () => ({ name: route }),
            switchToHttp: () => ({
                getRequest: () => ({ headers: { 'idempotency-key': 'k-1' }, params: { sessionId: 'sess-1' }, body }),
                getResponse: () => ({ setHeader: jest.fn() }),
            }),
        };
        const send = () => service[route]('sess-1', body);
        return (0, rxjs_1.lastValueFrom)(await interceptor.intercept(context, { handle: () => (0, rxjs_1.from)(send()) }));
    };
    const failure = (route, body) => withKey(route, body).then(() => {
        throw new Error('expected the send to fail');
    }, (error) => error);
    const keyState = async () => (await ds.getRepository(send_idempotency_key_entity_1.SendIdempotencyKey).findOneBy({ idempotencyKey: 'k-1' }))?.state ?? 'absent';
    const failedRowWritten = () => repository.update.mock.calls.some(([, change]) => change.status === message_entity_1.MessageStatus.FAILED);
    const previewBody = (image) => ({
        chatId: '628123456789@c.us',
        text: 'see https://example.com',
        customLinkPreview: { url: 'https://example.com', title: 'Example', ...image },
    });
    const streamBytes = (n) => {
        handler = (_req, res) => {
            res.writeHead(200, { 'content-type': 'image/png' });
            const chunk = Buffer.alloc(64 * 1024);
            let left = n;
            const pump = () => {
                while (left > 0) {
                    const part = chunk.subarray(0, Math.min(chunk.length, left));
                    left -= part.length;
                    if (!res.write(part))
                        return void res.once('drain', pump);
                }
                res.end();
            };
            pump();
        };
    };
    /** [label, image, status, message, whether serving a valid image lets the identical retry succeed] */
    const refusals = [
        [
            'unreadable base64 bytes',
            () => ({ thumbnailBase64: Buffer.from('hello, not an image').toString('base64') }),
            400,
            /could not be read as an image/,
            false,
        ],
        [
            'a truncated base64 JPEG',
            () => ({ thumbnailBase64: truncatedJpeg.toString('base64') }),
            400,
            /could not be read as an image/,
            false,
        ],
        [
            'a thumbnailUrl body over 5 MiB',
            () => (streamBytes(5 * 1024 * 1024 + 1), { thumbnailUrl: `${base}/big.png` }),
            413,
            /exceeds the 5242880-byte limit/,
            true,
        ],
        [
            'a thumbnailUrl answering 404',
            () => ((handler = (_req, res) => res.writeHead(404).end()), { thumbnailUrl: `${base}/gone.png` }),
            400,
            /status 404/,
            true,
        ],
        [
            'a thumbnailUrl the SSRF guard blocks',
            () => ({ thumbnailUrl: 'http://10.0.0.1/a.png' }),
            400,
            ssrf_guard_1.SSRF_BLOCKED_CLIENT_MESSAGE,
            false,
        ],
        [
            'a thumbnailUrl whose connection fails without a proxy',
            () => ({ thumbnailUrl: `http://127.0.0.1:${closedPort}/a.png` }),
            400,
            /^Media fetch failed$/,
            false,
        ],
    ];
    it.each(refusals)('send-text with %s keeps its status and frees the key; the identical retry runs again', async (_label, image, status, message, fixable) => {
        const body = previewBody(image());
        const error = await failure('sendText', body);
        expect(error).toBeInstanceOf(common_1.HttpException);
        expect(error.getStatus()).toBe(status);
        expect(error.message).toMatch(message);
        expect(sock.sendMessage).not.toHaveBeenCalled();
        expect(prepareWAMessageMedia).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
        // Unchanged, as for the session proxy's 503: the PENDING row is kept as FAILED and its admission counted.
        expect(failedRowWritten()).toBe(true);
        expect(release).toHaveBeenCalledWith(true);
        if (fixable) {
            servePng();
            await expect(withKey('sendText', body)).resolves.toMatchObject({ messageId: 'M1' });
            expect(sock.sendMessage).toHaveBeenCalledTimes(1);
            expect(await keyState()).toBe('completed');
        }
        else {
            const again = await failure('sendText', body);
            expect(again.getStatus()).toBe(status);
            expect(await keyState()).toBe('absent');
        }
    });
    it('send-text with a base64 image over 5 MiB is refused by the service: no row, admission refunded', async () => {
        const error = await failure('sendText', previewBody({ thumbnailBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') }));
        expect(error).toBeInstanceOf(common_1.PayloadTooLargeException);
        expect(release).toHaveBeenCalledWith(false);
        expect(failedRowWritten()).toBe(false);
        expect(await keyState()).toBe('absent');
    });
    it('send-text whose thumbnailUrl fetch fails at the session proxy answers 503 and frees the key', async () => {
        proxy = 'http://127.0.0.1:1';
        const error = await failure('sendText', previewBody({ thumbnailUrl: `${base}/a.png` }));
        expect(error).toBeInstanceOf(engine_not_sent_error_1.EngineNotSentError);
        expect(sock.sendMessage).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
    });
    it('send-text whose socket reconnects during the preview image fetch frees the key; the retry sends', async () => {
        const before = sock;
        const after = { ...sock, sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M2' }, messageTimestamp: 1 }) };
        handler = (_req, res) => {
            sock = after;
            res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_BYTES);
        };
        const body = previewBody({ thumbnailUrl: `${base}/a.png` });
        const error = await failure('sendText', body);
        expect(error.getStatus()).toBe(409);
        expect(before.sendMessage).not.toHaveBeenCalled();
        expect(after.sendMessage).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
        servePng();
        await expect(withKey('sendText', body)).resolves.toMatchObject({ messageId: 'M2' });
    });
    it('send-image whose url answers 404 frees the key on Baileys; the retry sends once the url works', async () => {
        handler = (_req, res) => res.writeHead(404).end();
        const body = { chatId: '628123456789@c.us', url: `${base}/photo.png`, mimetype: 'image/png' };
        const error = await failure('sendImage', body);
        expect(error).toBeInstanceOf(common_1.BadRequestException);
        expect(sock.sendMessage).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
        servePng();
        await expect(withKey('sendImage', body)).resolves.toMatchObject({ messageId: 'M1' });
    });
    it('send-image whose url answers 404 frees the key on whatsapp-web.js, before the page is asked', async () => {
        const adapter = new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({
            sessionId: 'sess-1',
            sessionDataPath: './data/sessions',
            puppeteer: {},
        });
        const client = { sendMessage: jest.fn() };
        adapter.status = whatsapp_engine_interface_1.EngineStatus.READY;
        adapter.client = client;
        engines.set('sess-1', adapter);
        handler = (_req, res) => res.writeHead(404).end();
        const error = await failure('sendImage', { chatId: '628123456789@c.us', url: `${base}/photo.png` });
        expect(error).toBeInstanceOf(common_1.BadRequestException);
        expect(client.sendMessage).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
    });
    it.each([
        ['bytes that do not decode', 'image/png', Buffer.from('nope'), /could not be converted to WebP/],
        ['a type that is no image', 'application/pdf', Buffer.from('%PDF-1.4'), /Received 'application\/pdf'/],
    ])('send-sticker with %s keeps its 400 and frees the key on Baileys', async (_label, mimetype, bytes, message) => {
        const body = { chatId: '628123456789@c.us', base64: bytes.toString('base64'), mimetype };
        const error = await failure('sendSticker', body);
        expect(error).toBeInstanceOf(common_1.BadRequestException);
        expect(error.message).toMatch(message);
        expect(sock.sendMessage).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
        expect(await failure('sendSticker', body)).toBeInstanceOf(common_1.BadRequestException);
    });
    // Control: a failure from the socket itself proves nothing, so the key stays taken.
    it('keeps the key when the socket send itself fails', async () => {
        sock.sendMessage.mockRejectedValue(new Error('socket write failed'));
        const body = previewBody({ thumbnailBase64: PNG_BYTES.toString('base64') });
        await failure('sendText', body);
        expect(await keyState()).toBe('failed');
        await expect(withKey('sendText', body)).rejects.toMatchObject({
            response: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' },
        });
    });
});
