"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const common_1 = require("@nestjs/common");
const rxjs_1 = require("rxjs");
const message_send_service_1 = require("../../modules/message/message-send.service");
const message_entity_1 = require("../../modules/message/entities/message.entity");
const session_service_1 = require("../../modules/session/session.service");
const engine_registry_service_1 = require("../engine-registry.service");
const hooks_1 = require("../../core/hooks");
const template_service_1 = require("../../modules/template/template.service");
const send_pacing_service_1 = require("../../modules/message/send-pacing.service");
const send_idempotency_key_entity_1 = require("../../modules/message/entities/send-idempotency-key.entity");
const send_idempotency_service_1 = require("../../modules/message/idempotency/send-idempotency.service");
const send_idempotency_interceptor_1 = require("../../modules/message/idempotency/send-idempotency.interceptor");
const baileys_messaging_1 = require("./baileys-messaging");
/**
 * Baileys refuses a phone number WhatsApp reports as unregistered after its number check, and a quoted message
 * the store does not hold before the send starts; both come before the message content is built and before
 * sock.sendMessage, so nothing reached WhatsApp. The keyed send then frees its Idempotency-Key, as it does for
 * the other refusals raised in that window, and the identical retry runs again. Real service, real interceptor
 * on a SQLite store and real Baileys messaging code.
 */
describe('a keyed Baileys send refused before its message is built', () => {
    let service;
    let ds;
    let interceptor;
    let sock;
    let body;
    let stored;
    beforeEach(async () => {
        process.env.SIMULATE_TYPING = 'false';
        body = { chatId: '628123456789@c.us', text: 'hello' };
        stored = null;
        sock = {
            onWhatsApp: jest.fn().mockResolvedValue([]),
            sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
        };
        const host = {
            ensureReady: () => undefined,
            sessionProxyUrl: () => undefined,
            getSocket: () => sock,
            getSocketOrNull: () => sock,
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            toNeutralJid: (j) => j.replace('@s.whatsapp.net', '@c.us'),
            toEngineJid: (j) => j.replace('@c.us', '@s.whatsapp.net'),
            normalizedSelfJid: () => '628177@s.whatsapp.net',
            getEphemeralExpiration: () => undefined,
            toUnixSeconds: () => 1,
            loadLib: () => Promise.resolve({}),
            putStoredMessage: () => undefined,
            recordMessage: () => undefined,
            rememberOwnSend: () => undefined,
            recordLidMapping: () => undefined,
            getOnMessageCreate: () => undefined,
            getStoredMessage: () => Promise.resolve(stored),
            pendingEditOf: () => undefined,
            wasDeletedForEveryone: () => false,
        };
        const messaging = new baileys_messaging_1.BaileysMessaging(host);
        const engines = new engine_registry_service_1.EngineRegistry();
        engines.set('sess-1', {
            sendTextMessage: (...args) => messaging.sendTextMessage(...args),
            replyToMessage: (...args) => messaging.replyToMessage(...args),
            forwardMessage: (...args) => messaging.forwardMessage(...args),
        });
        const module = await testing_1.Test.createTestingModule({
            providers: [
                message_send_service_1.MessageSendService,
                {
                    provide: send_pacing_service_1.SendPacingService,
                    useValue: {
                        assertSendAllowed: jest.fn().mockResolvedValue(jest.fn()),
                        recordSendFailure: jest.fn(),
                        recordSendSuccess: jest.fn(),
                    },
                },
                {
                    provide: (0, typeorm_1.getRepositoryToken)(message_entity_1.Message, 'data'),
                    useValue: {
                        create: jest.fn().mockImplementation((d) => ({ id: 'row-1', ...d })),
                        save: jest.fn().mockImplementation((m) => Promise.resolve(m)),
                        findOne: jest.fn().mockResolvedValue(null),
                        update: jest.fn().mockResolvedValue({ affected: 1 }),
                    },
                },
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
        await ds.destroy();
    });
    const keyed = async (handler, request, run) => {
        const context = {
            getType: () => 'http',
            getHandler: () => ({ name: handler }),
            switchToHttp: () => ({
                getRequest: () => ({ headers: { 'idempotency-key': 'k-1' }, params: { sessionId: 'sess-1' }, body: request }),
                getResponse: () => ({ setHeader: jest.fn() }),
            }),
        };
        return (0, rxjs_1.lastValueFrom)(await interceptor.intercept(context, { handle: () => (0, rxjs_1.from)(run()) }));
    };
    const withKey = () => keyed('sendText', body, () => service.sendText('sess-1', body));
    const keyState = async () => (await ds.getRepository(send_idempotency_key_entity_1.SendIdempotencyKey).findOneBy({ idempotencyKey: 'k-1' }))?.state ?? 'absent';
    it('to a number WhatsApp reports as unregistered keeps its 400, frees the key, and the identical retry runs the send again', async () => {
        await expect(withKey()).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(sock.sendMessage).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
        // The number is registered by the time the client retries with the same key.
        sock.onWhatsApp.mockImplementation((jid) => Promise.resolve([{ jid, exists: true }]));
        await expect(withKey()).resolves.toMatchObject({ messageId: 'M1' });
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
    });
    it('with a quotedMessageId the store does not hold keeps its 404 and frees the key', async () => {
        sock.onWhatsApp.mockImplementation((jid) => Promise.resolve([{ jid, exists: true }]));
        body = { chatId: '628123456789@c.us', text: 'hello', quotedMessageId: '3EB0UNKNOWN' };
        await expect(withKey()).rejects.toMatchObject({ status: 404 });
        expect(sock.sendMessage).not.toHaveBeenCalled();
        expect(await keyState()).toBe('absent');
    });
    it('with a reply or forward naming a message stored under another chat keeps its 404 and frees the key', async () => {
        sock.onWhatsApp.mockImplementation((jid) => Promise.resolve([{ jid, exists: true }]));
        stored = {
            key: { id: 'Q1', remoteJid: '628999000111@s.whatsapp.net', fromMe: false },
            message: { conversation: 'q' },
        };
        const reply = { chatId: '628123456789@c.us', quotedMessageId: 'Q1', text: 'hello' };
        const forward = { fromChatId: '628123456789@c.us', toChatId: '628123456789@c.us', messageId: 'Q1' };
        await expect(keyed('reply', reply, () => service.reply('sess-1', reply))).rejects.toMatchObject({ status: 404 });
        expect(await keyState()).toBe('absent');
        await expect(keyed('forward', forward, () => service.forward('sess-1', forward))).rejects.toMatchObject({
            status: 404,
        });
        expect(await keyState()).toBe('absent');
        expect(sock.sendMessage).not.toHaveBeenCalled();
    });
    it('keeps the key of a send that failed once the message was handed to the socket', async () => {
        sock.onWhatsApp.mockImplementation((jid) => Promise.resolve([{ jid, exists: true }]));
        sock.sendMessage.mockRejectedValue(new Error('relay failed'));
        await expect(withKey()).rejects.toThrow();
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
        expect(await keyState()).toBe('failed');
    });
});
