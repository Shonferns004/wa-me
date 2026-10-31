"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const session_entity_1 = require("./entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
const message_batch_entity_1 = require("../message/entities/message-batch.entity");
const send_idempotency_key_entity_1 = require("../message/entities/send-idempotency-key.entity");
const webhook_entity_1 = require("../webhook/entities/webhook.entity");
const webhook_outbox_event_entity_1 = require("../webhook/entities/webhook-outbox-event.entity");
const webhook_delivery_failure_entity_1 = require("../webhook/entities/webhook-delivery-failure.entity");
const integration_delivery_failure_entity_1 = require("../integration/entities/integration-delivery-failure.entity");
const template_entity_1 = require("../template/entities/template.entity");
const baileys_stored_message_entity_1 = require("../../engine/adapters/baileys-stored-message.entity");
const baileys_chat_state_entity_1 = require("../../engine/adapters/baileys-chat-state.entity");
const status_update_entity_1 = require("../status-store/entities/status-update.entity");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const hooks_1 = require("../../core/hooks");
const session_engine_controls_1 = require("./session-engine-controls");
const session_lifecycle_fences_1 = require("./session-lifecycle-fences");
const session_engine_leaf_events_1 = require("./session-engine-leaf-events");
const message_send_service_1 = require("../message/message-send.service");
const session_service_1 = require("./session.service");
const send_pacing_service_1 = require("../message/send-pacing.service");
const status_store_service_1 = require("../status-store/status-store.service");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const session_write_scope_1 = require("../../common/utils/session-write-scope");
const shared_connection_1 = require("../../common/utils/shared-connection");
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const entities = [
    session_entity_1.Session,
    message_entity_1.Message,
    message_batch_entity_1.MessageBatch,
    send_idempotency_key_entity_1.SendIdempotencyKey,
    webhook_entity_1.Webhook,
    webhook_outbox_event_entity_1.WebhookOutboxEvent,
    webhook_delivery_failure_entity_1.WebhookDeliveryFailure,
    integration_delivery_failure_entity_1.IntegrationDeliveryFailure,
    template_entity_1.Template,
    baileys_stored_message_entity_1.BaileysStoredMessage,
    baileys_chat_state_entity_1.ChatState,
    status_update_entity_1.StatusUpdate,
];
describe('Session content lifetime', () => {
    let db;
    let controls;
    let engines;
    let hooks;
    let purgeSessionData;
    const config = new config_1.ConfigService({});
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    beforeEach(async () => {
        purgeSessionData = jest.fn().mockResolvedValue(undefined);
        db = new typeorm_1.DataSource(process.env.DATABASE_TYPE === 'postgres'
            ? {
                type: 'postgres',
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 5432),
                username: process.env.DATABASE_USERNAME || 'openwa',
                password: process.env.DATABASE_PASSWORD || 'openwa',
                database: process.env.DATABASE_NAME || 'openwa',
                schema: `session_content_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`,
                entities,
                synchronize: false,
            }
            : { type: 'better-sqlite3', database: ':memory:', entities, synchronize: true });
        await db.initialize();
        if (db.options.type === 'postgres') {
            await db.query(`CREATE SCHEMA "${db.options.schema}"`);
            await db.synchronize();
        }
        engines = new engine_registry_service_1.EngineRegistry();
        hooks = new hooks_1.HookManager();
        const state = { attachTo: (value) => value, clear: jest.fn() };
        const fences = new session_lifecycle_fences_1.SessionLifecycleFences({
            engines,
            pendingTeardowns: new Map(),
            pendingInitialStatuses: new Map(),
            logger: logger,
        });
        controls = new session_engine_controls_1.SessionEngineControls({
            sessionRepository: db.getRepository(session_entity_1.Session),
            engineFactory: { purgeSessionData },
            engines,
            sessionErrors: state,
            sessionRestrictions: state,
            presence: state,
            hookManager: hooks,
            configService: config,
            logger,
            dataSource: () => db,
            fences,
            broadcaster: state,
            cancelReconnect() { },
            isClosed: () => false,
            ownsSession: () => true,
            stoppingSessions: new session_engine_controls_1.StopMarks(),
            operatorTeardowns: new Map(),
            reconnectStates: new Map(),
            stuckAuthRecoveryUsed: new Set(),
            initializingSessions: new Set(),
        });
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        if (db.isInitialized) {
            if (db.options.type === 'postgres')
                await db.query(`DROP SCHEMA "${db.options.schema}" CASCADE`);
            await db.destroy();
        }
    });
    async function createSession() {
        return db.getRepository(session_entity_1.Session).save({ name: 'test-session', config: {} });
    }
    // A SQLite batch is sized by how long the last one took, which a real database makes unrepeatable. A clock that
    // reads the target later on every call makes each batch look on target, so every batch has the size of the first
    // (PostgreSQL batches are a fixed size and ignore the clock).
    function holdBatchSize() {
        let now = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => (now += session_engine_controls_1.SESSION_DELETE_BATCH_TARGET_MS_SQLITE));
        return db.options.type === 'postgres' ? session_engine_controls_1.SESSION_DELETE_BATCH_SIZE_POSTGRES : session_engine_controls_1.SESSION_DELETE_BATCH_MIN_SQLITE;
    }
    function sender(engine, sessionId) {
        engines.set(sessionId, engine);
        return new message_send_service_1.MessageSendService(db.getRepository(message_entity_1.Message), {
            findOne: (id) => db.getRepository(session_entity_1.Session).findOneByOrFail({ id }),
        }, engines, hooks, {}, new send_pacing_service_1.SendPacingService(db.getRepository(message_entity_1.Message), db.getRepository(session_entity_1.Session), new config_1.ConfigService({})), new config_1.ConfigService({ features: { simulateTyping: false } }));
    }
    it.each(['accepted', 'refused'])('keeps deleted messages absent when an %s engine call settles', async (outcome) => {
        const session = await createSession();
        const started = deferred();
        const result = deferred();
        const service = sender({
            sendChatState: () => Promise.resolve(),
            forceDestroy: () => Promise.resolve(),
            sendTextMessage: () => {
                started.resolve();
                return result.promise;
            },
        }, session.id);
        const oldTyping = process.env.SIMULATE_TYPING;
        process.env.SIMULATE_TYPING = 'false';
        try {
            const send = service.sendText(session.id, { chatId: '10000000001@c.us', text: 'test body' });
            const settled = send.then(() => undefined, () => undefined);
            await started.promise;
            await controls.delete(session.id);
            expect(await db.getRepository(message_entity_1.Message).count()).toBe(0);
            if (outcome === 'accepted')
                result.resolve({ id: 'sent-id', timestamp: 1700000000 });
            else
                result.reject(new engine_not_ready_error_1.EngineNotReadyError());
            await settled;
            expect(await db.getRepository(message_entity_1.Message).count()).toBe(0);
        }
        finally {
            if (oldTyping === undefined)
                delete process.env.SIMULATE_TYPING;
            else
                process.env.SIMULATE_TYPING = oldTyping;
        }
    });
    it('drains an admitted initial database write before removing its parent', async () => {
        const session = await createSession();
        const service = sender({ forceDestroy: () => Promise.resolve() }, session.id);
        const repo = db.getRepository(message_entity_1.Message);
        const save = repo.save.bind(repo);
        const started = deferred();
        const resume = deferred();
        jest.spyOn(repo, 'save').mockImplementationOnce(async (value) => {
            started.resolve();
            await resume.promise;
            return save(value);
        });
        const write = service.saveOutgoingMessage(session.id, { chatId: '10000000001@c.us', type: 'text', body: 'test' });
        const settled = write.then(() => undefined, () => undefined);
        await started.promise;
        const deletion = controls.delete(session.id);
        await new Promise(setImmediate);
        resume.resolve();
        await Promise.all([deletion, settled]);
        expect(await db.getRepository(session_entity_1.Session).count()).toBe(0);
        expect(await repo.count()).toBe(0);
    });
    it.each(['success', 'failure'])('does not recreate a status after a late media %s', async (outcome) => {
        const session = await createSession();
        const started = deferred();
        const media = deferred();
        const store = new status_store_service_1.StatusStoreService(db.getRepository(status_update_entity_1.StatusUpdate), {
            putFile: () => {
                started.resolve();
                return media.promise;
            },
        }, config);
        const ingest = store.ingest(session.id, {
            waStatusId: 'story',
            contactJid: '10000000001@c.us',
            type: 'image',
            caption: 'test story',
            postedAt: Date.now(),
            media: { data: Buffer.from('test').toString('base64'), mimetype: 'image/png' },
        });
        await started.promise;
        await controls.delete(session.id);
        if (outcome === 'success')
            media.resolve();
        else
            media.reject(new Error('storage unavailable'));
        await ingest;
        expect(await db.getRepository(status_update_entity_1.StatusUpdate).count()).toBe(0);
        expect(await store.list(session.id)).toEqual([]);
    });
    it.each([false, true])('drops a seed after a deleted parent, including same-id replacement=%s', async (recreate) => {
        const session = await createSession();
        const id = session.id;
        const started = deferred();
        const poster = deferred();
        const engine = {
            forceDestroy: () => Promise.resolve(),
            getChatHistory: () => Promise.resolve([
                {
                    id: 'story',
                    isStatusBroadcast: true,
                    author: '10000000001@c.us',
                    from: 'status@broadcast',
                    fromMe: false,
                    type: 'text',
                    body: 'test story',
                    timestamp: Math.floor(Date.now() / 1000),
                },
            ]),
            getContactById: () => {
                started.resolve();
                return poster.promise;
            },
        };
        engines.set(id, engine);
        const store = new status_store_service_1.StatusStoreService(db.getRepository(status_update_entity_1.StatusUpdate), {}, config);
        const leaf = new session_engine_leaf_events_1.SessionEngineLeafEvents({
            sessionRepository: db.getRepository(session_entity_1.Session),
            statusStore: store,
            configService: config,
            logger,
        });
        const seed = leaf.seedStatuses(id, engine);
        await started.promise;
        await controls.delete(id);
        if (recreate)
            await db.getRepository(session_entity_1.Session).save({ id, name: 'replacement', config: {} });
        poster.reject(new Error('engine closed'));
        await seed;
        expect(await db.getRepository(status_update_entity_1.StatusUpdate).count()).toBe(0);
    });
    it('stops the status seed at the first item after its session is retired', async () => {
        const session = await createSession();
        const id = session.id;
        const history = Array.from({ length: 200 }, (_, index) => ({
            id: `story-${index}`,
            isStatusBroadcast: true,
            author: '10000000001@c.us',
            from: 'status@broadcast',
            fromMe: false,
            type: 'text',
            body: `story ${index}`,
            timestamp: Math.floor(Date.now() / 1000),
        }));
        const engine = {
            getChatHistory: () => Promise.resolve(history),
            getContactById: jest.fn().mockResolvedValue(null),
        };
        const store = new status_store_service_1.StatusStoreService(db.getRepository(status_update_entity_1.StatusUpdate), {}, config);
        const ingest = store.ingest.bind(store);
        let deletion;
        const ingested = jest.spyOn(store, 'ingest').mockImplementation(async (...args) => {
            const stored = await ingest(...args);
            deletion ??= (0, session_write_scope_1.closeSessionWrites)(db, id);
            return stored;
        });
        const warn = jest.fn();
        const leaf = new session_engine_leaf_events_1.SessionEngineLeafEvents({
            sessionRepository: db.getRepository(session_entity_1.Session),
            statusStore: store,
            configService: config,
            logger: { ...logger, warn },
        });
        await leaf.seedStatuses(id, engine);
        deletion?.release();
        expect(ingested).toHaveBeenCalledTimes(1);
        expect(warn).not.toHaveBeenCalled();
        expect(await db.getRepository(status_update_entity_1.StatusUpdate).count()).toBe(1);
    });
    it('refuses a pre-send continuation after the session id was replaced', async () => {
        const session = await createSession();
        const id = session.id;
        const started = deferred();
        const resume = deferred();
        hooks.register('test-plugin', 'message:sending', async (context) => {
            started.resolve();
            await resume.promise;
            return { continue: true, data: context.data };
        });
        const service = sender({ forceDestroy: () => Promise.resolve() }, id);
        const send = service.sendText(id, { chatId: '10000000001@c.us', text: 'test body' });
        const settled = send.then(() => 'sent', () => 'refused');
        await started.promise;
        await controls.delete(id);
        await db.getRepository(session_entity_1.Session).save({ id, name: 'replacement', config: {} });
        const replacementSend = jest.fn().mockResolvedValue({ id: 'new-message', timestamp: 1700000000 });
        engines.set(id, {
            sendTextMessage: replacementSend,
            sendChatState: () => Promise.resolve(),
        });
        resume.resolve();
        expect(await settled).toBe('refused');
        expect(replacementSend).not.toHaveBeenCalled();
        expect(await db.getRepository(message_entity_1.Message).count()).toBe(0);
    });
    it('removes the messages, outbox events and delivery failures of a session in batches and leaves other sessions alone', async () => {
        const doomed = await createSession();
        const kept = await db.getRepository(session_entity_1.Session).save({ name: 'kept-session', config: {} });
        const messages = db.getRepository(message_entity_1.Message);
        const outbox = db.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const failures = db.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
        const batch = holdBatchSize();
        const count = batch * 2 + 50;
        const seed = async (sessionId, rows) => {
            for (let from = 0; from < rows; from += 200) {
                const size = Math.min(200, rows - from);
                const range = Array.from({ length: size }, (_, i) => from + i);
                await messages.insert(range.map(i => ({
                    sessionId,
                    chatId: '10000000001@c.us',
                    from: 'me',
                    to: '10000000001@c.us',
                    body: `m${i}`,
                })));
                await outbox.insert(range.map(i => ({
                    webhookId: 'hook-1',
                    sessionId,
                    event: 'message.received',
                    idempotencyKey: `${sessionId}-${i}`,
                    deliveryId: `dlv-${sessionId}-${i}`,
                    payload: null,
                    state: 'dispatched',
                })));
                await failures.insert(range.map(i => ({
                    sessionId,
                    webhookId: 'hook-1',
                    event: 'message.received',
                    url: 'https://receiver.example',
                    idempotencyKey: `${sessionId}-${i}`,
                    attempts: 3,
                    lastError: 'HTTP 503',
                    payload: {},
                })));
            }
        };
        await seed(doomed.id, count);
        await seed(kept.id, 3);
        const deletes = jest.spyOn(typeorm_1.Repository.prototype, 'delete');
        await controls.delete(doomed.id);
        expect(await messages.countBy({ sessionId: doomed.id })).toBe(0);
        expect(await outbox.countBy({ sessionId: doomed.id })).toBe(0);
        expect(await failures.countBy({ sessionId: doomed.id })).toBe(0);
        expect(await messages.countBy({ sessionId: kept.id })).toBe(3);
        expect(await outbox.countBy({ sessionId: kept.id })).toBe(3);
        expect(await failures.countBy({ sessionId: kept.id })).toBe(3);
        expect(await db.getRepository(session_entity_1.Session).findOneBy({ id: doomed.id })).toBeNull();
        // Three statements per table instead of one that holds the table for every row at once, each by
        // primary key alone: a sessionId condition beside the id list makes the database walk the session's
        // remaining rows on every batch.
        for (const target of [message_entity_1.Message, webhook_outbox_event_entity_1.WebhookOutboxEvent, webhook_delivery_failure_entity_1.WebhookDeliveryFailure]) {
            const calls = deletes.mock.calls.filter((_, index) => deletes.mock.contexts[index].target === target);
            expect(calls).toHaveLength(3);
            for (const [criteria] of calls)
                expect(Object.keys(criteria)).toEqual(['id']);
        }
    }, 60000);
    // The outbox records and the delivery failures have no index that orders a session's rows, so a read after every
    // batch goes back over the session's whole range, including the entries of deleted rows that PostgreSQL keeps
    // until a vacuum. There one read feeds several batches. The closing transaction is replaced here so that what
    // is left of the session when the batches are done is what the batches themselves left.
    it('empties the outbox records and delivery failures of a long session in the batches, one read feeding several on PostgreSQL', async () => {
        const doomed = await createSession();
        const kept = await db.getRepository(session_entity_1.Session).save({ name: 'kept-session', config: {} });
        const outbox = db.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const failures = db.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
        const batch = holdBatchSize();
        const postgres = db.options.type === 'postgres';
        const window = postgres ? batch * session_engine_controls_1.SESSION_DELETE_READ_AHEAD_POSTGRES : batch;
        const rows = window + 2 * batch + 7;
        const chunk = postgres ? 1000 : 100;
        const seed = async (sessionId, count) => {
            for (let from = 0; from < count; from += chunk) {
                const range = Array.from({ length: Math.min(chunk, count - from) }, (_, i) => from + i);
                await outbox.insert(range.map(i => ({
                    webhookId: 'hook-1',
                    sessionId,
                    event: 'message.received',
                    idempotencyKey: `${sessionId}-${i}`,
                    deliveryId: `dlv-${sessionId}-${i}`,
                    payload: null,
                    state: 'dispatched',
                })));
                await failures.insert(range.map(i => ({
                    sessionId,
                    webhookId: 'hook-1',
                    event: 'message.received',
                    url: 'https://receiver.example',
                    idempotencyKey: `${sessionId}-${i}`,
                    attempts: 3,
                    lastError: 'HTTP 503',
                    payload: {},
                })));
            }
        };
        await seed(doomed.id, rows);
        await seed(kept.id, 3);
        const outboxReads = jest.spyOn(outbox, 'find');
        const failureReads = jest.spyOn(failures, 'find');
        jest.spyOn(typeorm_1.EntityManager.prototype, 'remove').mockRejectedValue(new Error('closing transaction not under test'));
        await expect(controls.delete(doomed.id)).rejects.toThrow('closing transaction not under test');
        expect(await outbox.countBy({ sessionId: doomed.id })).toBe(0);
        expect(await failures.countBy({ sessionId: doomed.id })).toBe(0);
        expect(await outbox.countBy({ sessionId: kept.id })).toBe(3);
        expect(await failures.countBy({ sessionId: kept.id })).toBe(3);
        for (const reads of [outboxReads, failureReads]) {
            expect(reads.mock.calls.map(([options]) => options.take)).toEqual(Array(Math.ceil(rows / window)).fill(window));
        }
    }, 60000);
    // Each page of messages starts after the last row of the one before, in (timestamp, id) order with the rows
    // that have no timestamp last. A select that restarted from the head of the session's range would hand out the
    // first page again when its rows are still there, and walk every deleted entry of the index when they are not.
    // The deletes are suppressed here so the only thing that can move the second page on is the cursor.
    it('reads each page of messages after the last row of the previous one', async () => {
        const doomed = await createSession();
        const kept = await db.getRepository(session_entity_1.Session).save({ name: 'kept-session', config: {} });
        const messages = db.getRepository(message_entity_1.Message);
        // Fast batches: a SQLite delete doubles from the floor until it reaches the ceiling.
        let now = 0;
        jest.spyOn(performance, 'now').mockImplementation(() => (now += 1));
        const ramp = db.options.type === 'postgres' ? [500, 500, 500] : [session_engine_controls_1.SESSION_DELETE_BATCH_MIN_SQLITE, 500, 1000];
        const stamped = ramp.reduce((sum, size) => sum + size, 0) + 50;
        const unstamped = 30;
        const seed = async (sessionId, from, rows, timestamp) => {
            for (let done = 0; done < rows; done += 200) {
                const size = Math.min(200, rows - done);
                await messages.insert(Array.from({ length: size }, (_, i) => ({
                    sessionId,
                    chatId: '10000000001@c.us',
                    from: 'me',
                    to: '10000000001@c.us',
                    body: `m${from + done + i}`,
                    // Seven rows share each timestamp, so a page boundary falls inside a run of equal timestamps.
                    timestamp: timestamp(from + done + i),
                })));
            }
        };
        await seed(doomed.id, 0, stamped, i => 1700000000 + Math.floor(i / 7));
        await seed(doomed.id, stamped, unstamped, () => null);
        await seed(kept.id, 0, 3, i => 1700000000 + i);
        const stored = new Map((await messages.find({ where: { sessionId: doomed.id }, select: { id: true, timestamp: true } })).map(row => [
            row.id,
            row.timestamp === null ? null : Number(row.timestamp),
        ]));
        const pages = [];
        const remove = Reflect.get(typeorm_1.Repository.prototype, 'delete');
        jest.spyOn(typeorm_1.Repository.prototype, 'delete').mockImplementation(function (criteria) {
            if (this.target !== message_entity_1.Message)
                return remove.call(this, criteria);
            if (pages.length >= 20)
                throw new Error('the pages are not advancing');
            pages.push(criteria.id.value.slice());
            return Promise.resolve({ raw: [], affected: 0 });
        });
        jest.spyOn(typeorm_1.EntityManager.prototype, 'remove').mockRejectedValue(new Error('closing transaction not under test'));
        await expect(controls.delete(doomed.id)).rejects.toThrow('closing transaction not under test');
        const walked = pages.flat();
        expect(new Set(walked).size).toBe(walked.length);
        expect([...walked].sort()).toEqual([...stored.keys()].sort());
        // The full pages of stamped rows and a short one, then the short page of rows without a timestamp.
        expect(pages.map(page => page.length)).toEqual([...ramp, 50, unstamped]);
        const stamps = walked.map(id => stored.get(id));
        const firstUnstamped = stamps.indexOf(null);
        expect(firstUnstamped).toBe(stamped);
        expect(stamps.slice(firstUnstamped).every(stamp => stamp === null)).toBe(true);
        const ordered = stamps.slice(0, firstUnstamped);
        expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
    }, 60000);
    // The auth directories a session's name keyed before 0.23.5 go with it, unless that name is another session's id.
    it('purges the directories its name keyed and withholds a name that is another session id', async () => {
        const repo = db.getRepository(session_entity_1.Session);
        const plain = await repo.save({ name: 'legacy-name', config: {} });
        const other = await repo.save({ name: 'other', config: {} });
        const namedAfterOther = await repo.save({ name: other.id, config: {} });
        await controls.delete(plain.id);
        await controls.delete(namedAfterOther.id);
        expect(purgeSessionData.mock.calls).toEqual([
            [plain.id, 'legacy-name'],
            [namedAfterOther.id, undefined],
        ]);
    });
    // An import accepts any safe key as a session id, which only SQLite can store.
    (process.env.DATABASE_TYPE === 'postgres' ? it.skip : it)('withholds a name that is the id an import gave another session', async () => {
        const repo = db.getRepository(session_entity_1.Session);
        await repo.insert({ id: 'imported-key', name: 'imported', config: {} });
        const namedAfterKey = await repo.save({ name: 'imported-key', config: {} });
        await controls.delete(namedAfterKey.id);
        expect(purgeSessionData.mock.calls).toEqual([[namedAfterKey.id, undefined]]);
    });
    // The SQLite driver resolves every statement within the same tick, so the yield between the batches is the
    // only thing that lets timers, requests and engine callbacks run during a long delete. Each batch statement
    // queues a macrotask; the next one must find it already run. (On PostgreSQL the driver's own I/O gives the
    // loop its turns, so this holds there with or without the yield.)
    it('lets the event loop run between the batch statements of a delete', async () => {
        const doomed = await createSession();
        const messages = db.getRepository(message_entity_1.Message);
        const batch = holdBatchSize();
        const total = batch * 2 + 50;
        for (let from = 0; from < total; from += 200) {
            const size = Math.min(200, total - from);
            await messages.insert(Array.from({ length: size }, (_, i) => ({
                sessionId: doomed.id,
                chatId: '10000000001@c.us',
                from: 'me',
                to: '10000000001@c.us',
                body: `m${from + i}`,
            })));
        }
        const remove = Reflect.get(typeorm_1.Repository.prototype, 'delete');
        let turnRan = true;
        const turnsBeforeStatement = [];
        jest.spyOn(typeorm_1.Repository.prototype, 'delete').mockImplementation(function (criteria) {
            if (this.target !== message_entity_1.Message)
                return remove.call(this, criteria);
            turnsBeforeStatement.push(turnRan);
            turnRan = false;
            setImmediate(() => {
                turnRan = true;
            });
            return remove.call(this, criteria);
        });
        await controls.delete(doomed.id);
        expect(await messages.countBy({ sessionId: doomed.id })).toBe(0);
        expect(turnsBeforeStatement).toEqual([true, true, true]);
    }, 60000);
    // The write scopes a delete closes stay retired when it fails: a batch running for the session stops at
    // its next item without recording anything. The session is still there, so its row would stay PROCESSING.
    describe('a delete that fails after closing the session writes', () => {
        const seedBatch = (sessionId, status, batchId) => db.getRepository(message_batch_entity_1.MessageBatch).save({
            batchId,
            sessionId,
            status,
            messages: [
                {
                    chatId: '10000000001@c.us',
                    type: 'image',
                    content: { image: { base64: 'MEDIA-PAYLOAD', mimetype: 'image/png', caption: 'hi' } },
                },
            ],
            options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
            progress: { total: 1, sent: 0, failed: 0, pending: 1, cancelled: 0 },
            results: [],
        });
        const statuses = async () => (await db.getRepository(message_batch_entity_1.MessageBatch).find({ order: { batchId: 'ASC' } })).map(row => [row.batchId, row.status]);
        it('fails the unfinished batches of the surviving session and strips their media', async () => {
            const session = await createSession();
            const other = await db.getRepository(session_entity_1.Session).save({ name: 'other-session', config: {} });
            await seedBatch(session.id, message_batch_entity_1.BatchStatus.PENDING, 'b-pending');
            await seedBatch(session.id, message_batch_entity_1.BatchStatus.PROCESSING, 'b-processing');
            await seedBatch(session.id, message_batch_entity_1.BatchStatus.COMPLETED, 'b-done');
            await seedBatch(other.id, message_batch_entity_1.BatchStatus.PROCESSING, 'b-other');
            jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
            await expect(controls.delete(session.id)).rejects.toThrow('statement timeout');
            expect(await statuses()).toEqual([
                ['b-done', message_batch_entity_1.BatchStatus.COMPLETED],
                ['b-other', message_batch_entity_1.BatchStatus.PROCESSING],
                ['b-pending', message_batch_entity_1.BatchStatus.FAILED],
                ['b-processing', message_batch_entity_1.BatchStatus.FAILED],
            ]);
            const failed = await db.getRepository(message_batch_entity_1.MessageBatch).find({ where: { status: message_batch_entity_1.BatchStatus.FAILED } });
            for (const row of failed) {
                expect(row.completedAt).toBeInstanceOf(Date);
                expect(JSON.stringify(row.messages)).not.toContain('MEDIA-PAYLOAD');
                expect(JSON.stringify(row.messages)).toContain('hi');
            }
            expect(await db.getRepository(session_entity_1.Session).countBy({ id: session.id })).toBe(1);
        });
        // Left closed, every later send, bulk batch and status ingest of the session fails until the process restarts.
        it('reopens the write scope of the surviving session', async () => {
            const session = await createSession();
            jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
            await expect(controls.delete(session.id)).rejects.toThrow('statement timeout');
            const scope = (0, session_write_scope_1.captureSessionWrites)(db, session.id);
            try {
                expect(() => scope.assertCurrent()).not.toThrow();
            }
            finally {
                scope.close();
            }
        });
        it('leaves the batches alone when the delete is refused before it closes anything', async () => {
            const session = await createSession();
            await seedBatch(session.id, message_batch_entity_1.BatchStatus.PROCESSING, 'b-processing');
            jest
                .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
                .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is still running'));
            await expect(controls.delete(session.id)).rejects.toThrow(common_1.ConflictException);
            expect(await statuses()).toEqual([['b-processing', message_batch_entity_1.BatchStatus.PROCESSING]]);
        });
        it('still reports the delete error when the batches cannot be failed either', async () => {
            const session = await createSession();
            await seedBatch(session.id, message_batch_entity_1.BatchStatus.PROCESSING, 'b-processing');
            jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
            const find = Reflect.get(typeorm_1.Repository.prototype, 'find');
            jest.spyOn(typeorm_1.Repository.prototype, 'find').mockImplementation(function (options) {
                if (this.target === message_batch_entity_1.MessageBatch)
                    return Promise.reject(new Error('connection lost'));
                return find.call(this, options);
            });
            await expect(controls.delete(session.id)).rejects.toThrow('statement timeout');
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('after a failed delete'), expect.objectContaining({ action: 'session_delete_batch_fail_failed' }));
        });
        it('does not touch the batches of a delete that committed', async () => {
            const session = await createSession();
            await seedBatch(session.id, message_batch_entity_1.BatchStatus.PROCESSING, 'b-processing');
            await controls.delete(session.id);
            expect(await statuses()).toEqual([]);
        });
    });
    // On SQLite every query runner is the one connection, and a transaction opened while another is open there
    // becomes a savepoint inside it: the rows the delete removed would come back when that one rolls back, after
    // the delete had answered. On PostgreSQL the other transaction holds a pooled client of its own.
    describe('a delete beside another transaction on the data connection', () => {
        const gone = { sessions: 0, messages: 0, batches: 0 };
        async function seedContent(name) {
            const session = await db.getRepository(session_entity_1.Session).save({ name, config: {} });
            await db
                .getRepository(message_entity_1.Message)
                .insert({ sessionId: session.id, chatId: '10000000001@c.us', from: 'me', to: '10000000001@c.us', body: 'm' });
            await db.getRepository(message_batch_entity_1.MessageBatch).save({
                batchId: `b-${name}`,
                sessionId: session.id,
                status: message_batch_entity_1.BatchStatus.PENDING,
                messages: [],
                options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
                progress: { total: 0, sent: 0, failed: 0, pending: 0, cancelled: 0 },
                results: [],
            });
            return session.id;
        }
        const rowsOf = async (sessionId) => ({
            sessions: await db.getRepository(session_entity_1.Session).countBy({ id: sessionId }),
            messages: await db.getRepository(message_entity_1.Message).countBy({ sessionId }),
            batches: await db.getRepository(message_batch_entity_1.MessageBatch).countBy({ sessionId }),
        });
        /** A transaction someone else opened on the connection, held until the test ends it. */
        async function openTransaction() {
            const runner = db.createQueryRunner();
            await runner.connect();
            await runner.startTransaction();
            return runner;
        }
        it.each(['rolls back', 'commits'])('removes every row of the session when a transaction open beside it %s', async (ending) => {
            const id = await seedContent('doomed');
            const other = await openTransaction();
            const deletion = controls.delete(id);
            await new Promise(resolve => setTimeout(resolve, 50));
            if (ending === 'rolls back')
                await other.rollbackTransaction();
            else
                await other.commitTransaction();
            await other.release();
            await deletion;
            expect(await rowsOf(id)).toEqual(gone);
        });
        // Begun from the session:deleted hook a number of promise steps later, in the same turn of the event loop, as a
        // session create does when another session holds its name. Over this range it begins before, during and after
        // the delete's closing transaction.
        it('keeps its closing transaction its own against one begun in the same turn', async () => {
            await db.getRepository(session_entity_1.Session).save({ name: 'taken', config: {} });
            let steps = 0;
            let create = Promise.resolve();
            hooks.register('test', 'session:deleted', () => {
                create = (async () => {
                    for (let i = 0; i < steps; i += 1)
                        await Promise.resolve();
                    await db.transaction(manager => manager.save(manager.create(session_entity_1.Session, { name: 'taken', config: {} })));
                })().catch(() => undefined);
                return Promise.resolve({ continue: true });
            });
            for (; steps <= 100; steps += 1) {
                const id = await seedContent(`doomed-${steps}`);
                const outcome = await controls.delete(id).then(() => 'deleted', (error) => String(error));
                await create;
                expect({ steps, outcome, ...(await rowsOf(id)) }).toEqual({ steps, outcome: 'deleted', ...gone });
            }
        }, 60000);
        it('fails the batches of a failed delete outside a transaction opened beside it', async () => {
            const id = await seedContent('doomed');
            let ended = Promise.resolve();
            jest.spyOn(db, 'transaction').mockImplementationOnce(async () => {
                const other = await openTransaction();
                ended = new Promise(resolve => setTimeout(resolve, 20))
                    .then(() => other.rollbackTransaction())
                    .then(() => other.release());
                throw new Error('closing transaction failed');
            });
            await expect(controls.delete(id)).rejects.toThrow('closing transaction failed');
            await ended;
            expect((await db.getRepository(message_batch_entity_1.MessageBatch).findOneByOrFail({ sessionId: id })).status).toBe(message_batch_entity_1.BatchStatus.FAILED);
        });
        (process.env.DATABASE_TYPE === 'postgres' ? it.skip : it)('refuses with 503 and removes nothing more when a transaction beside it stays open', async () => {
            const id = await seedContent('doomed');
            const other = await openTransaction();
            const start = Date.now();
            let calls = 0;
            const clock = jest.spyOn(Date, 'now').mockImplementation(() => start + shared_connection_1.FOREIGN_TRANSACTION_WAIT_MS * calls++);
            await expect(controls.delete(id)).rejects.toThrow(common_1.ServiceUnavailableException);
            clock.mockRestore();
            await other.rollbackTransaction();
            await other.release();
            expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, batches: 1 });
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not fail the unfinished batches'), expect.objectContaining({
                action: 'session_delete_batch_fail_failed',
                error: expect.stringContaining('another database transaction stayed open'),
            }));
        });
    });
    // Both creates pass the name check, so one loses on the unique index. On SQLite, begun in the same turn of the
    // event loop, the loser's transaction would be a savepoint in the winner's, or the reverse.
    describe('two creates of one name begun in the same turn', () => {
        let sessions;
        beforeEach(() => {
            const attach = { attachTo: (session) => session };
            const unused = {};
            sessions = new session_service_1.SessionService(db.getRepository(session_entity_1.Session), unused, db, engines, unused, attach, attach, unused, hooks, unused, unused);
        });
        // Over this range the second begins before, during and after the first one's transaction.
        it('store one session and refuse the other', async () => {
            for (let steps = 0; steps <= 40; steps += 1) {
                const name = `twin-${steps}`;
                const second = async () => {
                    for (let i = 0; i < steps; i += 1)
                        await Promise.resolve();
                    return sessions.create({ name });
                };
                const outcomes = await Promise.all([sessions.create({ name }), second()].map(create => create.then(() => 'created', (error) => (error instanceof common_1.ConflictException ? 'refused' : String(error)))));
                const stored = await db.getRepository(session_entity_1.Session).countBy({ name });
                expect({ steps, outcomes: outcomes.sort(), stored }).toEqual({
                    steps,
                    outcomes: ['created', 'refused'],
                    stored: 1,
                });
            }
        });
        (process.env.DATABASE_TYPE === 'postgres' ? it.skip : it)('refuses with 503 and stores nothing when a transaction beside it stays open', async () => {
            const other = db.createQueryRunner();
            await other.connect();
            await other.startTransaction();
            const start = Date.now();
            let calls = 0;
            const clock = jest.spyOn(Date, 'now').mockImplementation(() => start + shared_connection_1.FOREIGN_TRANSACTION_WAIT_MS * calls++);
            await expect(sessions.create({ name: 'held' })).rejects.toThrow(common_1.ServiceUnavailableException);
            clock.mockRestore();
            await other.commitTransaction();
            await other.release();
            expect(await db.getRepository(session_entity_1.Session).countBy({ name: 'held' })).toBe(0);
        });
    });
});
