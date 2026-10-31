"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const message_projector_service_1 = require("./message-projector.service");
const session_engine_controls_1 = require("./session-engine-controls");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
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
const session_write_scope_1 = require("../../common/utils/session-write-scope");
const deferred = () => {
    let resolve;
    const promise = new Promise(done => (resolve = done));
    return { promise, resolve };
};
const settle = () => new Promise(resolve => setImmediate(resolve));
const entries = ['inbound', 'own-send', 'history'];
// The repository delays dispatch to SQLite to model an asynchronous driver operation. Projection,
// write scopes, the database rows and every child/parent deletion use their actual implementations.
describe('Message projection during session deletion', () => {
    let source;
    let messages;
    let projector;
    let controls;
    let engines;
    let engine;
    let id;
    let otherId;
    let beforeWrite;
    let hook;
    let retired;
    beforeEach(async () => {
        source = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            synchronize: true,
            entities: [
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
            ],
        });
        await source.initialize();
        const sessions = source.getRepository(session_entity_1.Session);
        id = (await sessions.save({ name: 'projected', config: {} })).id;
        otherId = (await sessions.save({ name: 'other', config: {} })).id;
        messages = source.getRepository(message_entity_1.Message);
        await messages.insert({
            sessionId: otherId,
            waMessageId: 'other',
            chatId: '200@c.us',
            from: '200@c.us',
            to: '300@c.us',
            body: 'other payload',
        });
        beforeWrite = jest.fn().mockResolvedValue(undefined);
        const guarded = Object.create(messages);
        guarded.insert = async (entity) => {
            await beforeWrite();
            return messages.insert(entity);
        };
        guarded.createQueryBuilder = (...args) => {
            const query = messages.createQueryBuilder(...args);
            const insert = query.insert.bind(query);
            query.insert = () => {
                const writing = insert();
                const execute = writing.execute.bind(writing);
                writing.execute = async () => {
                    await beforeWrite();
                    return execute();
                };
                return writing;
            };
            return query;
        };
        engines = new engine_registry_service_1.EngineRegistry();
        engine = { forceDestroy: jest.fn().mockResolvedValue(undefined) };
        engines.set(id, engine);
        retired = deferred();
        engines.onRetire(() => retired.resolve());
        hook = jest.fn((_name, data) => Promise.resolve({ continue: true, data }));
        const hooks = { execute: hook };
        projector = new message_projector_service_1.MessageProjector(guarded, sessions, engines, { emitMessage: jest.fn(), emitMessageSent: jest.fn() }, { dispatch: jest.fn().mockResolvedValue(undefined) }, hooks, {}, {});
        const store = { clear: jest.fn(), attachTo: (row) => row };
        controls = new session_engine_controls_1.SessionEngineControls({
            sessionRepository: sessions,
            engineFactory: { purgeSessionData: jest.fn().mockResolvedValue(undefined) },
            engines,
            sessionErrors: store,
            sessionRestrictions: store,
            presence: store,
            hookManager: hooks,
            logger: { log() { }, warn() { }, error() { }, debug() { } },
            dataSource: () => source,
            fences: {
                awaitPendingTeardown: async () => { },
                awaitInitialStatus: async () => { },
                teardownEngineSafely: async (_id, current, destroy) => {
                    await destroy(current);
                    return true;
                },
            },
            broadcaster: store,
            cancelReconnect() { },
            stoppingSessions: new session_engine_controls_1.StopMarks(),
            operatorTeardowns: new Map(),
            reconnectStates: new Map(),
            stuckAuthRecoveryUsed: new Set(),
            initializingSessions: new Set(),
        });
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await source.destroy();
    });
    const write = async (entry) => {
        const message = {
            id: 'projected-message',
            chatId: '100@c.us',
            from: '100@c.us',
            to: '300@c.us',
            body: 'payload',
            type: 'text',
            timestamp: Math.floor(Date.now() / 1000),
            fromMe: entry === 'own-send',
        };
        if (entry === 'history') {
            await projector.persistHistoryMessages(id, engine, [message]);
            return;
        }
        const ticket = projector.admitInbound(id, engine, {
            id: message.id,
            chatId: message.chatId,
            needsRoom: false,
            status: false,
            fromMe: message.fromMe,
        });
        if (entry === 'inbound') {
            await projector.handleInboundMessage(id, engine, message, ticket)?.settled;
            return;
        }
        projector.handleOwnSendEcho(id, engine, message, ticket);
        const queues = projector;
        const end = Date.now() + 3000;
        while (queues.chatCommits.size) {
            if (Date.now() > end)
                throw new Error('Own-send commit did not settle');
            await settle();
        }
    };
    const expectDeleted = async () => {
        expect(await source.getRepository(session_entity_1.Session).existsBy({ id })).toBe(false);
        expect(await messages.countBy({ sessionId: id })).toBe(0);
        expect(await source.getRepository(session_entity_1.Session).existsBy({ id: otherId })).toBe(true);
        expect(await messages.countBy({ sessionId: otherId })).toBe(1);
    };
    describe.each(entries)('%s', entry => {
        it.each([false, true])('drains a pending insert before deletion, rejecting=%s', async (reject) => {
            const entered = deferred(), release = deferred();
            beforeWrite.mockImplementation(async () => {
                entered.resolve();
                await release.promise;
                if (reject)
                    throw new Error('Insert unavailable');
            });
            const projection = write(entry).catch(error => error);
            await entered.promise;
            const removing = jest.fn();
            const deletion = controls.delete(id, { onRemoving: removing });
            try {
                await retired.promise;
                await settle();
                expect(removing).not.toHaveBeenCalled();
            }
            finally {
                release.resolve();
                await Promise.all([projection, deletion]);
            }
            expect(removing).toHaveBeenCalledTimes(1);
            if (reject && entry === 'history')
                expect(await projection).toEqual(new Error('Insert unavailable'));
            await expectDeleted();
        });
        it('preserves completed persistence and lets an outer write scope drain', async () => {
            const outer = (0, session_write_scope_1.captureSessionWrites)(source, id);
            try {
                await outer.write(() => write(entry));
                expect(await messages.countBy({ sessionId: id })).toBe(1);
                await controls.delete(id);
                await expectDeleted();
            }
            finally {
                outer.close();
            }
        });
    });
    describe.each(['inbound', 'own-send'])('%s retries', entry => {
        it('drains the retry insert before deleting its row', async () => {
            const entered = deferred(), release = deferred();
            beforeWrite.mockRejectedValueOnce(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
            beforeWrite.mockImplementation(async () => {
                entered.resolve();
                await release.promise;
            });
            const projection = write(entry);
            await entered.promise;
            const removing = jest.fn();
            const deletion = controls.delete(id, { onRemoving: removing });
            try {
                await retired.promise;
                await settle();
                expect(removing).not.toHaveBeenCalled();
            }
            finally {
                release.resolve();
                await Promise.all([projection, deletion]);
            }
            expect(beforeWrite).toHaveBeenCalledTimes(2);
            await expectDeleted();
        });
        it('does not hold deletion across retry backoff or retry a retired engine', async () => {
            const failed = deferred();
            beforeWrite.mockImplementation(() => {
                failed.resolve();
                return Promise.reject(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }));
            });
            const projection = write(entry);
            await failed.promise;
            await controls.delete(id);
            await projection;
            expect(beforeWrite).toHaveBeenCalledTimes(1);
            await expectDeleted();
        });
        it('does not hold deletion across a pending hook', async () => {
            const entered = deferred(), release = deferred();
            hook.mockImplementation(async (name, data) => {
                if (name === (entry === 'inbound' ? 'message:received' : 'message:sent')) {
                    entered.resolve();
                    await release.promise;
                }
                return { continue: true, data };
            });
            const projection = write(entry);
            await entered.promise;
            try {
                await controls.delete(id);
            }
            finally {
                release.resolve();
                await projection;
            }
            expect(beforeWrite).not.toHaveBeenCalled();
            await expectDeleted();
        });
    });
});
