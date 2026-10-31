"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../message/entities/message.entity");
const message_projector_service_1 = require("./message-projector.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
// Baileys relays a peer's receipt under the peer's own chat and every id the stanza lists, with no check
// that the id belongs to that chat (messages-recv handleReceipt). A message id names one message of one
// chat, so a receipt from one chat must not move the stored delivery state of another chat's message, as
// the edit, revoke and reaction paths already refuse. Runs on SQLite, and on the postgres:16 service when
// DATABASE_TYPE=postgres.
describe('a delivery ack names the chat of the message it advances', () => {
    const GROUP = '120363000000000001@g.us';
    const PEER = '15550001111@c.us';
    const OTHER = '15550002222@c.us';
    const PEER_LID = '99990001111@lid';
    let db;
    let repository;
    let projector;
    let engine;
    let dispatch;
    let lidPhones;
    const settle = () => new Promise(resolve => setTimeout(resolve, message_projector_service_1.ACK_RECONCILE_DELAY_MS + 250));
    const statusOf = async (id) => (await repository.findOne({ where: { sessionId: 's1', waMessageId: id } }))?.status;
    const announced = (id) => dispatch.mock.calls.filter(([, event, payload]) => event === 'message.ack' && payload.id === id)
        .length;
    async function seed(waMessageId, chatId) {
        return repository.save(repository.create({
            sessionId: 's1',
            waMessageId,
            chatId,
            from: '15559990000@c.us',
            to: chatId,
            body: 'sent by the account',
            type: 'text',
            direction: message_entity_1.MessageDirection.OUTGOING,
            status: message_entity_1.MessageStatus.SENT,
            timestamp: 1_700_000_000,
        }));
    }
    const ack = (id, status, chatId) => projector.handleMessageAck('s1', engine, id, status, chatId);
    beforeEach(async () => {
        db = new typeorm_1.DataSource(process.env.DATABASE_TYPE === 'postgres'
            ? {
                type: 'postgres',
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 5432),
                username: process.env.DATABASE_USERNAME || 'openwa',
                password: process.env.DATABASE_PASSWORD || 'openwa',
                database: process.env.DATABASE_NAME || 'openwa',
                schema: `ack_chat_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`,
                entities: [message_entity_1.Message],
                synchronize: false,
            }
            : { type: 'better-sqlite3', database: ':memory:', entities: [message_entity_1.Message], synchronize: true });
        await db.initialize();
        if (db.options.type === 'postgres') {
            await db.query(`CREATE SCHEMA "${db.options.schema}"`);
            await db.synchronize();
        }
        repository = db.getRepository(message_entity_1.Message);
        lidPhones = new Map();
        dispatch = jest.fn().mockResolvedValue(undefined);
        const engines = new engine_registry_service_1.EngineRegistry();
        engine = { tag: 'engine' };
        engines.set('s1', engine);
        projector = new message_projector_service_1.MessageProjector(repository, { update: jest.fn().mockResolvedValue({ affected: 1 }) }, engines, new Proxy({}, { get: () => () => undefined }), { dispatch }, {
            execute: jest.fn((_event, data) => Promise.resolve({ continue: true, data })),
        }, { ingest: jest.fn() }, { resolveSenderPhone: jest.fn().mockResolvedValue(null) }, undefined, undefined, undefined, {
            findPhoneForLid: (jid) => Promise.resolve(lidPhones.get(jid.split('@')[0]) ?? null),
        });
    });
    afterEach(async () => {
        if (db.options.type === 'postgres')
            await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
        await db.destroy();
    });
    it('leaves a group message alone, and unannounced, when a one-to-one receipt names its id', async () => {
        await seed('WA_GROUP', GROUP);
        ack('WA_GROUP', 'read', OTHER);
        await settle();
        expect(await statusOf('WA_GROUP')).toBe(message_entity_1.MessageStatus.SENT);
        expect(announced('WA_GROUP')).toBe(0);
    });
    it("leaves another contact's message alone when a receipt from a different contact names its id", async () => {
        await seed('WA_PEER', PEER);
        ack('WA_PEER', 'read', OTHER);
        await settle();
        expect(await statusOf('WA_PEER')).toBe(message_entity_1.MessageStatus.SENT);
    });
    it('never marks another chat failed', async () => {
        await seed('WA_FAIL', PEER);
        ack('WA_FAIL', 'failed', OTHER);
        await settle();
        expect(await statusOf('WA_FAIL')).toBe(message_entity_1.MessageStatus.SENT);
        expect(dispatch.mock.calls.some(([, event]) => event === 'message.failed')).toBe(false);
    });
    it('still advances, and announces, the message when the receipt names its chat in another dialect', async () => {
        await seed('WA_SAME', PEER);
        ack('WA_SAME', 'read', '15550001111@s.whatsapp.net');
        await settle();
        expect(await statusOf('WA_SAME')).toBe(message_entity_1.MessageStatus.READ);
        expect(announced('WA_SAME')).toBe(1);
    });
    it('still advances the message when the ack names no chat', async () => {
        await seed('WA_NOCHAT', PEER);
        ack('WA_NOCHAT', 'delivered');
        await settle();
        expect(await statusOf('WA_NOCHAT')).toBe(message_entity_1.MessageStatus.DELIVERED);
    });
    it('advances a phone-stored message for a lid receipt with no reported pairing', async () => {
        await seed('WA_LID_UNMAPPED', PEER);
        ack('WA_LID_UNMAPPED', 'read', PEER_LID);
        await settle();
        expect(await statusOf('WA_LID_UNMAPPED')).toBe(message_entity_1.MessageStatus.READ);
    });
    it('advances for a lid paired with the message chat, and not for one paired with another phone', async () => {
        await seed('WA_LID_SAME', PEER);
        await seed('WA_LID_OTHER', OTHER);
        lidPhones.set('99990001111', '15550001111');
        ack('WA_LID_SAME', 'delivered', PEER_LID);
        ack('WA_LID_OTHER', 'delivered', PEER_LID);
        await settle();
        expect(await statusOf('WA_LID_SAME')).toBe(message_entity_1.MessageStatus.DELIVERED);
        expect(await statusOf('WA_LID_OTHER')).toBe(message_entity_1.MessageStatus.SENT);
    });
    it('advances a message the account sent to a broadcast list for a recipient receipt', async () => {
        await seed('WA_LIST', '1700000000@broadcast');
        ack('WA_LIST', 'read', PEER);
        await settle();
        expect(await statusOf('WA_LIST')).toBe(message_entity_1.MessageStatus.READ);
    });
    it('judges a receipt that arrived before its row, once the row is written', async () => {
        ack('WA_LATE_SAME', 'delivered', PEER);
        ack('WA_LATE_OTHER', 'delivered', OTHER);
        await new Promise(resolve => setTimeout(resolve, 100));
        await seed('WA_LATE_SAME', PEER);
        await seed('WA_LATE_OTHER', GROUP);
        await settle();
        expect(await statusOf('WA_LATE_SAME')).toBe(message_entity_1.MessageStatus.DELIVERED);
        expect(await statusOf('WA_LATE_OTHER')).toBe(message_entity_1.MessageStatus.SENT);
    });
    it('keeps a foreign receipt off a message that has not been written yet', async () => {
        const own = (id, chatId) => ({
            id,
            chatId,
            from: '15559990000@c.us',
            to: chatId,
            body: 'composed on the phone',
            type: 'text',
            timestamp: 1_700_000_000,
            fromMe: true,
            isGroup: chatId.endsWith('@g.us'),
            kind: chatId.endsWith('@g.us') ? 'group' : 'individual',
        });
        projector.handleOwnSendEcho('s1', engine, own('WA_INFLIGHT_GROUP', GROUP));
        projector.handleOwnSendEcho('s1', engine, own('WA_INFLIGHT_PEER', PEER));
        ack('WA_INFLIGHT_GROUP', 'read', OTHER);
        ack('WA_INFLIGHT_PEER', 'read', PEER);
        await settle();
        expect(await statusOf('WA_INFLIGHT_GROUP')).toBe(message_entity_1.MessageStatus.SENT);
        expect(await statusOf('WA_INFLIGHT_PEER')).toBe(message_entity_1.MessageStatus.READ);
    });
});
