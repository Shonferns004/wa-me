"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const crypto_1 = require("crypto");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("typeorm");
const message_entity_1 = require("./entities/message.entity");
const session_entity_1 = require("../session/entities/session.entity");
const message_send_service_1 = require("./message-send.service");
const message_service_1 = require("./message.service");
const send_pacing_service_1 = require("./send-pacing.service");
const message_projector_service_1 = require("../session/message-projector.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const hooks_1 = require("../../core/hooks");
// Every outgoing row of one account names the same sender, whichever writer stored it: the REST send
// path, or the own-send echo of a message composed on the linked phone. The `from` filter of the message
// list matches a sender by its JID forms, so a row that names the account some other way drops out of it.
// Runs on SQLite, and on the postgres:16 service when DATABASE_TYPE=postgres.
describe('the sender stored on an outgoing row', () => {
    const PHONE = '628123456789';
    const OWN_JID = `${PHONE}@c.us`;
    const CHAT = '628987654321@c.us';
    let db;
    let messages;
    let sessions;
    let engines;
    let engine;
    let sender;
    let projector;
    let list;
    let sessionId;
    const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const flush = async () => {
        for (let i = 0; i < 25; i++)
            await new Promise(resolve => setImmediate(resolve));
        if (db.options.type === 'postgres')
            await pause(150);
    };
    beforeEach(async () => {
        process.env.SIMULATE_TYPING = 'false';
        db = new typeorm_1.DataSource(process.env.DATABASE_TYPE === 'postgres'
            ? {
                type: 'postgres',
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 5432),
                username: process.env.DATABASE_USERNAME || 'openwa',
                password: process.env.DATABASE_PASSWORD || 'openwa',
                database: process.env.DATABASE_NAME || 'openwa',
                schema: `outgoing_sender_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`,
                entities: [session_entity_1.Session, message_entity_1.Message],
                synchronize: false,
            }
            : { type: 'better-sqlite3', database: ':memory:', entities: [session_entity_1.Session, message_entity_1.Message], synchronize: true });
        await db.initialize();
        if (db.options.type === 'postgres') {
            await db.query(`CREATE SCHEMA "${db.options.schema}"`);
            await db.synchronize();
        }
        messages = db.getRepository(message_entity_1.Message);
        sessions = db.getRepository(session_entity_1.Session);
        const session = await sessions.save({ name: 'acct', phone: PHONE });
        sessionId = session.id;
        engines = new engine_registry_service_1.EngineRegistry();
        engine = {
            sendTextMessage: jest.fn().mockResolvedValue({ id: 'WA_FROM_API', timestamp: 1_700_000_100 }),
        };
        engines.set(sessionId, engine);
        const hooks = new hooks_1.HookManager();
        const pacing = new send_pacing_service_1.SendPacingService(messages, sessions, new config_1.ConfigService({}));
        sender = new message_send_service_1.MessageSendService(messages, { findOne: (id) => sessions.findOneByOrFail({ id }) }, engines, hooks, {}, pacing);
        projector = new message_projector_service_1.MessageProjector(messages, sessions, engines, new Proxy({}, { get: () => () => undefined }), { dispatch: jest.fn().mockResolvedValue(undefined) }, hooks, { ingest: jest.fn() }, { resolveSenderPhone: jest.fn().mockResolvedValue(null) });
        list = new message_service_1.MessageService(messages, engines, projector, hooks, {
            findLidsForPhone: () => Promise.resolve([]),
            findPhoneForLid: () => Promise.resolve(null),
        }, pacing, sender);
    });
    afterEach(async () => {
        delete process.env.SIMULATE_TYPING;
        if (db.options.type === 'postgres')
            await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
        await db.destroy();
    });
    async function storeBoth() {
        // Composed on the linked phone: only the engine's own-send echo stores it.
        const phoneComposed = {
            id: 'WA_FROM_PHONE',
            chatId: CHAT,
            from: OWN_JID,
            to: CHAT,
            body: 'sent from the phone',
            type: 'text',
            timestamp: 1_700_000_000,
            fromMe: true,
            isGroup: false,
            kind: 'individual',
        };
        projector.handleOwnSendEcho(sessionId, engine, phoneComposed);
        await flush();
        // Sent through the API: the REST send path stores it before the echo arrives.
        await sender.sendText(sessionId, { chatId: CHAT, text: 'sent through the API' });
    }
    /** A row an earlier version of the send path wrote, naming the account by its bare digits. */
    const storeLegacy = (waMessageId, from) => messages.save(messages.create({
        sessionId,
        waMessageId,
        chatId: CHAT,
        from,
        to: CHAT,
        body: 'sent through the API earlier',
        type: 'text',
        direction: message_entity_1.MessageDirection.OUTGOING,
        status: message_entity_1.MessageStatus.SENT,
        timestamp: 1_699_999_000,
    }));
    const idsFrom = async (from) => (await list.getMessages(sessionId, { from })).messages.map(m => m.waMessageId).sort();
    it('names the account the way its own-send echo does', async () => {
        await storeBoth();
        const rows = await messages.find({ where: { sessionId }, order: { timestamp: 'ASC' } });
        expect(rows.map(r => [r.waMessageId, r.direction, r.from])).toEqual([
            ['WA_FROM_PHONE', message_entity_1.MessageDirection.OUTGOING, OWN_JID],
            ['WA_FROM_API', message_entity_1.MessageDirection.OUTGOING, OWN_JID],
        ]);
    });
    it('lists every outgoing row of the account under a filter on its JID', async () => {
        await storeBoth();
        expect(await idsFrom(OWN_JID)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE']);
    });
    it('still lists a row an earlier version stored under the bare digits, by JID or by digits', async () => {
        await storeBoth();
        await storeLegacy('WA_LEGACY', PHONE);
        expect(await idsFrom(OWN_JID)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE', 'WA_LEGACY']);
        expect(await idsFrom(`${PHONE}@s.whatsapp.net`)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE', 'WA_LEGACY']);
        expect(await idsFrom(PHONE)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE', 'WA_LEGACY']);
    });
    it('keeps another sender out of the account filter, and the account out of another sender', async () => {
        await storeBoth();
        await messages.save(messages.create({
            sessionId,
            waMessageId: 'WA_GROUP',
            chatId: '120363000000000001@g.us',
            from: '120363000000000001@g.us',
            author: '628111111111@c.us',
            to: OWN_JID,
            body: 'from a member',
            type: 'text',
            direction: message_entity_1.MessageDirection.INCOMING,
            status: message_entity_1.MessageStatus.SENT,
            timestamp: 1_700_000_200,
        }));
        expect(await idsFrom('628111111111@c.us')).toEqual(['WA_GROUP']);
        expect(await idsFrom(OWN_JID)).toEqual(['WA_FROM_API', 'WA_FROM_PHONE']);
    });
    it("stores 'me' for a send made while the session has no number, still found by that name", async () => {
        await sessions.update({ id: sessionId }, { phone: null });
        await sender.sendText(sessionId, { chatId: CHAT, text: 'sent while unlinked' });
        expect((await messages.findOneByOrFail({ sessionId, waMessageId: 'WA_FROM_API' })).from).toBe('me');
        expect(await idsFrom('me')).toEqual(['WA_FROM_API']);
    });
});
