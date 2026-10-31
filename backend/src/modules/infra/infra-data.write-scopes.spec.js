"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("@nestjs/config");
const typeorm_1 = require("typeorm");
const infra_data_service_1 = require("./infra-data.service");
const session_entity_1 = require("../session/entities/session.entity");
const webhook_entity_1 = require("../webhook/entities/webhook.entity");
const message_entity_1 = require("../message/entities/message.entity");
const message_batch_entity_1 = require("../message/entities/message-batch.entity");
const template_entity_1 = require("../template/entities/template.entity");
const baileys_stored_message_entity_1 = require("../../engine/adapters/baileys-stored-message.entity");
const lid_mapping_entity_1 = require("../../engine/identity/lid-mapping.entity");
const baileys_chat_state_entity_1 = require("../../engine/adapters/baileys-chat-state.entity");
const plugin_instance_entity_1 = require("../integration/entities/plugin-instance.entity");
const conversation_mapping_entity_1 = require("../integration/entities/conversation-mapping.entity");
const ingress_event_entity_1 = require("../integration/entities/ingress-event.entity");
const webhook_delivery_failure_entity_1 = require("../webhook/entities/webhook-delivery-failure.entity");
const webhook_outbox_event_entity_1 = require("../webhook/entities/webhook-outbox-event.entity");
const integration_delivery_failure_entity_1 = require("../integration/entities/integration-delivery-failure.entity");
const status_update_entity_1 = require("../status-store/entities/status-update.entity");
const send_idempotency_key_entity_1 = require("../message/entities/send-idempotency-key.entity");
const automation_rule_entity_1 = require("../automation/entities/automation-rule.entity");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const hooks_1 = require("../../core/hooks");
const message_send_service_1 = require("../message/message-send.service");
const bulk_message_service_1 = require("../message/bulk-message.service");
const send_pacing_service_1 = require("../message/send-pacing.service");
const session_write_scope_1 = require("../../common/utils/session-write-scope");
const deferred = () => {
    let resolve;
    const promise = new Promise(res => (resolve = res));
    return { promise, resolve };
};
// The replace removes every session the archive does not hold, rows and all, in one transaction. A send or
// batch row still being written for such a session must not land after it, as it must not after a delete,
// and an import that does not commit keeps those sessions, so it must not leave their batches unfinished.
describe('import-data and the writes of the sessions it removes', () => {
    let ds;
    let engines;
    let hooks;
    let sender;
    let bulk;
    // An archive that holds only s2, so the replace removes s1.
    let onlyS2;
    const engine = { sendTextMessage: jest.fn(), sendImageMessage: jest.fn(), sendChatState: jest.fn() };
    const sessionService = {
        getActiveSessionIds: () => ['s1', 's2'].filter(id => engines.has(id)),
        stopOrphanEngines: (ids) => {
            for (const id of ids)
                engines.delete(id);
            return Promise.resolve({ stopped: ids, notRunning: [], failed: [] });
        },
    };
    const cfg = { get: (key, fallback) => (key === 'dataDatabase.type' ? 'sqlite' : fallback) };
    const newService = (ownership) => new infra_data_service_1.InfraDataService(cfg, ds, undefined, sessionService, undefined, ownership);
    const importNow = (options, tables = onlyS2, ownership) => newService(ownership).importData({ tables, ...options });
    // A message row without its non-null columns: the restore cannot insert it and rolls everything back.
    const withBadRow = () => ({
        ...onlyS2,
        messages: [
            { id: 'mX', sessionId: 's2', chatId: 'c', type: 'text', direction: 'incoming', status: 'sent' },
        ],
    });
    const current = (id) => {
        const scope = (0, session_write_scope_1.captureSessionWrites)(ds, id);
        try {
            scope.assertCurrent();
            return true;
        }
        catch {
            return false;
        }
        finally {
            scope.close();
        }
    };
    const batchRow = (id) => ds.getRepository(message_batch_entity_1.MessageBatch).findOneByOrFail({ id });
    // Every runner this test sees: better-sqlite3 hands out one per DataSource, so prepare it once.
    const onRunner = (prepare) => {
        const prepared = new WeakSet();
        const realCreate = ds.createQueryRunner.bind(ds);
        jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
            const runner = realCreate(...args);
            if (!prepared.has(runner)) {
                prepared.add(runner);
                prepare(runner);
            }
            return runner;
        });
    };
    // A bulk batch for s1 whose first item waits in its message:sending hook until released. Its second item
    // carries a media payload, so a terminal write shows whether it stripped it.
    const parkBatch = async () => {
        const entered = deferred();
        const finish = deferred();
        hooks.register('moderation', 'message:sending', async () => {
            entered.resolve();
            await finish.promise;
            return { continue: true };
        });
        const pickup = jest.spyOn(bulk, 'processBatch');
        const batch = await bulk.createBatch('s1', {
            messages: [
                { chatId: 'a@c.us', type: 'text', content: { text: 'x' } },
                { chatId: 'b@c.us', type: 'image', content: { image: { base64: 'MEDIA-PAYLOAD', mimetype: 'image/png' } } },
            ],
            options: { delayBetweenMessages: 0, randomizeDelay: false },
        });
        await entered.promise;
        const run = pickup.mock.results[0].value;
        return {
            id: batch.id,
            finish: async () => {
                finish.resolve();
                await run.catch(() => undefined);
            },
        };
    };
    beforeEach(async () => {
        process.env.SIMULATE_TYPING = 'false';
        engine.sendTextMessage.mockReset().mockResolvedValue({ id: 'sent-1', timestamp: 1 });
        engine.sendImageMessage.mockReset().mockResolvedValue({ id: 'sent-2', timestamp: 1 });
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [
                session_entity_1.Session,
                webhook_entity_1.Webhook,
                message_entity_1.Message,
                message_batch_entity_1.MessageBatch,
                template_entity_1.Template,
                baileys_stored_message_entity_1.BaileysStoredMessage,
                lid_mapping_entity_1.LidMapping,
                baileys_chat_state_entity_1.ChatState,
                plugin_instance_entity_1.PluginInstance,
                conversation_mapping_entity_1.ConversationMapping,
                ingress_event_entity_1.IngressEvent,
                webhook_delivery_failure_entity_1.WebhookDeliveryFailure,
                webhook_outbox_event_entity_1.WebhookOutboxEvent,
                integration_delivery_failure_entity_1.IntegrationDeliveryFailure,
                status_update_entity_1.StatusUpdate,
                automation_rule_entity_1.AutomationRule,
                send_idempotency_key_entity_1.SendIdempotencyKey,
            ],
            synchronize: true,
        });
        await ds.initialize();
        const sessions = ds.getRepository(session_entity_1.Session);
        for (const id of ['s1', 's2']) {
            await sessions.save(sessions.create({ id, name: `session-${id}`, status: session_entity_1.SessionStatus.READY, config: {} }));
        }
        engines = new engine_registry_service_1.EngineRegistry();
        engines.set('s1', engine);
        hooks = new hooks_1.HookManager();
        const messages = ds.getRepository(message_entity_1.Message);
        const config = new config_1.ConfigService({});
        const pacing = new send_pacing_service_1.SendPacingService(messages, sessions, config);
        sender = new message_send_service_1.MessageSendService(messages, { findOne: (id) => sessions.findOneByOrFail({ id }) }, engines, hooks, {}, pacing, config);
        bulk = new bulk_message_service_1.BulkMessageService(ds.getRepository(message_batch_entity_1.MessageBatch), engines, sender, hooks, pacing);
        const dump = await newService().exportData();
        onlyS2 = { ...dump.tables, sessions: dump.tables.sessions?.filter(row => row.id === 's2') };
    });
    afterEach(async () => {
        delete process.env.SIMULATE_TYPING;
        jest.restoreAllMocks();
        await ds.destroy();
    });
    it('waits for a message insert in flight before replacing the session that owns it', async () => {
        const entered = deferred();
        const finish = deferred();
        const messages = ds.getRepository(message_entity_1.Message);
        const save = messages.save.bind(messages);
        jest.spyOn(messages, 'save').mockImplementationOnce(async (message) => {
            entered.resolve();
            await finish.promise;
            return save(message);
        });
        const sending = sender.sendText('s1', { chatId: 'first@c.us', text: 'hello' }).catch((error) => error);
        await entered.promise;
        let imported = false;
        const importing = importNow({ stopOrphans: true }).then(result => {
            imported = true;
            return result;
        });
        await new Promise(setImmediate);
        const importedBeforeInsert = imported;
        finish.resolve();
        expect(await importing).toMatchObject({ imported: true });
        expect(importedBeforeInsert).toBe(false);
        expect(await sending).toMatchObject({ status: 404 });
        expect(engine.sendTextMessage).not.toHaveBeenCalled();
        expect(await ds.getRepository(message_entity_1.Message).count({ where: { sessionId: 's1' } })).toBe(0);
    });
    it('keeps the writes of a session the archive holds open throughout', async () => {
        const kept = (0, session_write_scope_1.captureSessionWrites)(ds, 's2');
        await expect(importNow({ stopOrphans: true })).resolves.toMatchObject({ imported: true });
        expect(() => kept.assertCurrent()).not.toThrow();
        kept.close();
    });
    it('writes again for a removed session id once the import has committed', async () => {
        await expect(importNow({ stopOrphans: true })).resolves.toMatchObject({ imported: true });
        expect(current('s1')).toBe(true);
    });
    it('restores the batches of a removed session that the archive carries as archived', async () => {
        const batches = ds.getRepository(message_batch_entity_1.MessageBatch);
        await batches.save({
            batchId: 'archived',
            sessionId: 's1',
            status: message_batch_entity_1.BatchStatus.PENDING,
            messages: [{ chatId: 'a@c.us', type: 'text', content: { text: 'x' } }],
            options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
            progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
            results: [],
        });
        const dump = await newService().exportData();
        await expect(importNow({ stopOrphans: true }, { ...dump.tables, sessions: dump.tables.sessions?.filter(r => r.id === 's2') })).resolves.toMatchObject({ imported: true });
        expect(await batches.findOneByOrFail({ batchId: 'archived' })).toMatchObject({ status: message_batch_entity_1.BatchStatus.PENDING });
    });
    // The removed sessions survive an import that does not commit, but a run that captured their writes before
    // the import closed them stays stopped. Their engines are gone, so the batch could not send anyway.
    describe.each([
        ['a row the restore cannot insert', () => importNow({ stopOrphans: true }, withBadRow())],
        [
            'an archive that restores no rows',
            () => {
                let opened = false;
                onRunner(runner => {
                    const begin = runner.startTransaction.bind(runner);
                    runner.startTransaction = (...args) => {
                        opened = true;
                        return begin(...args);
                    };
                });
                // The pre-flight refuses an empty archive before it closes anything; this one empties once BEGIN ran.
                const tables = new Proxy(onlyS2, {
                    get: (target, key) => (opened ? undefined : target[key]),
                });
                return importNow({ stopOrphans: true }, tables);
            },
        ],
        [
            'a statement that fails',
            () => {
                onRunner(runner => {
                    const query = runner.query.bind(runner);
                    runner.query = ((...args) => args[0] === 'DELETE FROM webhooks'
                        ? Promise.reject(new Error('disk I/O error'))
                        : query(...args));
                });
                return importNow({ stopOrphans: true });
            },
        ],
        [
            'a transaction that cannot open',
            () => {
                onRunner(runner => {
                    runner.startTransaction = () => Promise.reject(new Error('BEGIN failed'));
                });
                return importNow({ stopOrphans: true });
            },
        ],
        [
            'another transaction opened while the writes drained',
            () => {
                onRunner(runner => {
                    let opened = false;
                    const query = runner.query.bind(runner);
                    runner.query = (async (...args) => {
                        const rows = await query(...args);
                        if (!opened && /^SELECT id FROM sessions/.test(args[0])) {
                            opened = true;
                            // Someone else's transaction on the one connection, rolled back once the import has refused.
                            await runner.startTransaction();
                            setTimeout(() => void runner.rollbackTransaction(), 20);
                        }
                        return rows;
                    });
                });
                return importNow({ stopOrphans: true });
            },
        ],
    ])('an import that ends without committing: %s', (_exit, run) => {
        it('fails the unfinished batch of the session it meant to remove and reopens its writes', async () => {
            const batch = await parkBatch();
            const outcome = await run().catch((error) => error);
            await batch.finish();
            expect(outcome).not.toMatchObject({ imported: true });
            const row = await batchRow(batch.id);
            expect(row.status).toBe(message_batch_entity_1.BatchStatus.FAILED);
            expect(JSON.stringify(row.messages)).not.toContain('MEDIA-PAYLOAD');
            expect(engine.sendTextMessage).not.toHaveBeenCalled();
            expect(await ds.getRepository(message_entity_1.Message).count({ where: { sessionId: 's1' } })).toBe(0);
            expect(await ds.getRepository(session_entity_1.Session).count()).toBe(2);
            expect(current('s1')).toBe(true);
        });
    });
    // On SQLite a transaction someone else opens while the import drains is open on the import's connection
    // too. Failing the batch inside it would tie the fail to that transaction's outcome.
    it.each([['rolls back'], ['commits']])('fails the batch of an import refused for a transaction opened while it drained, which then %s', async (outcome) => {
        const entered = deferred();
        const finish = deferred();
        const messages = ds.getRepository(message_entity_1.Message);
        const save = messages.save.bind(messages);
        jest.spyOn(messages, 'save').mockImplementationOnce(async (message) => {
            entered.resolve();
            await finish.promise;
            return save(message);
        });
        const sending = sender.sendText('s1', { chatId: 'first@c.us', text: 'hello' }).catch((error) => error);
        await entered.promise;
        const batch = await parkBatch();
        const importing = importNow({ stopOrphans: true }).catch((error) => error);
        await new Promise(setImmediate);
        const outer = ds.createQueryRunner();
        await outer.connect();
        await outer.startTransaction();
        finish.resolve();
        // The drained write has landed and the import has refused by the time a timer runs.
        await new Promise(resolve => setTimeout(resolve, 20));
        await (outcome === 'commits' ? outer.commitTransaction() : outer.rollbackTransaction());
        expect(await importing).toMatchObject({ response: { code: 'IMPORT_NESTED_TRANSACTION' } });
        await batch.finish();
        await sending;
        const row = await batchRow(batch.id);
        expect(row.status).toBe(message_batch_entity_1.BatchStatus.FAILED);
        expect(JSON.stringify(row.messages)).not.toContain('MEDIA-PAYLOAD');
        expect(engine.sendTextMessage).not.toHaveBeenCalled();
        expect(await ds.getRepository(session_entity_1.Session).count()).toBe(2);
        expect(current('s1')).toBe(true);
    });
    describe.each([
        ['would orphan a running engine', () => importNow({})],
        [
            'finds another transaction holding the connection',
            async () => {
                const outer = ds.createQueryRunner();
                await outer.connect();
                await outer.startTransaction();
                try {
                    return await importNow({ stopOrphans: true });
                }
                finally {
                    await outer.rollbackTransaction();
                }
            },
        ],
    ])('an import refused before it starts because it %s', (_reason, run) => {
        it('leaves the writes of every session alone', async () => {
            const before = (0, session_write_scope_1.captureSessionWrites)(ds, 's1');
            await expect(run()).rejects.toMatchObject({ status: 409 });
            expect(() => before.assertCurrent()).not.toThrow();
            before.close();
        });
    });
    it('leaves a removed session whose engine force keeps running writable, and its batch running', async () => {
        const batch = await parkBatch();
        const result = await importNow({ force: true }, withBadRow());
        await batch.finish();
        expect(result.imported).toBe(false);
        expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
        expect((await batchRow(batch.id)).status).toBe(message_batch_entity_1.BatchStatus.COMPLETED);
    });
    it('leaves the writes and batches of a removed session another node holds alone', async () => {
        engines.delete('s1');
        const batches = ds.getRepository(message_batch_entity_1.MessageBatch);
        const running = await batches.save({
            batchId: 'elsewhere',
            sessionId: 's1',
            status: message_batch_entity_1.BatchStatus.PROCESSING,
            messages: [{ chatId: 'a@c.us', type: 'text', content: { text: 'x' } }],
            options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
            progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
            results: [],
        });
        const before = (0, session_write_scope_1.captureSessionWrites)(ds, 's1');
        const ownership = {
            heldByOtherNodes: () => Promise.resolve(['s1']),
            claimableWhere: () => [{}],
            suspendLossDetection: () => () => undefined,
        };
        await expect(importNow({}, withBadRow(), ownership)).resolves.toMatchObject({ imported: false });
        expect((await batchRow(running.id)).status).toBe(message_batch_entity_1.BatchStatus.PROCESSING);
        expect(() => before.assertCurrent()).not.toThrow();
        before.close();
    });
});
