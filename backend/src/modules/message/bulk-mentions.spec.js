"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const hooks_1 = require("../../core/hooks");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_entity_1 = require("../session/entities/session.entity");
const bulk_message_service_1 = require("./bulk-message.service");
const message_batch_entity_1 = require("./entities/message-batch.entity");
const message_entity_1 = require("./entities/message.entity");
describe('bulk mentions', () => {
    let db;
    let bulk;
    let send;
    let hooks;
    beforeEach(async () => {
        db = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message, message_batch_entity_1.MessageBatch, session_entity_1.Session],
            synchronize: true,
        }).initialize();
        await db.getRepository(session_entity_1.Session).save({ id: 's1', name: 'sender', config: {} });
        const engines = new engine_registry_service_1.EngineRegistry();
        send = jest.fn().mockResolvedValue({ id: 'sent-1', timestamp: 1700000000 });
        engines.set('s1', { sendImageMessage: send, sendTextMessage: send });
        hooks = new hooks_1.HookManager();
        bulk = new bulk_message_service_1.BulkMessageService(db.getRepository(message_batch_entity_1.MessageBatch), engines, { saveOutgoingMessage: () => Promise.resolve() }, hooks, {
            assertSendAllowed: () => Promise.resolve(),
            recordSendFailure: () => undefined,
            recordSendSuccess: () => undefined,
        });
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await db.destroy();
    });
    it('refuses a rendered mention that does not identify a person', async () => {
        const processing = jest.spyOn(bulk, 'processBatch');
        const batch = await bulk.createBatch('s1', {
            messages: [
                {
                    chatId: '120363000000000000@g.us',
                    type: 'text',
                    content: { text: 'Hi @{{phone}}', mentions: ['{{phone}}@c.us'] },
                    variables: { phone: 'not-a-person' },
                },
            ],
        });
        await processing.mock.results[0].value;
        const stored = await db.getRepository(message_batch_entity_1.MessageBatch).findOneByOrFail({ id: batch.id });
        expect(stored.results[0].status).toBe('failed');
        expect(send).not.toHaveBeenCalled();
    });
    it.each([
        ['a malformed WID', ['not-a-person@c.us']],
        ['an oversized WID', [`${'1'.repeat(65)}@c.us`]],
        ['an oversized list', Array.from({ length: 1025 }, () => '62811@c.us')],
        ['a sparse list', new Array(1)],
    ])('refuses a hook rewrite with %s', async (_label, mentions) => {
        hooks.register('moderation', 'message:sending', () => Promise.resolve({ continue: true, data: { input: { text: 'Hi', mentions } } }));
        const processing = jest.spyOn(bulk, 'processBatch');
        const batch = await bulk.createBatch('s1', {
            messages: [{ chatId: '120363000000000000@g.us', type: 'text', content: { text: 'Hi' } }],
        });
        await processing.mock.results[0].value;
        const stored = await db.getRepository(message_batch_entity_1.MessageBatch).findOneByOrFail({ id: batch.id });
        expect(stored.results[0].status).toBe('failed');
        expect(send).not.toHaveBeenCalled();
    });
});
