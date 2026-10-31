"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const hooks_1 = require("../../core/hooks");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_entity_1 = require("../session/entities/session.entity");
const bulk_message_service_1 = require("./bulk-message.service");
const message_batch_entity_1 = require("./entities/message-batch.entity");
const message_entity_1 = require("./entities/message.entity");
const template_render_1 = require("../../common/utils/template-render");
describe('bulk media variable cleanup', () => {
    let db;
    let bulk;
    let send;
    let hooks;
    const payload = 'QUJDREVG';
    const messages = () => [
        {
            chatId: '628111111111@c.us',
            type: 'image',
            content: { image: { base64: '{{picture}}', mimetype: 'image/png' }, caption: 'Photo' },
            variables: { picture: payload, name: 'Alice' },
        },
    ];
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
    it.each([
        ['complete', message_batch_entity_1.BatchStatus.COMPLETED],
        ['cancel', message_batch_entity_1.BatchStatus.CANCELLED],
        ['startup', message_batch_entity_1.BatchStatus.FAILED],
    ])('drops the media variable on %s', async (transition, terminalStatus) => {
        const repository = db.getRepository(message_batch_entity_1.MessageBatch);
        let batch;
        if (transition === 'complete') {
            const processing = jest.spyOn(bulk, 'processBatch');
            batch = await bulk.createBatch('s1', { messages: messages() });
            await processing.mock.results[0].value;
        }
        else {
            batch = await repository.save({
                batchId: 'personalized',
                sessionId: 's1',
                status: message_batch_entity_1.BatchStatus.PENDING,
                messages: messages(),
                options: { delayBetweenMessages: 1000, randomizeDelay: false, stopOnError: false },
                progress: { total: 1, pending: 1, sent: 0, failed: 0, cancelled: 0 },
                results: [],
                currentIndex: 0,
            });
            if (transition === 'cancel')
                await bulk.cancelBatch('s1', batch.batchId);
            else
                await bulk.onApplicationBootstrap();
        }
        const stored = await repository.findOneByOrFail({ id: batch.id });
        expect(stored.status).toBe(terminalStatus);
        expect(JSON.stringify(stored.messages)).not.toContain(payload);
        expect(stored.messages[0].content).toMatchObject({ image: { mimetype: 'image/png' }, caption: 'Photo' });
        expect(stored.messages[0].variables).toEqual({ name: 'Alice' });
    });
    it('names the same variables the renderer substitutes', () => {
        for (const body of [
            '{{a}}',
            '{b}',
            '{{ c }}',
            '{{d.e-f}}',
            '{{{g}}}',
            '{ h }',
            '{{i}',
            'a {j} and {{k}}',
            'plain',
        ]) {
            const names = (0, template_render_1.templateVariableNames)(body);
            const vars = Object.fromEntries(names.map(name => [name, '@']));
            const rendered = (0, template_render_1.renderTemplate)(body, vars);
            expect(rendered.split('@').length - 1).toBe(names.length);
        }
    });
});
