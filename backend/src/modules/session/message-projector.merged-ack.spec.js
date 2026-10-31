"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const baileys_events_1 = require("../../engine/adapters/baileys-events");
const logger_service_1 = require("../../common/services/logger.service");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const message_entity_1 = require("../message/entities/message.entity");
const session_entity_1 = require("./entities/session.entity");
const message_projector_service_1 = require("./message-projector.service");
/**
 * Baileys' event buffer merges a 1:1 ack that lands within about 100 ms of a message's own upsert into that
 * upsert, as `status` (and `messageTimestamp`), and raises no messages.update for it. This runs the adapter's
 * upsert handler against the real projector and a real database (SQLite here, the postgres:16 service when
 * DATABASE_TYPE=postgres) to show that the stored status advances for the two kinds of message that can carry
 * one: the echo of an API send, and a message the phone typed while the gateway was down.
 */
const SESSION = 's1';
const CHAT = '6281111111111@s.whatsapp.net';
const SELF = '6280000000000@s.whatsapp.net';
const gate = () => {
    let release;
    const promise = new Promise(resolve => (release = resolve));
    return { promise, release };
};
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const settle = async () => {
    for (let i = 0; i < 10; i++)
        await new Promise(resolve => setImmediate(resolve));
};
/** Polls until `read` answers `expected` or two seconds pass; a PostgreSQL write takes real time to land. */
const eventually = async (read, expected) => {
    let last = await read();
    for (const start = Date.now(); last !== expected && Date.now() - start < 2000;) {
        await pause(20);
        last = await read();
    }
    return last;
};
// Only what processing a plain text message reads from the library.
const libStub = {
    normalizeMessageContent: (content) => content,
    extractMessageContent: (content) => content,
    getContentType: (content) => Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message')),
};
describe('an ack merged into a message upsert reaches the stored row', () => {
    let db;
    let repo;
    let projector;
    let events;
    let ownSends;
    let hookGate;
    let storedReadGate;
    let retries;
    const engine = { tag: 'merged-ack' };
    beforeEach(async () => {
        // The projector retries an ack that found no row once, after ACK_RECONCILE_DELAY_MS. Kept so a test that
        // has ended cannot fire it into the database the next test has replaced.
        retries = [];
        const realSetTimeout = global.setTimeout;
        jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
            const timer = realSetTimeout(fn, ms);
            if (ms === message_projector_service_1.ACK_RECONCILE_DELAY_MS)
                retries.push(timer);
            return timer;
        });
        db = new typeorm_1.DataSource(process.env.DATABASE_TYPE === 'postgres'
            ? {
                type: 'postgres',
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 5432),
                username: process.env.DATABASE_USERNAME || 'openwa',
                password: process.env.DATABASE_PASSWORD || 'openwa',
                database: process.env.DATABASE_NAME || 'openwa',
                schema: `merged_ack_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`,
                entities: [session_entity_1.Session, message_entity_1.Message],
                synchronize: false,
            }
            : { type: 'better-sqlite3', database: ':memory:', entities: [session_entity_1.Session, message_entity_1.Message], synchronize: true });
        await db.initialize();
        if (db.options.type === 'postgres') {
            await db.query(`CREATE SCHEMA "${db.options.schema}"`);
            await db.synchronize();
        }
        repo = db.getRepository(message_entity_1.Message);
        hookGate = undefined;
        storedReadGate = undefined;
        ownSends = new Set();
        const engines = new engine_registry_service_1.EngineRegistry();
        engines.set(SESSION, engine);
        projector = new message_projector_service_1.MessageProjector(repo, { update: jest.fn().mockResolvedValue({ affected: 1 }) }, engines, {
            emitMessage: jest.fn(),
            emitMessageSent: jest.fn(),
            emitMessageAck: jest.fn(),
        }, { dispatch: jest.fn().mockResolvedValue(undefined) }, {
            // A slow hook chain holds the commit of a message, as a plugin on message:sent can.
            execute: jest.fn(async (_event, data) => {
                await hookGate;
                return { continue: true, data };
            }),
        }, { ingest: jest.fn() }, { resolveSenderPhone: jest.fn().mockResolvedValue(null) });
        const noop = () => undefined;
        const host = {
            getSocket: () => ({ updateMediaMessage: jest.fn() }),
            getSocketOrNull: () => null,
            logger: (0, logger_service_1.createLogger)('MergedAckSpec'),
            loadLib: () => Promise.resolve(libStub),
            getFetchDispatcher: () => undefined,
            toNeutralJid: (jid) => jid,
            normalizedSelfJid: () => SELF,
            inboundLimiter: new concurrency_limiter_1.ConcurrencyLimiter(2),
            recordKeyLidMappings: noop,
            recordMessage: noop,
            recordMessageEdit: noop,
            consumeOwnSend: id => (id ? ownSends.delete(id) : false),
            getStoredMessage: async () => {
                await storedReadGate;
                return null;
            },
            putStoredMessage: () => undefined,
            updateStoredMessage: () => undefined,
            removeStoredMessage: () => undefined,
            getOnMessage: () => undefined,
            getOnMessageCreate: () => (message, ticket) => projector.handleOwnSendEcho(SESSION, engine, message, ticket),
            getOnMessageRevoked: () => undefined,
            getOnMessageEdited: () => undefined,
            getOnMessageReaction: () => undefined,
            getOnMessageAck: () => (id, status, chatId) => projector.handleMessageAck(SESSION, engine, id, status, chatId),
            getOnMessageReceipt: () => undefined,
            getOnGroupEvent: () => undefined,
            getOnEventResponse: () => undefined,
            findContact: () => null,
            getOnCall: () => undefined,
            getOnPresenceUpdate: () => undefined,
            getOnCallOutcome: () => undefined,
            // As the session wiring installs it: PostgreSQL only.
            getAdmitInbound: () => (projector.holdsInbound ? a => projector.admitInbound(SESSION, engine, a) : undefined),
        };
        events = new baileys_events_1.BaileysEvents(host);
    });
    afterEach(async () => {
        retries.forEach(timer => clearTimeout(timer));
        jest.restoreAllMocks();
        if (db.options.type === 'postgres')
            await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
        await db.destroy();
    });
    /** As the event buffer leaves an upsert after an ack was merged into it (Object.assign of the update). */
    const mergedUpsert = (id, fromMe, status) => ({
        type: 'append',
        messages: [
            {
                key: { id, remoteJid: CHAT, fromMe },
                message: { conversation: 'hi' },
                // The ack's own time replaces the message's.
                messageTimestamp: 1_700_000_100,
                status,
            },
        ],
    });
    const statusOf = async (id) => (await repo.findOne({ where: { sessionId: SESSION, waMessageId: id } }))?.status;
    /** The row the REST send leaves once the engine accepted the message. */
    const sentRow = (id) => repo.save(repo.create({
        sessionId: SESSION,
        waMessageId: id,
        chatId: CHAT,
        from: 'me',
        to: CHAT,
        body: 'hi',
        type: 'text',
        direction: message_entity_1.MessageDirection.OUTGOING,
        timestamp: 1_700_000_000,
        status: message_entity_1.MessageStatus.SENT,
    }));
    /** The neutral message the adapter hands the projector for its own send. */
    const echoOf = (id) => ({
        id,
        chatId: CHAT,
        from: SELF,
        to: CHAT,
        body: 'hi',
        type: 'text',
        timestamp: 1_700_000_000,
        fromMe: true,
        isGroup: false,
        kind: 'individual',
    });
    it.each([
        [3, message_entity_1.MessageStatus.DELIVERED],
        [4, message_entity_1.MessageStatus.READ],
    ])('advances the row of an API send when status %i is merged into its echo', async (status, expected) => {
        await sentRow('API1');
        ownSends.add('API1');
        events.handleMessagesUpsert(mergedUpsert('API1', true, status));
        await settle();
        expect(await eventually(() => statusOf('API1'), expected)).toBe(expected);
    });
    it('advances an API send whose echo row is still waiting behind a slow hook when the ack arrives', async () => {
        const slow = gate();
        hookGate = slow.promise;
        ownSends.add('API2');
        // What emitOwnSendEcho hands the projector right after the send; its row is not written yet.
        projector.handleOwnSendEcho(SESSION, engine, echoOf('API2'));
        events.handleMessagesUpsert(mergedUpsert('API2', true, 3));
        await settle();
        expect(await statusOf('API2')).toBeUndefined();
        slow.release();
        await settle();
        expect(await eventually(() => statusOf('API2'), message_entity_1.MessageStatus.DELIVERED)).toBe(message_entity_1.MessageStatus.DELIVERED);
    });
    it('marks an API send failed when the server rejection is merged into its echo', async () => {
        await sentRow('API3');
        ownSends.add('API3');
        events.handleMessagesUpsert(mergedUpsert('API3', true, 0));
        await settle();
        expect(await eventually(() => statusOf('API3'), message_entity_1.MessageStatus.FAILED)).toBe(message_entity_1.MessageStatus.FAILED);
    });
    it('creates a message the phone typed offline and advances it, however long its processing takes', async () => {
        // Longer than the one retry the projector gives an ack that found no row.
        const slow = gate();
        storedReadGate = slow.promise;
        events.handleMessagesUpsert(mergedUpsert('PHONE1', true, 4));
        await pause(message_projector_service_1.ACK_RECONCILE_DELAY_MS + 150);
        slow.release();
        await settle();
        expect(await eventually(() => statusOf('PHONE1'), message_entity_1.MessageStatus.READ)).toBe(message_entity_1.MessageStatus.READ);
    });
    it('creates a message the phone typed offline and advances it when its hook chain is slow', async () => {
        const slow = gate();
        hookGate = slow.promise;
        events.handleMessagesUpsert(mergedUpsert('PHONE2', true, 3));
        await pause(message_projector_service_1.ACK_RECONCILE_DELAY_MS + 150);
        expect(await statusOf('PHONE2')).toBeUndefined();
        slow.release();
        await settle();
        expect(await eventually(() => statusOf('PHONE2'), message_entity_1.MessageStatus.DELIVERED)).toBe(message_entity_1.MessageStatus.DELIVERED);
    });
    it('leaves a message the phone typed at sent when it carries no ack', async () => {
        events.handleMessagesUpsert(mergedUpsert('PHONE3', true, 2));
        await settle();
        expect(await eventually(() => statusOf('PHONE3'), message_entity_1.MessageStatus.SENT)).toBe(message_entity_1.MessageStatus.SENT);
    });
});
