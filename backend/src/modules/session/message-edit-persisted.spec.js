"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../message/entities/message.entity");
const message_projector_service_1 = require("./message-projector.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
// A plugin search provider keeps its index in step through `message:persisted`, treating every emission as
// an upsert keyed by the row id (docs/27). A stored message whose text changes must reach it again, as a
// revoked one does, or the index keeps serving the text the sender replaced. Runs on SQLite, and on the
// postgres:16 service when DATABASE_TYPE=postgres.
describe('message:persisted after a stored message changes its text', () => {
    const CHAT = '15550001111@c.us';
    let db;
    let repository;
    let projector;
    let engine;
    let hookManager;
    // The message:received chain of a message waits for this gate when one is set.
    let receivedGate;
    const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const flush = async () => {
        for (let i = 0; i < 25; i++)
            await new Promise(resolve => setImmediate(resolve));
        // A PostgreSQL round trip takes real time.
        if (db.options.type === 'postgres')
            await pause(150);
    };
    const persistedRows = () => hookManager.execute.mock.calls
        .filter(([event]) => event === 'message:persisted')
        .map(([, data]) => data.message);
    async function seed(waMessageId, direction) {
        return repository.save(repository.create({
            sessionId: 's1',
            waMessageId,
            chatId: CHAT,
            from: direction === message_entity_1.MessageDirection.INCOMING ? CHAT : 'me',
            to: direction === message_entity_1.MessageDirection.INCOMING ? 'me' : CHAT,
            body: 'the original text',
            type: 'text',
            direction,
            status: message_entity_1.MessageStatus.SENT,
            timestamp: 1_700_000_000,
        }));
    }
    const inbound = (id) => ({
        id,
        chatId: CHAT,
        from: CHAT,
        to: 'me@c.us',
        body: 'the original text',
        type: 'text',
        timestamp: 1_700_000_000,
        fromMe: false,
        isGroup: false,
        kind: 'individual',
    });
    const editOf = (messageId, body, over = {}) => ({ messageId, chatId: CHAT, fromMe: false, body, ...over });
    beforeEach(async () => {
        receivedGate = undefined;
        db = new typeorm_1.DataSource(process.env.DATABASE_TYPE === 'postgres'
            ? {
                type: 'postgres',
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 5432),
                username: process.env.DATABASE_USERNAME || 'openwa',
                password: process.env.DATABASE_PASSWORD || 'openwa',
                database: process.env.DATABASE_NAME || 'openwa',
                schema: `edit_persisted_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`,
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
        hookManager = {
            execute: jest.fn(async (event, data) => {
                if (event === 'message:received')
                    await receivedGate;
                return { continue: true, data };
            }),
        };
        const engines = new engine_registry_service_1.EngineRegistry();
        engine = { tag: 'engine' };
        engines.set('s1', engine);
        projector = new message_projector_service_1.MessageProjector(repository, { update: jest.fn().mockResolvedValue({ affected: 1 }) }, engines, new Proxy({}, { get: () => () => undefined }), { dispatch: jest.fn().mockResolvedValue(undefined) }, hookManager, { ingest: jest.fn() }, { resolveSenderPhone: jest.fn().mockResolvedValue(null) });
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        if (db.options.type === 'postgres')
            await db.query(`DROP SCHEMA IF EXISTS "${String(db.options.schema)}" CASCADE`);
        await db.destroy();
    });
    it('hands the cleared row of a revoked message to message:persisted (the existing contract)', async () => {
        const row = await seed('WA_REVOKE', message_entity_1.MessageDirection.INCOMING);
        await projector.recordRevoke('s1', 'WA_REVOKE', { kind: 'revoke', chatId: CHAT, fromMe: false });
        await flush();
        expect(persistedRows()).toEqual([expect.objectContaining({ id: row.id, body: '', type: 'revoked' })]);
    });
    it('hands the edited row of an inbound edit to message:persisted, marker included', async () => {
        const row = await seed('WA_EDIT_IN', message_entity_1.MessageDirection.INCOMING);
        projector.applyMessageEditQueued('s1', editOf('WA_EDIT_IN', 'the corrected text'));
        await flush();
        expect((await repository.findOneByOrFail({ id: row.id })).body).toBe('the corrected text');
        const persisted = persistedRows();
        expect(persisted).toEqual([expect.objectContaining({ id: row.id, body: 'the corrected text' })]);
        expect(persisted[0].metadata).toMatchObject({ edited: true });
    });
    it('hands the edited row of a REST edit to message:persisted', async () => {
        const row = await seed('WA_EDIT_OUT', message_entity_1.MessageDirection.OUTGOING);
        await projector.recordOutboundMessageEdit('s1', 'WA_EDIT_OUT', 'the corrected text', {
            kind: 'edit',
            chatId: CHAT,
            fromMe: true,
        });
        await flush();
        expect((await repository.findOneByOrFail({ id: row.id })).body).toBe('the corrected text');
        expect(persistedRows()).toEqual([expect.objectContaining({ id: row.id, body: 'the corrected text' })]);
    });
    it('hands a REST edit over once when the engine echoes the same edit back', async () => {
        const row = await seed('WA_EDIT_ECHO', message_entity_1.MessageDirection.OUTGOING);
        await projector.recordOutboundMessageEdit('s1', 'WA_EDIT_ECHO', 'the corrected text', {
            kind: 'edit',
            chatId: CHAT,
            fromMe: true,
        });
        projector.applyMessageEditQueued('s1', editOf('WA_EDIT_ECHO', 'the corrected text', { fromMe: true }));
        await flush();
        expect(persistedRows()).toEqual([expect.objectContaining({ id: row.id, body: 'the corrected text' })]);
    });
    it('hands nothing over for an edit that repeats the stored text', async () => {
        await seed('WA_SAME', message_entity_1.MessageDirection.INCOMING);
        projector.applyMessageEditQueued('s1', editOf('WA_SAME', 'the original text'));
        await flush();
        expect(persistedRows()).toEqual([]);
    });
    it('hands nothing over for an edit naming another chat', async () => {
        const row = await seed('WA_FOREIGN', message_entity_1.MessageDirection.INCOMING);
        projector.applyMessageEditQueued('s1', editOf('WA_FOREIGN', 'not this one', { chatId: '15550002222@c.us' }));
        await flush();
        expect((await repository.findOneByOrFail({ id: row.id })).body).toBe('the original text');
        expect(persistedRows()).toEqual([]);
    });
    it('hands a message over once with the edit that reached it before its row was written', async () => {
        let release;
        receivedGate = new Promise(resolve => (release = resolve));
        projector.handleInboundMessage('s1', engine, inbound('WA_HELD'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('WA_HELD', 'the corrected text'));
        await flush();
        release();
        await flush();
        expect((await repository.findOneByOrFail({ waMessageId: 'WA_HELD' })).body).toBe('the corrected text');
        expect(persistedRows().map(row => row.body)).toEqual(['the corrected text']);
    });
    it('hands a message over again with the edit that reached it while its row was being written', async () => {
        let releaseInsert;
        const insertHeld = new Promise(resolve => (releaseInsert = resolve));
        const insert = repository.insert.bind(repository);
        jest.spyOn(repository, 'insert').mockImplementation(async (row) => {
            await insertHeld;
            return insert(row);
        });
        projector.handleInboundMessage('s1', engine, inbound('WA_DURING'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('WA_DURING', 'the corrected text'));
        await flush();
        releaseInsert();
        await flush();
        expect((await repository.findOneByOrFail({ waMessageId: 'WA_DURING' })).body).toBe('the corrected text');
        expect(persistedRows().map(row => row.body)).toEqual(['the original text', 'the corrected text']);
    });
});
