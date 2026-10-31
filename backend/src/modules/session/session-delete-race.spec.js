"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const config_1 = require("@nestjs/config");
const typeorm_2 = require("typeorm");
const session_service_1 = require("./session.service");
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const session_engine_controls_1 = require("./session-engine-controls");
const session_error_store_service_1 = require("./session-error-store.service");
const session_restriction_store_service_1 = require("./session-restriction-store.service");
const presence_store_service_1 = require("./presence-store.service");
const session_ownership_service_1 = require("./session-ownership.service");
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
const engine_factory_1 = require("../../engine/engine.factory");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_lid_resolver_service_1 = require("./session-lid-resolver.service");
const session_liveness_watchdog_service_1 = require("./session-liveness-watchdog.service");
const message_projector_service_1 = require("./message-projector.service");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const events_gateway_1 = require("../events/events.gateway");
const webhook_service_1 = require("../webhook/webhook.service");
const hooks_1 = require("../../core/hooks");
const status_store_service_1 = require("../status-store/status-store.service");
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
const deferred = () => {
    let resolve;
    const promise = new Promise(res => (resolve = res));
    return { promise, resolve };
};
const makeEngine = () => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getQRCode: jest.fn().mockReturnValue(null),
});
/**
 * The real SessionService, lifecycle and ownership service on a real SQLite database; the engine, the
 * gateway and the webhook sender are fakes. The delete is held where a session with a long history spends
 * its time, in the batches that remove its messages, after its engine is gone.
 */
describe('A session being deleted', () => {
    let db;
    let module;
    let service;
    let lifecycle;
    let ownership;
    let engineFactory;
    let sessionId;
    let reachedBatch;
    let finishBatch;
    let deletion;
    const config = (nodeId) => new config_1.ConfigService({ session: { nodeId, leaseTtlMs: 60_000, leaseHeartbeatMs: 20_000 } });
    beforeEach(async () => {
        db = new typeorm_2.DataSource({ type: 'better-sqlite3', database: ':memory:', entities, synchronize: true });
        await db.initialize();
        engineFactory = {
            create: jest.fn().mockImplementation(makeEngine),
            purgeSessionData: jest.fn().mockResolvedValue(undefined),
        };
        const values = {
            'session.nodeId': 'node-a',
            'session.leaseTtlMs': 60_000,
            'session.leaseHeartbeatMs': 20_000,
        };
        module = await testing_1.Test.createTestingModule({
            providers: [
                session_service_1.SessionService,
                session_engine_lifecycle_service_1.SessionEngineLifecycle,
                session_error_store_service_1.SessionErrorStore,
                session_restriction_store_service_1.SessionRestrictionStore,
                presence_store_service_1.PresenceStore,
                session_ownership_service_1.SessionOwnershipService,
                { provide: (0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'), useValue: db.getRepository(session_entity_1.Session) },
                { provide: (0, typeorm_1.getRepositoryToken)(message_entity_1.Message, 'data'), useValue: db.getRepository(message_entity_1.Message) },
                { provide: (0, typeorm_1.getDataSourceToken)('data'), useValue: db },
                { provide: engine_factory_1.EngineFactory, useValue: engineFactory },
                engine_registry_service_1.EngineRegistry,
                session_lid_resolver_service_1.SessionLidResolver,
                session_liveness_watchdog_service_1.SessionLivenessWatchdog,
                message_projector_service_1.MessageProjector,
                {
                    provide: events_gateway_1.EventsGateway,
                    useValue: {
                        emitSessionStatus: jest.fn(),
                        emitSessionDisconnected: jest.fn(),
                        emitQRCode: jest.fn(),
                        emitSessionAuthenticated: jest.fn(),
                    },
                },
                { provide: webhook_service_1.WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
                { provide: hooks_1.HookManager, useValue: { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) } },
                {
                    provide: config_1.ConfigService,
                    useValue: { get: jest.fn((key, def) => (key in values ? values[key] : def)) },
                },
                { provide: lid_mapping_store_service_1.LidMappingStoreService, useValue: { remember: jest.fn(), onSecondLid: jest.fn() } },
                { provide: status_store_service_1.StatusStoreService, useValue: { ingest: jest.fn(), captureWrites: jest.fn() } },
            ],
        }).compile();
        service = module.get(session_service_1.SessionService);
        lifecycle = module.get(session_engine_lifecycle_service_1.SessionEngineLifecycle);
        ownership = module.get(session_ownership_service_1.SessionOwnershipService);
        // What SessionService wires at bootstrap, without the interval: renew() asks whether anything still runs.
        ownership.setEngineLiveness(id => lifecycle.isEngineActive(id));
        const row = await db.getRepository(session_entity_1.Session).save({
            name: 'big-session',
            config: {},
            phone: '628111111111',
            status: session_entity_1.SessionStatus.READY,
        });
        sessionId = row.id;
        await service.start(sessionId, { explicit: true });
        expect(service.getEngine(sessionId)).toBeDefined();
        // One stored message is enough: the delete removes it in a batch, and that batch is the one held.
        const messages = db.getRepository(message_entity_1.Message);
        await messages.insert({ sessionId, chatId: '10000000001@c.us', from: 'me', to: '10000000001@c.us', body: 'm' });
        const transaction = db.transaction.bind(db);
        reachedBatch = deferred();
        finishBatch = deferred();
        let transactions = 0;
        jest.spyOn(db, 'transaction').mockImplementation(async (...args) => {
            if (++transactions === 2) {
                reachedBatch.resolve();
                await finishBatch.promise;
            }
            return transaction(...args);
        });
        deletion = service.delete(sessionId);
        await reachedBatch.promise;
    });
    afterEach(async () => {
        finishBatch.resolve();
        await deletion.catch(() => undefined);
        jest.restoreAllMocks();
        await service.onModuleDestroy();
        await db.destroy();
    });
    it('refuses a start and leaves no engine running once the rows are gone', async () => {
        // The engine is gone and the row is still there: the window a start used to slip through.
        expect(service.getEngine(sessionId)).toBeUndefined();
        expect(await db.getRepository(session_entity_1.Session).countBy({ id: sessionId })).toBe(1);
        await expect(service.start(sessionId, { explicit: true })).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        expect(service.getEngine(sessionId)).toBeUndefined();
        expect(engineFactory.create).toHaveBeenCalledTimes(1);
        finishBatch.resolve();
        await deletion;
        expect(await db.getRepository(session_entity_1.Session).countBy({ id: sessionId })).toBe(0);
        expect(service.getEngine(sessionId)).toBeUndefined();
        expect(service.getActiveSessionIds()).toEqual([]);
        expect(ownership.ownedIds()).toEqual([]);
        // The stop of a session that no longer exists answers 404, which it could not if an engine lingered.
        await expect(service.stop(sessionId)).rejects.toThrow('not found');
    });
    it('keeps its lease with the node that is deleting it, so a peer cannot adopt it meanwhile', async () => {
        // Stands in for batches that outlast the lease TTL: without a renewal the peer takes the row.
        await db.getRepository(session_entity_1.Session).update(sessionId, { leaseExpiresAt: new Date(Date.now() - 1_000) });
        const peer = new session_ownership_service_1.SessionOwnershipService(db.getRepository(session_entity_1.Session), config('node-b'));
        await ownership.renew();
        expect(await peer.claim(sessionId)).toBe(false);
        finishBatch.resolve();
        await deletion;
    });
});
