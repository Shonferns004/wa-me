"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const config_1 = require("@nestjs/config");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const typeorm_2 = require("typeorm");
const postgres_utc_1 = require("../../database/postgres-utc");
const session_service_1 = require("./session.service");
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const session_error_store_service_1 = require("./session-error-store.service");
const session_restriction_store_service_1 = require("./session-restriction-store.service");
const presence_store_service_1 = require("./presence-store.service");
const session_ownership_service_1 = require("./session-ownership.service");
const session_lifecycle_fences_1 = require("./session-lifecycle-fences");
const session_engine_controls_1 = require("./session-engine-controls");
const session_entity_1 = require("./entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
const bulk_message_service_1 = require("../message/bulk-message.service");
const message_batch_entity_1 = require("../message/entities/message-batch.entity");
const send_idempotency_key_entity_1 = require("../message/entities/send-idempotency-key.entity");
const webhook_outbox_service_1 = require("../webhook/webhook-outbox.service");
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
const session_takeover_service_1 = require("../takeover/session-takeover.service");
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
    logout: jest.fn().mockResolvedValue(undefined),
    getQRCode: jest.fn().mockReturnValue(null),
});
const lapsed = () => new Date(Date.now() - 1_000);
const inbound = {
    id: 'inbound-after-delete',
    from: '10000000001@c.us',
    to: '628111111111@c.us',
    chatId: '10000000001@c.us',
    body: 'hello',
    type: 'text',
    timestamp: Math.floor(Date.now() / 1000),
    fromMe: false,
    isGroup: false,
    kind: 'individual',
};
/**
 * Two nodes sharing one database, each on its own connection with the real SessionService, lifecycle and
 * ownership service; engines, gateway and webhook sender are fakes. SQLite runs on a file, PostgreSQL in a
 * schema of its own (DATABASE_TYPE=postgres). Node A's delete is held at the session:deleted hook: its
 * engine is gone and the rows it removes are still there.
 */
describe('A session deleted on one node while a peer shares the database', () => {
    const pg = process.env.DATABASE_TYPE === 'postgres';
    let options;
    let dir;
    let a;
    let b;
    let deletion;
    let finish;
    async function bootNode(nodeId) {
        const db = await new typeorm_2.DataSource(options).initialize();
        const engines = [];
        const purge = jest.fn().mockResolvedValue(undefined);
        const hooks = { execute: jest.fn((_event, data) => Promise.resolve({ continue: true, data })) };
        const values = {
            'session.nodeId': nodeId,
            'session.leaseTtlMs': 60_000,
            'session.leaseHeartbeatMs': 20_000,
        };
        const module = await testing_1.Test.createTestingModule({
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
                {
                    provide: engine_factory_1.EngineFactory,
                    useValue: {
                        create: jest.fn(() => {
                            const engine = makeEngine();
                            engines.push(engine);
                            return engine;
                        }),
                        purgeSessionData: purge,
                    },
                },
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
                        emitMessage: jest.fn(),
                    },
                },
                { provide: webhook_service_1.WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
                { provide: hooks_1.HookManager, useValue: hooks },
                {
                    provide: config_1.ConfigService,
                    useValue: { get: jest.fn((key, def) => (key in values ? values[key] : def)) },
                },
                { provide: lid_mapping_store_service_1.LidMappingStoreService, useValue: { remember: jest.fn(), onSecondLid: jest.fn() } },
                { provide: status_store_service_1.StatusStoreService, useValue: { ingest: jest.fn(), captureWrites: jest.fn() } },
            ],
        }).compile();
        const lifecycle = module.get(session_engine_lifecycle_service_1.SessionEngineLifecycle);
        const ownership = module.get(session_ownership_service_1.SessionOwnershipService);
        // What SessionService wires at bootstrap, without the interval: renew() asks whether anything still runs.
        ownership.setEngineLiveness(id => lifecycle.isEngineActive(id));
        ownership.onLeaseLoss(async (ids) => {
            await lifecycle.stopOrphanEngines(ids);
        });
        return { db, service: module.get(session_service_1.SessionService), lifecycle, ownership, engines, hooks, purge };
    }
    beforeEach(async () => {
        if (pg) {
            options = {
                type: 'postgres',
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 5432),
                username: process.env.DATABASE_USERNAME || 'openwa',
                password: process.env.DATABASE_PASSWORD || 'openwa',
                database: process.env.DATABASE_NAME || 'openwa',
                schema: `session_delete_claim_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`,
                entities,
                extra: (0, postgres_utc_1.postgresUtcExtra)(),
            };
            const setup = await new typeorm_2.DataSource(options).initialize();
            await setup.query(`CREATE SCHEMA "${options.schema}"`);
            await setup.synchronize();
            await setup.destroy();
        }
        else {
            dir = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'openwa-delete-claim-'));
            options = { type: 'better-sqlite3', database: (0, path_1.join)(dir, 'data.sqlite'), entities };
            await (await new typeorm_2.DataSource({ ...options, synchronize: true }).initialize()).destroy();
        }
        a = await bootNode('node-a');
        b = await bootNode('node-b');
    });
    afterEach(async () => {
        finish?.();
        await deletion?.catch(() => undefined);
        deletion = finish = undefined;
        jest.restoreAllMocks();
        for (const node of [a, b]) {
            await node.service.onModuleDestroy();
            if (pg && node === b)
                await node.db.query(`DROP SCHEMA "${options.schema}" CASCADE`);
            await node.db.destroy();
        }
        if (dir)
            (0, fs_1.rmSync)(dir, { recursive: true, force: true });
        dir = undefined;
    });
    /** A session with one stored message, written the way node A sees it. */
    async function seed(fields) {
        const row = await a.db
            .getRepository(session_entity_1.Session)
            .save({ name: `s-${(0, crypto_1.randomUUID)().slice(0, 8)}`, config: {}, phone: '628111111111', ...fields });
        await a.db
            .getRepository(message_entity_1.Message)
            .insert({ sessionId: row.id, chatId: '10000000001@c.us', from: 'me', to: '10000000001@c.us', body: 'm' });
        return row.id;
    }
    /** Start node A's delete of `id` and hold it once its engine is gone, before any row is removed. */
    async function startHeldDelete(id) {
        const reached = deferred();
        const release = deferred();
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:deleted') {
                reached.resolve();
                await release.promise;
            }
            return { continue: true, data };
        });
        finish = release.resolve;
        deletion = a.service.delete(id);
        await reached.promise;
    }
    /** Whatever the peer launched receives a message after the delete, as a live engine would. */
    async function peerReceivesAMessage() {
        for (const engine of b.engines) {
            const callbacks = engine.initialize.mock.calls[0][0];
            const receipt = callbacks.onMessage?.({ ...inbound });
            await receipt?.settled;
        }
        // The projector's writes are detached; let them land before counting.
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    async function rowsOf(id) {
        return {
            sessions: await a.db.getRepository(session_entity_1.Session).countBy({ id }),
            messages: await a.db.getRepository(message_entity_1.Message).countBy({ sessionId: id }),
            outbox: await a.db.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent).countBy({ sessionId: id }),
            deliveryFailures: await a.db.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure).countBy({ sessionId: id }),
        };
    }
    /** The request bookkeeping a refused delete must not leave behind. */
    function leftovers(id) {
        return {
            stopMark: a.lifecycle.stoppingSessions.has(id),
            stopCount: a.service.stopRequests.has(id),
        };
    }
    it.each([
        ['before the start clears its stop', 'clear-before', 'stopped'],
        ['after the start clears its stop', 'clear-after', 'stopped'],
        ['before launch', 'hook', null],
        ['during launch', 'initialize', null],
        ['after the start returns', 'returned', null],
        ['before a retried launch', 'retry', null],
    ])('refuses a stale peer stop %s once a live owner has claimed', async (_case, phase, desiredState) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState });
        const claiming = deferred();
        const claimGo = deferred();
        const checked = deferred();
        const stopGo = deferred();
        const reached = deferred();
        const go = deferred();
        const claim = a.ownership.claim.bind(a.ownership);
        jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async (next) => {
            claiming.resolve();
            await claimGo.promise;
            return claim(next);
        });
        const held = b.ownership.isHeldByOtherNode.bind(b.ownership);
        jest.spyOn(b.ownership, 'isHeldByOtherNode').mockImplementationOnce(async (next) => {
            const answer = await held(next);
            checked.resolve();
            await stopGo.promise;
            return answer;
        });
        const sessions = a.db.getRepository(session_entity_1.Session);
        if (phase.startsWith('clear')) {
            const update = sessions.update.bind(sessions);
            jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
                if (patch.desiredState !== null)
                    return update(where, patch);
                if (phase === 'clear-before') {
                    reached.resolve();
                    await go.promise;
                }
                const result = await update(where, patch);
                if (phase === 'clear-after') {
                    reached.resolve();
                    await go.promise;
                }
                return result;
            });
        }
        else if (phase === 'initialize') {
            const engines = a.lifecycle.engines;
            const register = engines.set.bind(engines);
            jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
                engine.initialize.mockImplementation(async () => {
                    reached.resolve();
                    await go.promise;
                });
                return register(next, engine);
            });
        }
        else if (phase !== 'returned') {
            a.hooks.execute.mockImplementation(async (event, data) => {
                if (event === 'session:starting') {
                    reached.resolve();
                    await go.promise;
                }
                return { continue: true, data };
            });
            if (phase === 'retry') {
                jest.spyOn(sessions, 'findOne').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
            }
        }
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        let stopping;
        try {
            await claiming.promise;
            stopping = b.service.stop(id).catch((error) => error);
            await checked.promise;
            claimGo.resolve();
            if (phase === 'returned')
                await starting;
            else
                await reached.promise;
            stopGo.resolve();
            expect(await stopping).toBeInstanceOf(common_1.ConflictException);
            go.resolve();
            expect(await starting).not.toBeInstanceOf(Error);
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({ nodeId: 'node-a', desiredState: null });
            expect(b.service.stopRequests.has(id)).toBe(false);
            expect(b.lifecycle.stoppingSessions.has(id)).toBe(false);
            expect(b.ownership.ownedIds()).toEqual([]);
        }
        finally {
            claimGo.resolve();
            stopGo.resolve();
            go.resolve();
            await Promise.allSettled([starting, stopping]);
        }
    });
    it.each(['final read', 'conditional clear'])('yields before launch when a peer replaces a deleting record before the %s', async (when) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'deleting' });
        const claiming = deferred();
        const claimGo = deferred();
        const checked = deferred();
        const stopGo = deferred();
        const clearing = deferred();
        const clearGo = deferred();
        const claim = a.ownership.claim.bind(a.ownership);
        jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async (next) => {
            claiming.resolve();
            await claimGo.promise;
            return claim(next);
        });
        const held = b.ownership.isHeldByOtherNode.bind(b.ownership);
        jest.spyOn(b.ownership, 'isHeldByOtherNode').mockImplementationOnce(async (next) => {
            const answer = await held(next);
            checked.resolve();
            await stopGo.promise;
            return answer;
        });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        if (when === 'final read') {
            jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
                clearing.resolve();
                await clearGo.promise;
            });
        }
        else {
            jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
                if (patch.desiredState === null) {
                    clearing.resolve();
                    await clearGo.promise;
                }
                return update(where, patch);
            });
        }
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        let stopping;
        try {
            await claiming.promise;
            stopping = b.service.stop(id);
            await checked.promise;
            claimGo.resolve();
            await clearing.promise;
            stopGo.resolve();
            await stopping;
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: 'node-a',
                desiredState: 'deleting-stopped',
            });
            clearGo.resolve();
            expect(await starting).toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(a.engines).toHaveLength(0);
            expect(a.hooks.execute.mock.calls.some(([event]) => event === 'session:starting')).toBe(false);
            expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
            expect(a.ownership.ownedIds()).toEqual([]);
            expect(leftovers(id).stopCount).toBe(false);
        }
        finally {
            claimGo.resolve();
            stopGo.resolve();
            clearGo.resolve();
            await Promise.allSettled([starting, stopping]);
        }
    });
    it.each(['before', 'after'])('keeps a stop on the same owner sent %s the start clears its record', async (when) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        const reached = deferred();
        const go = deferred();
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
            if (patch.desiredState !== null)
                return update(where, patch);
            if (when === 'before') {
                reached.resolve();
                await go.promise;
            }
            const result = await update(where, patch);
            if (when === 'after') {
                reached.resolve();
                await go.promise;
            }
            return result;
        });
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        try {
            await reached.promise;
            await a.service.stop(id);
            go.resolve();
            await starting;
            expect(a.service.getEngine(id)).toBeUndefined();
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({ desiredState: 'stopped', nodeId: null });
            expect(leftovers(id).stopCount).toBe(false);
        }
        finally {
            go.resolve();
            await starting;
        }
    });
    it('answers not found before launch if the session is removed during the conditional clear', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        const clearing = deferred();
        const go = deferred();
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
            if (patch.desiredState === null) {
                clearing.resolve();
                await go.promise;
            }
            return update(where, patch);
        });
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        try {
            await clearing.promise;
            await a.service.delete(id);
            go.resolve();
            expect(await starting).toBeInstanceOf(common_1.NotFoundException);
            expect(a.engines).toHaveLength(0);
            expect(a.hooks.execute.mock.calls.some(([event]) => event === 'session:starting')).toBe(false);
            expect(a.ownership.ownedIds()).toEqual([]);
            expect(leftovers(id).stopCount).toBe(false);
        }
        finally {
            go.resolve();
            await starting;
        }
    });
    it.each([
        ['unclaimed with a retained lease', { nodeId: null, leaseExpiresAt: new Date(Date.now() + 60_000) }, null],
        ['expired', { nodeId: 'departed', leaseExpiresAt: lapsed() }, null],
        ['without a lease', { nodeId: 'departed', leaseExpiresAt: null }, null],
    ])('records a stop when the previous owner is %s', async (_case, fields, nodeId) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, ...fields });
        await b.service.stop(id);
        expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            desiredState: 'stopped',
            nodeId,
        });
        expect(b.service.stopRequests.has(id)).toBe(false);
    });
    it('records a stop after the former owner logged out and released its claim', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.service.start(id, { explicit: true });
        await a.service.logout(id);
        await b.service.stop(id);
        expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            desiredState: 'stopped',
            nodeId: null,
        });
        expect(a.service.getEngine(id)).toBeUndefined();
    });
    it('answers not found when a session disappears while its stop reads it', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = b.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (options) => {
            const row = await findOne(options);
            await a.service.delete(id);
            return row;
        });
        await expect(b.service.stop(id)).rejects.toBeInstanceOf(common_1.NotFoundException);
        expect(b.service.stopRequests.has(id)).toBe(false);
        expect(b.lifecycle.stoppingSessions.has(id)).toBe(false);
    });
    it('kills a stale local engine without recording a stop over its new live owner', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await b.service.start(id, { explicit: true });
        await a.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
        await a.service.start(id, { explicit: true });
        await b.service.forceKill(id);
        expect(b.service.getEngine(id)).toBeUndefined();
        expect(a.service.getEngine(id)).toBe(a.engines[0]);
        expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            desiredState: null,
            nodeId: 'node-a',
        });
        expect(b.service.stopRequests.has(id)).toBe(false);
    });
    it.each([
        ['expired', 'before'],
        ['expired', 'after'],
        ['no lease', 'before'],
        ['no lease', 'after'],
        ['expired', 'initialize'],
        ['no lease', 'initialize'],
    ])('honors an accepted peer stop when the start lease is %s %s its clear', async (lease, when) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        const claimReached = deferred(), claimGo = deferred();
        const peerReached = deferred(), peerGo = deferred();
        const clearReached = deferred(), clearGo = deferred();
        const claim = a.ownership.claim.bind(a.ownership);
        jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async (next) => {
            claimReached.resolve();
            await claimGo.promise;
            return claim(next);
        });
        const peerCheck = b.ownership.isHeldByOtherNode.bind(b.ownership);
        jest.spyOn(b.ownership, 'isHeldByOtherNode').mockImplementationOnce(async (next) => {
            const held = await peerCheck(next);
            peerReached.resolve();
            await peerGo.promise;
            return held;
        });
        const repo = a.db.getRepository(session_entity_1.Session);
        const update = repo.update.bind(repo);
        if (when === 'initialize') {
            const engines = a.lifecycle.engines;
            const register = engines.set.bind(engines);
            jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
                engine.initialize.mockImplementation(async () => {
                    clearReached.resolve();
                    await clearGo.promise;
                });
                return register(next, engine);
            });
        }
        else {
            jest.spyOn(repo, 'update').mockImplementation(async (where, patch) => {
                if (patch.desiredState !== null)
                    return update(where, patch);
                if (when === 'before') {
                    clearReached.resolve();
                    await clearGo.promise;
                }
                const result = await update(where, patch);
                if (when === 'after') {
                    clearReached.resolve();
                    await clearGo.promise;
                }
                return result;
            });
        }
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        await claimReached.promise;
        const stopping = b.service.stop(id);
        try {
            await peerReached.promise;
            claimGo.resolve();
            await clearReached.promise;
            await repo.update(id, { leaseExpiresAt: lease === 'expired' ? lapsed() : null });
            peerGo.resolve();
            await stopping;
            clearGo.resolve();
            await starting;
            const row = await repo.findOneByOrFail({ id });
            expect(a.service.getEngine(id)).toBeUndefined();
            expect(row.desiredState).toBe('stopped');
            if (when !== 'initialize')
                expect(a.engines).toHaveLength(0);
        }
        finally {
            claimGo.resolve();
            peerGo.resolve();
            clearGo.resolve();
            await Promise.allSettled([starting, stopping]);
        }
    });
    it('does not create an engine for a session deleted by a peer during its start hook without ownership', async () => {
        Object.assign(a.service, { ownership: undefined });
        Object.assign(a.lifecycle, { ownership: undefined });
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:starting')
                await b.service.delete(id);
            return { continue: true, data };
        });
        await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.NotFoundException);
        expect(a.engines).toHaveLength(0);
        expect(leftovers(id).stopCount).toBe(false);
    });
    it.each(['before', 'after'])('returns the inactive session when a local stop arrives %s the final admission write', async (when) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const reached = deferred();
        const go = deferred();
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        let admissions = 0;
        jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
            if (patch.desiredState !== null || ++admissions !== 2)
                return update(where, patch);
            if (when === 'before') {
                reached.resolve();
                await go.promise;
            }
            const result = await update(where, patch);
            if (when === 'after') {
                reached.resolve();
                await go.promise;
            }
            return result;
        });
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        try {
            await reached.promise;
            await a.service.stop(id);
            go.resolve();
            expect(await starting).toMatchObject({ id, status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
            expect(a.engines).toHaveLength(0);
            expect(leftovers(id).stopCount).toBe(false);
        }
        finally {
            go.resolve();
            await starting;
        }
    });
    it.each(['first write', 'final write', 'final return'])('preserves an accepted stop when the lease expires during the %s', async (phase) => {
        Object.assign(a.ownership, {
            configService: { get: (key) => ({ 'session.nodeId': 'node-a', 'session.leaseTtlMs': 200 })[key] },
        });
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        const reached = deferred();
        const go = deferred();
        const recorded = deferred();
        const releaseGo = deferred();
        const release = b.ownership.release.bind(b.ownership);
        jest.spyOn(b.ownership, 'release').mockImplementationOnce(async (next) => {
            recorded.resolve();
            await releaseGo.promise;
            return release(next);
        });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        let admissions = 0;
        let expires = new Date();
        jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
            if (patch.desiredState === null && ++admissions === (phase === 'first write' ? 1 : 2)) {
                const result = phase === 'final return' ? await update(where, patch) : undefined;
                expires = (await sessions.findOneByOrFail({ id })).leaseExpiresAt;
                reached.resolve();
                await go.promise;
                if (result)
                    return result;
            }
            return update(where, patch);
        });
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        let stopping;
        try {
            await reached.promise;
            await new Promise(resolve => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now()) + 25));
            stopping = b.service.stop(id);
            await recorded.promise;
            go.resolve();
            await starting;
            expect(a.engines).toHaveLength(0);
            expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
        }
        finally {
            go.resolve();
            releaseGo.resolve();
            await Promise.allSettled([starting, stopping]);
        }
    });
    it.each([
        ['live owner', 'node-a', 'live', 'stopped', true],
        ['live owner without a stop', 'node-a', 'live', null, true],
        ['changed stop record', 'node-a', 'live', 'deleting', false],
        ['foreign owner', 'node-b', 'live', 'stopped', false],
        ['released owner', null, 'live', 'stopped', false],
        ['expired owner', 'node-a', 'expired', 'stopped', false],
        ['owner without a lease', 'node-a', 'missing', 'stopped', false],
    ])('admits only the recorded state of the %s', async (_case, nodeId, lease, desiredState, admitted) => {
        const leaseExpiresAt = lease === 'missing' ? null : new Date(Date.now() + (lease === 'live' ? 5_000 : -1_000));
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, nodeId, leaseExpiresAt, desiredState });
        expect(await a.ownership.prepareStart(id, desiredState === null ? null : 'stopped')).toBe(admitted);
        const row = await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id });
        expect(row.desiredState).toBe(admitted ? null : desiredState);
        expect(row.nodeId).toBe(nodeId);
        if (admitted)
            expect(row.leaseExpiresAt.getTime()).toBeGreaterThan(leaseExpiresAt.getTime());
        else
            expect(row.leaseExpiresAt).toEqual(leaseExpiresAt);
    });
    it.each(['foreign', 'expired', 'missing'])('retires an initializing engine whose ownership becomes %s without a stop', async (loss) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const reached = deferred();
        const go = deferred();
        const engines = a.lifecycle.engines;
        const register = engines.set.bind(engines);
        jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
            engine.initialize.mockImplementation(async () => {
                reached.resolve();
                await go.promise;
            });
            return register(next, engine);
        });
        const starting = a.service.start(id, { explicit: true });
        try {
            await reached.promise;
            await b.db.getRepository(session_entity_1.Session).update(id, {
                nodeId: loss === 'foreign' ? 'node-b' : 'node-a',
                leaseExpiresAt: loss === 'foreign' ? new Date(Date.now() + 60_000) : loss === 'expired' ? lapsed() : null,
            });
            go.resolve();
            await starting;
            expect(a.service.getEngine(id)).toBeUndefined();
            expect(a.engines[0].destroy).toHaveBeenCalled();
            expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        }
        finally {
            go.resolve();
            await starting;
        }
    });
    it.each([
        ['initializing', 'expired'],
        ['started', 'expired'],
        ['initializing', 'missing'],
        ['started', 'missing'],
    ])('retires a %s engine whose lease is %s after a peer stop before renewal', async (phase, lease) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const reached = deferred();
        const go = deferred();
        const recorded = deferred();
        const releaseGo = deferred();
        const engines = a.lifecycle.engines;
        const register = engines.set.bind(engines);
        jest.spyOn(engines, 'set').mockImplementation((next, engine) => {
            engine.initialize.mockImplementation(async () => {
                reached.resolve();
                if (phase === 'initializing')
                    await go.promise;
            });
            return register(next, engine);
        });
        const release = b.ownership.release.bind(b.ownership);
        jest.spyOn(b.ownership, 'release').mockImplementationOnce(async (next) => {
            recorded.resolve();
            await releaseGo.promise;
            return release(next);
        });
        const starting = a.service.start(id, { explicit: true });
        let stopping;
        try {
            if (phase === 'started')
                await starting;
            else
                await reached.promise;
            await a.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lease === 'expired' ? lapsed() : null });
            stopping = b.service.stop(id);
            await recorded.promise;
            await a.ownership.renew();
            releaseGo.resolve();
            await stopping;
            go.resolve();
            await starting;
            expect(a.service.getEngine(id)).toBeUndefined();
            expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
        }
        finally {
            go.resolve();
            releaseGo.resolve();
            await Promise.allSettled([starting, stopping]);
        }
    });
    it('refuses an expired-owner stop when a heartbeat renews before the conditional release', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.service.start(id, { explicit: true });
        await a.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
        const reached = deferred();
        const go = deferred();
        const sessions = b.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
            if (patch.desiredState === 'stopped' && patch.nodeId === null) {
                reached.resolve();
                await go.promise;
            }
            return update(where, patch);
        });
        const stopping = b.service.stop(id).catch((error) => error);
        try {
            await reached.promise;
            await a.ownership.renew();
            go.resolve();
            expect(await stopping).toBeInstanceOf(common_1.ConflictException);
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({ nodeId: 'node-a', desiredState: null });
            expect(b.service.stopRequests.has(id)).toBe(false);
            expect(b.lifecycle.stoppingSessions.has(id)).toBe(false);
        }
        finally {
            go.resolve();
            await stopping;
        }
    });
    (pg ? it : it.skip).each(['stop', 'claim'])('yields admission after an accepted peer %s commits while it waits for a row lock', async (action) => {
        const expires = new Date(Date.now() + 500);
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            desiredState: 'stopped',
            nodeId: 'node-a',
            leaseExpiresAt: expires,
        });
        const [{ pid }] = await a.db.query('SELECT pg_backend_pid() AS pid');
        const lock = b.db.createQueryRunner();
        const sessions = b.db.getRepository(session_entity_1.Session);
        const manager = sessions.manager;
        await lock.connect();
        await lock.startTransaction();
        await lock.manager.getRepository(session_entity_1.Session).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        const preparing = a.ownership.prepareStart(id, 'stopped');
        try {
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                const [activity] = await b.db.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid]);
                if (activity?.wait_event_type === 'Lock') {
                    waiting = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
            await new Promise(resolve => setTimeout(resolve, Math.max(0, expires.getTime() - Date.now()) + 25));
            // Run the real peer operation on the connection holding the row. Its commit changes the
            // tuple the waiting UPDATE must recheck, rather than merely releasing an unchanged lock.
            Object.assign(sessions, { manager: lock.manager });
            if (action === 'stop')
                await b.service.stop(id);
            else
                expect(await b.ownership.claim(id)).toBe(true);
            await lock.commitTransaction();
            expect(await preparing).toBe(false);
            expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
                nodeId: action === 'stop' ? null : 'node-b',
                desiredState: 'stopped',
            });
            expect(b.service.stopRequests.has(id)).toBe(false);
        }
        finally {
            Object.assign(sessions, { manager });
            if (lock.isTransactionActive)
                await lock.rollbackTransaction();
            await lock.release();
            await preparing;
        }
    });
    it('settles abandoned work when an accepted stop clears an expired foreign claim', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, nodeId: 'departed', leaseExpiresAt: lapsed() });
        const settled = jest.fn().mockResolvedValue(undefined);
        b.ownership.onAdoption(settled);
        await b.service.stop(id);
        await new Promise(resolve => setImmediate(resolve));
        expect(settled).toHaveBeenCalledWith(id);
        expect(settled).toHaveBeenCalledTimes(1);
        expect(await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            desiredState: 'stopped',
            nodeId: null,
        });
    });
    it.each(['released', 'same owner'])('does not settle a %s claim as abandoned foreign work', async (owner) => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            nodeId: owner === 'released' ? null : 'node-b',
            leaseExpiresAt: lapsed(),
        });
        const settled = jest.fn().mockResolvedValue(undefined);
        b.ownership.onAdoption(settled);
        expect(await b.ownership.stopExpiredForeignClaim(id)).toBe(false);
        await new Promise(resolve => setImmediate(resolve));
        expect(settled).not.toHaveBeenCalled();
        expect((await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
    });
    const gone = { sessions: 0, messages: 0, outbox: 0, deliveryFailures: 0 };
    it.each([
        ['a stopped session nobody holds', { status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' }],
        [
            'a session whose holder let its lease lapse',
            { status: session_entity_1.SessionStatus.READY, nodeId: 'node-c', leaseExpiresAt: lapsed() },
        ],
    ])('refuses a peer start of %s while the delete runs', async (_case, fields) => {
        const id = await seed(fields);
        await startHeldDelete(id);
        await expect(b.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.ConflictException);
        expect(b.engines).toHaveLength(0);
        finish();
        await deletion;
        await peerReceivesAMessage();
        expect(await rowsOf(id)).toEqual(gone);
        expect(a.ownership.ownedIds()).toEqual([]);
        expect(b.ownership.ownedIds()).toEqual([]);
    });
    it('keeps its claim when a stop on the same node ends while the delete reads the session', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        const reading = deferred();
        const read = deferred();
        // The delete's first row read, which comes after its claim.
        jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args) => {
            reading.resolve();
            await read.promise;
            return findOne(...args);
        });
        const reached = deferred();
        const release = deferred();
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:deleted') {
                reached.resolve();
                await release.promise;
            }
            return { continue: true, data };
        });
        finish = release.resolve;
        deletion = a.service.delete(id);
        await reading.promise;
        await a.service.stop(id);
        expect((await findOne({ where: { id } }))?.nodeId).toBe('node-a');
        read.resolve();
        await reached.promise;
        await expect(b.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.ConflictException);
        expect(b.engines).toHaveLength(0);
        release.resolve();
        await deletion;
        await peerReceivesAMessage();
        expect(await rowsOf(id)).toEqual(gone);
        expect(a.ownership.ownedIds()).toEqual([]);
        expect(b.ownership.ownedIds()).toEqual([]);
    });
    it('leaves a lapsed session to the deleting node when a peer looks for sessions to adopt', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.READY, nodeId: 'node-c', leaseExpiresAt: lapsed() });
        await startHeldDelete(id);
        // Stands in for batches that outlast the lease TTL: the deleting node's heartbeat carries the claim on.
        await a.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
        await a.ownership.renew();
        const takeover = new session_takeover_service_1.SessionTakeoverService(b.service, b.ownership, new config_1.ConfigService({ features: { autoStartSessions: true } }));
        await takeover.sweep();
        expect(b.engines).toHaveLength(0);
        finish();
        await deletion;
        await peerReceivesAMessage();
        expect(await rowsOf(id)).toEqual(gone);
        expect(b.ownership.ownedIds()).toEqual([]);
    });
    // A process that dies while its delete runs never hands the claim back, and the claim lapses. The session it
    // was removing must stay down, wherever it is picked up next.
    it('leaves a session whose deleting node died part-way for no peer to adopt', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await startHeldDelete(id);
        // Node A dies here: nothing resumes its delete or renews its claim.
        await a.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
        const takeover = new session_takeover_service_1.SessionTakeoverService(b.service, b.ownership, new config_1.ConfigService({ features: { autoStartSessions: true } }));
        await takeover.sweep();
        expect(b.engines).toHaveLength(0);
        expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            nodeId: 'node-a',
            desiredState: 'deleting',
        });
    });
    it('keeps a session a failed delete left down until an explicit start', async () => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            desiredState: 'deleting',
            nodeId: 'node-c',
            leaseExpiresAt: lapsed(),
        });
        const takeover = new session_takeover_service_1.SessionTakeoverService(b.service, b.ownership, new config_1.ConfigService({ features: { autoStartSessions: true } }));
        await takeover.sweep();
        expect(b.engines).toHaveLength(0);
        // Refused on the record, before the teardown fence would refuse it for another reason.
        const fence = jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValue(new common_1.ConflictException('a logout teardown is running'));
        await expect(b.service.start(id)).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        fence.mockRestore();
        expect(b.engines).toHaveLength(0);
        await b.service.start(id, { explicit: true });
        expect(b.service.getEngine(id)).toBe(b.engines[0]);
        expect((await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
    });
    it('keeps the record of a delete that lands while an explicit start reads the session again', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        const reading = deferred();
        const read = deferred();
        // The start's second row read, past its teardown fence, is held while the delete records itself.
        jest
            .spyOn(sessions, 'findOne')
            .mockImplementationOnce(findOne)
            .mockImplementationOnce(async (...args) => {
            reading.resolve();
            await read.promise;
            return findOne(...args);
        });
        const starting = a.service.start(id, { explicit: true });
        await reading.promise;
        await startHeldDelete(id);
        read.resolve();
        await expect(starting).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
        finish();
        await deletion;
        expect(await rowsOf(id)).toEqual(gone);
    });
    // A delete records itself as a stop on the row, so the crash above leaves the session down; one that fails
    // before it removes anything takes that record back.
    it.each([
        ['its first teardown fence refuses', 'fence-1'],
        ['its second teardown fence refuses', 'fence-2'],
        ['its row read fails', 'read'],
    ])('leaves the session as it found it when %s', async (_case, failure) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.service.start(id, { explicit: true });
        const fence = jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown');
        if (failure === 'fence-1')
            fence.mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        if (failure === 'fence-2') {
            fence.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new common_1.ConflictException('a logout is running'));
        }
        if (failure === 'read') {
            jest.spyOn(a.db.getRepository(session_entity_1.Session), 'findOne').mockRejectedValueOnce(new Error('connection reset'));
        }
        await expect(a.service.delete(id)).rejects.toThrow();
        const row = await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id });
        expect(row.desiredState).toBeNull();
        // The second fence refuses after the engine is gone, and the claim goes with it.
        expect(row.nodeId).toBe(failure === 'fence-2' ? null : 'node-a');
        expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
        expect(leftovers(id).stopCount).toBe(false);
    });
    it('leaves the session as it found it when a retried delete is refused at the first fence again', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'))
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
    });
    it('refuses the delete and takes nothing down when it cannot record the stop', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.service.start(id, { explicit: true });
        const update = Reflect.get(typeorm_2.Repository.prototype, 'update');
        jest.spyOn(typeorm_2.Repository.prototype, 'update').mockImplementation(function (where, patch) {
            if (patch.desiredState)
                return Promise.reject(new Error('connection reset'));
            return update.call(this, where, patch);
        });
        await expect(a.service.delete(id)).rejects.toThrow('connection reset');
        expect(a.service.getEngine(id)).toBe(a.engines[0]);
        expect(a.engines[0].forceDestroy).not.toHaveBeenCalled();
        expect(leftovers(id)).toEqual({ stopMark: false, stopCount: false });
        expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            nodeId: 'node-a',
            desiredState: null,
        });
    });
    it('keeps the stop and answers the delete error when it cannot take the stop back', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        // The stop is recorded; taking it back fails.
        jest.spyOn(sessions, 'update').mockImplementation((where, patch) => {
            if (patch.desiredState === null)
                return Promise.reject(new Error('connection reset'));
            return update(where, patch);
        });
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
    });
    it('keeps a stop the session already had when its delete fails before removing anything', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
    });
    it.each([['stop'], ['force-kill']])('keeps a %s that began before its delete and is recorded after it, when the delete fails before removing', async (how) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.service.start(id, { explicit: true });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        const update = sessions.update.bind(sessions);
        const recording = deferred();
        const recorded = deferred();
        const reading = deferred();
        const read = deferred();
        // The stop's record is held until the delete has written its own; the delete's row read then fails.
        jest.spyOn(sessions, 'update').mockImplementationOnce(async (...args) => {
            recording.resolve();
            await recorded.promise;
            return update(...args);
        });
        jest
            .spyOn(sessions, 'findOne')
            .mockImplementationOnce(findOne)
            .mockImplementationOnce(async () => {
            reading.resolve();
            await read.promise;
            throw new Error('connection reset');
        });
        const stopping = how === 'stop' ? a.service.stop(id) : a.service.forceKill(id);
        await recording.promise;
        const deleting = a.service.delete(id);
        await reading.promise;
        recorded.resolve();
        await stopping;
        read.resolve();
        await expect(deleting).rejects.toThrow('connection reset');
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
    });
    it('keeps a stop that lands while its delete runs when the delete then fails before removing anything', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const reading = deferred();
        const read = deferred();
        // The delete's first row read, which comes after its claim, fails once the stop has finished.
        jest.spyOn(sessions, 'findOne').mockImplementationOnce(async () => {
            reading.resolve();
            await read.promise;
            throw new Error('connection reset');
        });
        const deleting = a.service.delete(id);
        await reading.promise;
        await a.service.stop(id);
        read.resolve();
        await expect(deleting).rejects.toThrow('connection reset');
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
    });
    it('keeps a stop whose record has landed but not yet returned when its delete fails', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        const reading = deferred();
        const read = deferred();
        jest.spyOn(sessions, 'findOne').mockImplementationOnce(async () => {
            reading.resolve();
            await read.promise;
            throw new Error('connection reset');
        });
        const deleting = a.service.delete(id);
        await reading.promise;
        const landed = deferred();
        const answer = deferred();
        // The stop's record is on the row; its answer is held until the delete has failed.
        jest.spyOn(sessions, 'update').mockImplementationOnce(async (...args) => {
            const result = await update(...args);
            landed.resolve();
            await answer.promise;
            return result;
        });
        const stopping = a.service.stop(id);
        await landed.promise;
        read.resolve();
        await expect(deleting).rejects.toThrow('connection reset');
        answer.resolve();
        await stopping;
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('stopped');
    });
    it('takes its stop back when another delete of it is refused at the first fence too', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.service.start(id, { explicit: true });
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'))
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        const outcomes = await Promise.allSettled([a.service.delete(id), a.service.delete(id)]);
        expect(outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
        expect(a.service.getEngine(id)).toBe(a.engines[0]);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        expect(leftovers(id).stopCount).toBe(false);
    });
    // Each of these begins before the delete and ends, having recorded no stop, before the delete fails.
    it.each([
        ['a force-kill with no engine to kill', 'kill-refused', 'BadRequestException'],
        ['a force-kill that cannot record its stop', 'kill-write', 'ok'],
        ['a stop whose row read fails', 'stop-read', 'Error'],
        ['a stop that cannot record itself', 'stop-write', 'Error'],
    ])('takes its stop back when %s overlaps it', async (_case, other, answer) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        if (other === 'kill-write')
            await a.service.start(id, { explicit: true });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        const reached = deferred();
        const go = deferred();
        // The other request is held at its row read or at its stop record until the delete has begun.
        const hold = async () => {
            reached.resolve();
            await go.promise;
        };
        if (other === 'kill-refused') {
            jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args) => {
                await hold();
                return findOne(...args);
            });
        }
        else if (other === 'stop-read') {
            jest.spyOn(sessions, 'findOne').mockImplementationOnce(async () => {
                await hold();
                throw new Error('connection reset');
            });
        }
        else {
            jest.spyOn(sessions, 'update').mockImplementationOnce(async () => {
                await hold();
                throw new Error('connection reset');
            });
        }
        // The delete waits at its first fence until the other request has answered, and is refused there.
        const fenced = deferred();
        const refuse = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await refuse.promise;
            throw new common_1.ConflictException('a logout teardown is running');
        });
        const request = other.startsWith('kill') ? a.service.forceKill(id) : a.service.stop(id);
        const answered = request.then(() => 'ok', (error) => error.constructor.name);
        await reached.promise;
        const deleting = a.service.delete(id);
        await fenced.promise;
        go.resolve();
        expect(await answered).toBe(answer);
        refuse.resolve();
        await expect(deleting).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBeNull();
        expect(leftovers(id).stopCount).toBe(false);
    });
    it.each([
        ['records it', 'stopped'],
        ['fails to read the session', null],
    ])('leaves the session to a stop still reading it when its delete fails, which then %s', async (_case, after) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        const reading = deferred();
        const read = deferred();
        jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args) => {
            reading.resolve();
            await read.promise;
            if (after === null)
                throw new Error('connection reset');
            return findOne(...args);
        });
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        const stopping = a.service.stop(id).catch((error) => error);
        await reading.promise;
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        read.resolve();
        await stopping;
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe(after);
    });
    // Two deletes of one session share the stop the first of them recorded; the last one out decides.
    it('keeps the session down for a delete still running when another delete of it is refused', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        const reading = deferred();
        const read = deferred();
        // The first delete's row read, which comes after its stop record, is held.
        jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (...args) => {
            reading.resolve();
            await read.promise;
            return findOne(...args);
        });
        const reached = deferred();
        const release = deferred();
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:deleted') {
                reached.resolve();
                await release.promise;
            }
            return { continue: true, data };
        });
        finish = release.resolve;
        deletion = a.service.delete(id);
        await reading.promise;
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
        read.resolve();
        await reached.promise;
        // The rows are being removed: a process that died here would leave the session down.
        expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
        release.resolve();
        await deletion;
        expect(await rowsOf(id)).toEqual(gone);
    });
    /**
     * A failed delete's take-back is held while `next` runs: until `next` has written a stop record or 200 ms
     * have passed, then let go.
     */
    async function duringTakeBack(next, { takeBackFails = false, refusals = 1 } = {}) {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        const clearing = deferred();
        const cleared = deferred();
        let held = false;
        let stopsWritten = 0;
        // Only the first take-back is held, and fails with `takeBackFails`; any later one runs at once.
        jest.spyOn(sessions, 'update').mockImplementation(async (...args) => {
            if (args[1].desiredState === null && !held) {
                held = true;
                clearing.resolve();
                await cleared.promise;
                if (takeBackFails)
                    throw new Error('connection reset');
            }
            const result = await update(...args);
            if (args[1].desiredState)
                stopsWritten++;
            return result;
        });
        // The failed delete is refused at its first fence, and so are the next `refusals - 1` deletes.
        const fence = jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown');
        for (let refused = 0; refused < refusals; refused++) {
            fence.mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        }
        const failing = a.service.delete(id).catch((error) => error);
        await clearing.promise;
        const written = stopsWritten;
        const running = next(id);
        for (let waited = 0; waited < 200 && stopsWritten === written; waited += 5) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        cleared.resolve();
        expect(await failing).toBeInstanceOf(common_1.ConflictException);
        await running;
        return id;
    }
    it('records its own stop when it begins while a failed delete takes its stop back', async () => {
        const reached = deferred();
        const release = deferred();
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:deleted') {
                reached.resolve();
                await release.promise;
            }
            return { continue: true, data };
        });
        finish = release.resolve;
        const id = await duringTakeBack(async (next) => {
            deletion = a.service.delete(next);
            await reached.promise;
        });
        // The rows are being removed: a process that died here would leave the session down.
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBe('deleting');
        release.resolve();
        await deletion;
        expect(await rowsOf(id)).toEqual(gone);
    });
    it('keeps a stop sent while a failed delete takes its stop back', async () => {
        const id = await duringTakeBack(next => a.service.stop(next));
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
        expect(leftovers(id).stopCount).toBe(false);
    });
    it('leaves the take-back to the failed delete when one begun during it ends before recording its own', async () => {
        const id = await duringTakeBack(async (next) => {
            jest.spyOn(a.ownership, 'claim').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
            await expect(a.service.delete(next)).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
            await a.service.stop(next);
        });
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
    });
    it('takes the stop back after a failed take-back when a delete begun during it fails too', async () => {
        const id = await duringTakeBack(next => expect(a.service.delete(next)).rejects.toBeInstanceOf(common_1.ConflictException), {
            takeBackFails: true,
            refusals: 2,
        });
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        expect(leftovers(id).stopCount).toBe(false);
    });
    // The peer's stop passes its own ownership check while nobody holds the session, before this node claims it.
    it('keeps a stop another node records while its delete fails before removing anything', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const peerSessions = b.db.getRepository(session_entity_1.Session);
        const findOne = peerSessions.findOne.bind(peerSessions);
        const reading = deferred();
        const read = deferred();
        jest.spyOn(peerSessions, 'findOne').mockImplementationOnce(async (...args) => {
            reading.resolve();
            await read.promise;
            return findOne(...args);
        });
        const stopping = b.service.stop(id);
        await reading.promise;
        // The delete records its stop and waits at its first fence until the peer's stop has answered.
        const fenced = deferred();
        const refuse = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await refuse.promise;
            throw new common_1.ConflictException('a logout teardown is running');
        });
        const deleting = a.service.delete(id);
        await fenced.promise;
        read.resolve();
        await stopping;
        refuse.resolve();
        await expect(deleting).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
    });
    // The stop is sent while the start waits at its fence, so the start yields to it, and then fails to read the session.
    it('leaves the session as it found it when a start yields to a stop that then fails to read the session', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const fenced = deferred();
        const go = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await go.promise;
        });
        const starting = a.service.start(id, { explicit: true });
        await fenced.promise;
        const reading = deferred();
        const read = deferred();
        jest.spyOn(a.db.getRepository(session_entity_1.Session), 'findOne').mockImplementationOnce(async () => {
            reading.resolve();
            await read.promise;
            throw new Error('connection reset');
        });
        const stopping = a.service.stop(id).catch((error) => error);
        await reading.promise;
        go.resolve();
        await expect(starting).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        read.resolve();
        expect(await stopping).toBeInstanceOf(Error);
        expect(a.engines).toHaveLength(0);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        expect(leftovers(id).stopCount).toBe(false);
    });
    // A start the operator sends with the delete; neither takes anything down, and nobody stopped the session.
    it('leaves the session as it found it when an explicit start and its delete are both refused at the fence', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const fenced = deferred();
        const go = deferred();
        const fence = jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown');
        // The start is held at its fence until the delete has been refused at its own.
        fence.mockImplementationOnce(async () => {
            fenced.resolve();
            await go.promise;
            throw new common_1.ConflictException('a logout teardown is running');
        });
        fence.mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        const starting = a.service.start(id, { explicit: true });
        await fenced.promise;
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        go.resolve();
        await expect(starting).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        expect(leftovers(id).stopCount).toBe(false);
    });
    it('leaves the session as it found it when an explicit start yields to a delete that is then refused', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const claim = a.ownership.claim.bind(a.ownership);
        const claiming = deferred();
        const claimed = deferred();
        // The start's claim goes through; the delete's is held until the start has yielded to it.
        jest
            .spyOn(a.ownership, 'claim')
            .mockImplementationOnce(claim)
            .mockImplementationOnce(async (sessionId) => {
            claiming.resolve();
            await claimed.promise;
            return claim(sessionId);
        });
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        const starting = a.service.start(id, { explicit: true });
        const deleting = a.service.delete(id);
        await claiming.promise;
        await expect(starting).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        claimed.resolve();
        await expect(deleting).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
    });
    // The start clears the stop the session had and launches; the delete sent meanwhile retires it, then is refused.
    it('leaves the stop cleared when a delete that is then refused retires the explicit start that cleared it', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        const starting = deferred();
        const launch = deferred();
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:starting') {
                starting.resolve();
                await launch.promise;
            }
            return { continue: true, data };
        });
        const started = a.service.start(id, { explicit: true });
        await starting.promise;
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        const fenced = deferred();
        const refuse = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await refuse.promise;
            throw new common_1.ConflictException('a logout teardown is running');
        });
        const deleting = a.service.delete(id);
        await fenced.promise;
        launch.resolve();
        await started;
        expect(a.service.getEngine(id)).toBeUndefined();
        refuse.resolve();
        await expect(deleting).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        expect(leftovers(id).stopCount).toBe(false);
    });
    it('lets a start retry its launch when a delete refused at the first fence lands during the retry pause', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const failed = deferred();
        // The start's first row read fails as a dropped connection does, and the start pauses before its one retry.
        jest.spyOn(a.db.getRepository(session_entity_1.Session), 'findOne').mockImplementationOnce(() => {
            failed.resolve();
            return Promise.reject(new Error('Connection terminated unexpectedly'));
        });
        const starting = a.service.start(id, { explicit: true });
        await failed.promise;
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('a logout teardown is running'));
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        await starting;
        expect(a.service.getEngine(id)).toBe(a.engines[0]);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
    });
    /** A delete of a fresh session that waits at its first fence until `refuse` is called, then is refused there. */
    async function deleteHeldAtFirstFence() {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const fenced = deferred();
        const go = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await go.promise;
            throw new common_1.ConflictException('a logout teardown is running');
        });
        const deleting = a.service.delete(id).catch((error) => error);
        await fenced.promise;
        return { id, refuse: go.resolve, deleting };
    }
    // The mirror of the case above it: the delete is sent first, and the start second.
    it('leaves the session as it found it when a delete and then an explicit start are both refused at the fence', async () => {
        const { id, refuse, deleting } = await deleteHeldAtFirstFence();
        const fenced = deferred();
        const go = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await go.promise;
            throw new common_1.ConflictException('a logout teardown is running');
        });
        const starting = a.service.start(id, { explicit: true });
        await fenced.promise;
        refuse();
        expect(await deleting).toBeInstanceOf(common_1.ConflictException);
        go.resolve();
        await expect(starting).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
        expect(leftovers(id).stopCount).toBe(false);
    });
    it('lets a start sent after a delete retry its launch when that delete is refused during the retry pause', async () => {
        const { id, refuse, deleting } = await deleteHeldAtFirstFence();
        const failed = deferred();
        jest.spyOn(a.db.getRepository(session_entity_1.Session), 'findOne').mockImplementationOnce(() => {
            failed.resolve();
            return Promise.reject(new Error('Connection terminated unexpectedly'));
        });
        const starting = a.service.start(id, { explicit: true });
        await failed.promise;
        refuse();
        expect(await deleting).toBeInstanceOf(common_1.ConflictException);
        await starting;
        expect(a.service.getEngine(id)).toBe(a.engines[0]);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
    });
    it.each([
        ['before', 'stop-first'],
        ['after', 'refusal-first'],
    ])('keeps a stop sent while a start waits to retry %s a delete sent before both is refused', async (_case, order) => {
        const { id, refuse, deleting } = await deleteHeldAtFirstFence();
        const failed = deferred();
        jest.spyOn(a.db.getRepository(session_entity_1.Session), 'findOne').mockImplementationOnce(() => {
            failed.resolve();
            return Promise.reject(new Error('Connection terminated unexpectedly'));
        });
        const starting = a.service.start(id, { explicit: true });
        await failed.promise;
        if (order === 'stop-first')
            await a.service.stop(id);
        refuse();
        expect(await deleting).toBeInstanceOf(common_1.ConflictException);
        if (order === 'refusal-first')
            await a.service.stop(id);
        await expect(starting).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        expect(a.engines).toHaveLength(0);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBe('stopped');
        expect(leftovers(id).stopCount).toBe(false);
    });
    it('keeps a start from retrying its launch into a session its delete began removing', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const failed = deferred();
        jest.spyOn(a.db.getRepository(session_entity_1.Session), 'findOne').mockImplementationOnce(() => {
            failed.resolve();
            return Promise.reject(new Error('Connection terminated unexpectedly'));
        });
        const starting = a.service.start(id, { explicit: true });
        await failed.promise;
        // The batches run, then the closing transaction fails: the session stays, with fewer rows.
        jest.spyOn(typeorm_2.EntityManager.prototype, 'remove').mockRejectedValueOnce(new Error('transaction timed out'));
        await expect(a.service.delete(id)).rejects.toThrow('transaction timed out');
        await expect(starting).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        expect(a.engines).toHaveLength(0);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).not.toBeNull();
    });
    // The session was stopped, so the delete's record changes nothing the start could read, and the failed delete
    // has dropped its stop mark by the time the start goes on.
    it('keeps a start from launching into a stopped session that a delete sent after it began removing', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState: 'stopped' });
        const fenced = deferred();
        const go = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await go.promise;
        });
        const starting = a.service.start(id, { explicit: true });
        await fenced.promise;
        jest.spyOn(typeorm_2.EntityManager.prototype, 'remove').mockRejectedValueOnce(new Error('transaction timed out'));
        await expect(a.service.delete(id)).rejects.toThrow('transaction timed out');
        go.resolve();
        await expect(starting).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        expect(a.engines).toHaveLength(0);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).not.toBeNull();
    });
    it('refuses the delete and removes nothing when the claim cannot be written', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.service.start(id, { explicit: true });
        jest.spyOn(a.ownership, 'claim').mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        expect(a.service.getEngine(id)).toBe(a.engines[0]);
        expect(a.engines[0].forceDestroy).not.toHaveBeenCalled();
        expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
        expect(a.hooks.execute).not.toHaveBeenCalledWith('session:deleted', expect.anything(), expect.anything());
        expect(a.purge).not.toHaveBeenCalled();
        expect(leftovers(id)).toEqual({ stopMark: false, stopCount: false });
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).desiredState).toBeNull();
    });
    it('answers 409 and removes nothing when a peer claims the session just before the delete does', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        // The peer's claim lands between the delete's ownership check and its own claim.
        jest.spyOn(a.ownership, 'isHeldByOtherNode').mockImplementationOnce(async () => {
            await b.ownership.claim(id);
            return false;
        });
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ConflictException);
        expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).nodeId).toBe('node-b');
        expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
        expect(a.ownership.ownedIds()).toEqual([]);
        expect(leftovers(id).stopCount).toBe(false);
    });
    // A claim left on a row the delete did not remove lapses once nothing renews it, and a peer then adopts
    // and starts the session the operator was deleting.
    it('hands the claim back when the delete fails after claiming', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.READY, phone: '628111111111' });
        jest.spyOn(typeorm_2.EntityManager.prototype, 'remove').mockRejectedValueOnce(new Error('transaction timed out'));
        await expect(a.service.delete(id)).rejects.toThrow('transaction timed out');
        // The batches ran before the closing transaction failed, so the session stays down like a crashed delete.
        expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            nodeId: null,
            desiredState: 'deleting',
        });
        expect(a.ownership.ownedIds()).toEqual([]);
    });
    it('answers 404 for an id with no session and leaves nothing behind', async () => {
        const id = (0, crypto_1.randomUUID)();
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.NotFoundException);
        expect(leftovers(id)).toEqual({ stopMark: false, stopCount: false });
        expect(a.ownership.ownedIds()).toEqual([]);
    });
    it.each([
        [null, false],
        ['stopped', false],
        [null, true],
        ['stopped', true],
    ])('keeps a delete claim after repeated stops with a missing lease, state %s and local first stop %s', async (desiredState, localFirst) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState });
        await startHeldDelete(id);
        const sessions = a.db.getRepository(session_entity_1.Session);
        await sessions.update(id, { leaseExpiresAt: null, nodeUrl: 'http://127.0.0.1:59651' });
        const before = await sessions.findOneByOrFail({ id });
        for (let i = 0; i < 2; i++) {
            await (localFirst && i === 0 ? a : b).service.stop(id);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: before.nodeId,
                claimedAt: before.claimedAt,
                leaseExpiresAt: null,
                nodeUrl: before.nodeUrl,
            });
        }
        await a.ownership.renew();
        const renewed = await sessions.findOneByOrFail({ id });
        expect(renewed.nodeId).toBe('node-a');
        expect(renewed.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
        await expect(b.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.ConflictException);
        expect(b.service.getEngine(id)).toBeUndefined();
        finish();
        await deletion;
        expect(await rowsOf(id)).toEqual(gone);
    });
    it('keeps every delete claim field when a delayed peer stop resumes after expiry', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const checked = deferred();
        const go = deferred();
        const held = b.ownership.isHeldByOtherNode.bind(b.ownership);
        jest.spyOn(b.ownership, 'isHeldByOtherNode').mockImplementationOnce(async (next) => {
            const answer = await held(next);
            checked.resolve();
            await go.promise;
            return answer;
        });
        const stopping = b.service.stop(id);
        await checked.promise;
        await startHeldDelete(id);
        const sessions = a.db.getRepository(session_entity_1.Session);
        await sessions.update(id, { leaseExpiresAt: lapsed(), nodeUrl: 'http://127.0.0.1:59651' });
        const before = await sessions.findOneByOrFail({ id });
        try {
            go.resolve();
            await stopping;
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: before.nodeId,
                claimedAt: before.claimedAt,
                leaseExpiresAt: before.leaseExpiresAt,
                nodeUrl: before.nodeUrl,
            });
            await a.ownership.renew();
            await expect(b.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.ConflictException);
            expect(b.service.getEngine(id)).toBeUndefined();
        }
        finally {
            go.resolve();
            await stopping;
        }
    });
    it.each([
        ['hook', false],
        ['batch', false],
        ['final transaction', false],
        ['hook', true],
    ])('stops deleting after ownership changes at the %s with expired peer %s', async (phase, expiredPeer) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const messages = a.db.getRepository(message_entity_1.Message);
        const batch = await a.db.getRepository(message_batch_entity_1.MessageBatch).save({
            sessionId: id,
            batchId: (0, crypto_1.randomUUID)(),
            status: message_batch_entity_1.BatchStatus.PROCESSING,
            messages: [{ chatId: '10000000001@c.us', type: 'text', content: { text: 'kept' } }],
        });
        if (phase === 'batch') {
            await messages.insert(Array.from({ length: 500 }, () => ({
                sessionId: id,
                chatId: '10000000001@c.us',
                from: 'me',
                to: '10000000001@c.us',
                body: 'kept',
            })));
        }
        if (phase === 'final transaction')
            await messages.delete({ sessionId: id });
        const transaction = a.db.transaction.bind(a.db);
        let transactions = 0;
        let remaining = 0;
        const adopt = async () => {
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            await b.service.start(id, { explicit: true });
            remaining = await messages.countBy({ sessionId: id });
        };
        const reached = deferred();
        const release = deferred();
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:deleted') {
                reached.resolve();
                await release.promise;
            }
            return { continue: true, data };
        });
        finish = release.resolve;
        const outcome = a.service.delete(id).catch((error) => error);
        deletion = outcome.then(() => undefined);
        await reached.promise;
        if (phase !== 'hook') {
            jest.spyOn(a.db, 'transaction').mockImplementation(async (...args) => {
                transactions++;
                if ((phase === 'batch' && transactions === 2) || (phase === 'final transaction' && transactions === 1)) {
                    await adopt();
                }
                return transaction(...args);
            });
        }
        if (phase === 'hook')
            await adopt();
        if (expiredPeer)
            await sessions.update(id, { leaseExpiresAt: lapsed() });
        release.resolve();
        expect(await outcome).toBeInstanceOf(common_1.ConflictException);
        expect(await messages.countBy({ sessionId: id })).toBe(remaining);
        expect(await a.db.getRepository(message_batch_entity_1.MessageBatch).findOneByOrFail({ id: batch.id })).toMatchObject({
            status: message_batch_entity_1.BatchStatus.PROCESSING,
            messages: batch.messages,
        });
        expect(await sessions.findOneByOrFail({ id })).toMatchObject({ nodeId: 'node-b', desiredState: null });
        expect(b.service.getEngine(id)).toBe(b.engines[0]);
        expect(a.purge).not.toHaveBeenCalled();
    });
    it.each(['retirement read', 'final read'])('keeps a healthy reconnect when the top-level start %s returns a stale snapshot', async (phase) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, config: { reconnectBaseDelay: 1000 } });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const findOne = sessions.findOne.bind(sessions);
        const reached = deferred();
        const go = deferred();
        let reads = 0;
        jest.spyOn(sessions, 'findOne').mockImplementation(async (options) => {
            reads += 1;
            if (phase === 'final read' && reads === 3)
                throw new Error('connection reset');
            if (reads !== (phase === 'retirement read' ? 3 : 4))
                return findOne(options);
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            const snapshot = phase === 'retirement read' ? await findOne(options) : null;
            reached.resolve();
            await go.promise;
            return snapshot;
        });
        const reconnect = a.lifecycle.executeReconnect.bind(a.lifecycle);
        let reconnected;
        const launched = deferred();
        jest.spyOn(a.lifecycle, 'executeReconnect').mockImplementation((...args) => {
            reconnected = reconnect(...args);
            launched.resolve();
            return reconnected;
        });
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        try {
            await reached.promise;
            await a.ownership.renew();
            await a.lifecycle.handleEngineDisconnected(id, a.engines[0], 'NETWORK');
            await launched.promise;
            await reconnected;
            const replacement = a.engines[1];
            expect(a.service.getEngine(id)).toBe(replacement);
            go.resolve();
            const result = await starting;
            if (phase === 'final read')
                expect(result).toBeInstanceOf(common_1.NotFoundException);
            else
                expect(result).not.toBeInstanceOf(Error);
            expect(a.service.getEngine(id)).toBe(replacement);
            expect(replacement.destroy).not.toHaveBeenCalled();
            expect(replacement.forceDestroy).not.toHaveBeenCalled();
            expect(a.engines[0].destroy).toHaveBeenCalledTimes(1);
        }
        finally {
            go.resolve();
            await starting;
        }
    });
    it.each((pg
        ? [
            ['before release', false],
            ['before release', true],
            ['owner row', false],
            ['owner row', true],
        ]
        : [
            ['before release', false],
            ['before release', true],
        ]))('keeps a later local start when delete cleanup waits at %s with pending claim %s', async (phase, pending) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const reached = deferred();
        const go = deferred();
        const claimed = deferred();
        const answer = deferred();
        const release = a.ownership.release.bind(a.ownership);
        const transaction = a.db.transaction.bind(a.db);
        a.hooks.execute.mockRejectedValueOnce(new Error('hook unavailable'));
        jest.spyOn(a.ownership, 'release').mockImplementationOnce(async (...args) => {
            if (phase === 'before release') {
                reached.resolve();
                await go.promise;
            }
            else {
                jest.spyOn(a.db, 'transaction').mockImplementationOnce((async (run) => transaction(async (manager) => {
                    const builder = manager.createQueryBuilder.bind(manager);
                    jest.spyOn(manager, 'createQueryBuilder').mockImplementation((() => {
                        const query = builder();
                        const update = query.update.bind(query);
                        jest.spyOn(query, 'update').mockImplementation((() => {
                            const updated = update(session_entity_1.Session);
                            const execute = updated.execute.bind(updated);
                            jest.spyOn(updated, 'execute').mockImplementationOnce(async () => {
                                reached.resolve();
                                await go.promise;
                                return execute();
                            });
                            return updated;
                        }));
                        return query;
                    }));
                    return run(manager);
                })));
            }
            return release(...args);
        });
        const outcome = a.service.delete(id).catch((error) => error);
        deletion = outcome.then(() => undefined);
        await reached.promise;
        const original = await sessions.findOneByOrFail({ id });
        if (pending) {
            const claim = a.ownership.claim.bind(a.ownership);
            jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async (next) => {
                const result = await claim(next);
                claimed.resolve();
                await answer.promise;
                return result;
            });
        }
        const starting = a.service.start(id, { explicit: true });
        try {
            if (pending)
                await claimed.promise;
            else
                await starting;
            go.resolve();
            expect(await outcome).toBeInstanceOf(Error);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: 'node-a',
                claimedAt: original.claimedAt,
            });
            answer.resolve();
            await starting;
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect((await sessions.findOneByOrFail({ id })).desiredState).toBeNull();
            await a.ownership.renew();
            expect((await sessions.findOneByOrFail({ id })).nodeId).toBe('node-a');
        }
        finally {
            go.resolve();
            answer.resolve();
            await starting;
        }
    });
    (pg ? it : it.skip)('holds the owner row for each delete batch while other sessions can start', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const otherId = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const messages = a.db.getRepository(message_entity_1.Message);
        await messages.insert(Array.from({ length: 500 }, () => ({
            sessionId: id,
            chatId: '10000000001@c.us',
            from: 'me',
            to: '10000000001@c.us',
            body: 'kept',
        })));
        await startHeldDelete(id);
        await sessions.update(id, { leaseExpiresAt: lapsed() });
        const reached = deferred();
        const go = deferred();
        const transaction = a.db.transaction.bind(a.db);
        let first = true;
        jest.spyOn(a.db, 'transaction').mockImplementation((async (run) => {
            const hold = first;
            first = false;
            const result = await transaction(async (manager) => {
                if (hold) {
                    const getRepository = manager.getRepository.bind(manager);
                    jest.spyOn(manager, 'getRepository').mockImplementation(target => {
                        const repository = getRepository(target);
                        if (target === message_entity_1.Message) {
                            const remove = repository.delete.bind(repository);
                            jest.spyOn(repository, 'delete').mockImplementationOnce(async (where) => {
                                reached.resolve();
                                await go.promise;
                                return remove(where);
                            });
                        }
                        return repository;
                    });
                }
                return run(manager);
            });
            if (hold)
                await claiming;
            return result;
        }));
        const outcome = deletion.catch((error) => error);
        finish();
        await reached.promise;
        let claimed = false;
        const claiming = b.ownership.claim(id).then(result => {
            claimed = result;
            return result;
        });
        try {
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                const rows = await b.db.query('SELECT true AS waiting FROM pg_stat_activity WHERE wait_event_type = $1 AND query LIKE $2', ['Lock', `%${options.schema}%`]);
                if (rows.length) {
                    waiting = true;
                    break;
                }
                if (claimed)
                    break;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
            expect(claimed).toBe(false);
            await b.service.start(otherId, { explicit: true });
            expect(b.service.getEngine(otherId)).toBe(b.engines[0]);
            go.resolve();
            expect(await claiming).toBe(true);
            expect(await outcome).toBeInstanceOf(common_1.ConflictException);
            expect(await messages.countBy({ sessionId: id })).toBe(1);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({ nodeId: 'node-b' });
        }
        finally {
            go.resolve();
            await claiming;
            await outcome;
        }
    });
    it.each(['deleting', 'deleting-stopped'])('does not clear an expired foreign %s claim through the stop helper', async (desiredState) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, desiredState });
        await a.ownership.claim(id);
        const sessions = a.db.getRepository(session_entity_1.Session);
        await sessions.update(id, { leaseExpiresAt: lapsed() });
        const before = await sessions.findOneByOrFail({ id });
        expect(await b.ownership.stopExpiredForeignClaim(id)).toBe(false);
        expect(await sessions.findOneByOrFail({ id })).toMatchObject({
            nodeId: before.nodeId,
            claimedAt: before.claimedAt,
            leaseExpiresAt: before.leaseExpiresAt,
            nodeUrl: before.nodeUrl,
            desiredState,
        });
    });
    it('leaves a later owner delete hold untouched when an older delete returns', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await startHeldDelete(id);
        const first = deletion.catch((error) => error);
        const sessions = a.db.getRepository(session_entity_1.Session);
        await sessions.update(id, { leaseExpiresAt: lapsed() });
        const reached = deferred();
        const go = deferred();
        b.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:deleted') {
                reached.resolve();
                await go.promise;
            }
            return { continue: true, data };
        });
        const second = b.service.delete(id);
        try {
            await reached.promise;
            await b.service.stop(id);
            finish();
            expect(await first).toBeInstanceOf(common_1.ConflictException);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: 'node-b',
                desiredState: 'deleting-stopped',
            });
            await b.ownership.renew();
            expect((await sessions.findOneByOrFail({ id })).leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
        }
        finally {
            go.resolve();
            await second;
        }
    });
    it.each(['retirement read', 'initialization failure'])('keeps a reconnect awaiting teardown when the old start returns from its %s', async (phase) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED, config: { reconnectBaseDelay: 1000 } });
        const reached = deferred();
        const go = deferred();
        let failInit;
        const initialization = new Promise((_resolve, reject) => {
            failInit = reject;
        });
        if (phase === 'retirement read') {
            const sessions = a.db.getRepository(session_entity_1.Session);
            const findOne = sessions.findOne.bind(sessions);
            let reads = 0;
            jest.spyOn(sessions, 'findOne').mockImplementation(async (options) => {
                if (++reads !== 3)
                    return findOne(options);
                await sessions.update(id, { leaseExpiresAt: lapsed() });
                const snapshot = await findOne(options);
                reached.resolve();
                await go.promise;
                return snapshot;
            });
        }
        else {
            const registry = a.lifecycle.engines;
            const register = registry.set.bind(registry);
            jest.spyOn(registry, 'set').mockImplementationOnce((next, engine) => {
                engine.initialize.mockImplementation(() => {
                    reached.resolve();
                    return initialization;
                });
                return register(next, engine);
            });
        }
        const reconnect = a.lifecycle.executeReconnect.bind(a.lifecycle);
        let reconnected;
        jest.spyOn(a.lifecycle, 'executeReconnect').mockImplementation((...args) => {
            reconnected = reconnect(...args);
            return reconnected;
        });
        const starting = a.service.start(id, { explicit: true }).catch((error) => error);
        await reached.promise;
        await a.ownership.renew();
        const fenced = deferred();
        const resume = deferred();
        jest.spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown').mockImplementationOnce(async () => {
            fenced.resolve();
            await resume.promise;
        });
        await a.lifecycle.handleEngineDisconnected(id, a.engines[0], 'NETWORK');
        await fenced.promise;
        try {
            go.resolve();
            if (phase === 'initialization failure')
                failInit(new Error('invalid auth'));
            await starting;
            expect(a.service.getEngine(id)).toBeUndefined();
            expect(a.lifecycle.isEngineActive(id)).toBe(true);
            resume.resolve();
            await reconnected;
            expect(a.service.getEngine(id)).toBe(a.engines[1]);
            expect(a.engines).toHaveLength(2);
            expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).nodeId).toBe('node-a');
            await expect(b.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.ConflictException);
        }
        finally {
            go.resolve();
            resume.resolve();
            if (phase === 'initialization failure')
                failInit(new Error('invalid auth'));
            await starting;
            await reconnected;
        }
    });
    it.each([
        ['delete', false, false, true],
        ['delete', true, false, true],
        ['start', false, false, true],
        ['start', true, false, true],
        ['delete', false, true, true],
        ['start', false, true, true],
        ['delete', false, false, false],
    ])('handles an older %s claim SQL reply with frozen clock %s, failed reply %s and ownership loss %s', async (operation, frozen, failedReply, loss) => {
        if (frozen) {
            jest.useFakeTimers({
                doNotFake: [
                    'nextTick',
                    'setImmediate',
                    'queueMicrotask',
                    'setTimeout',
                    'clearTimeout',
                    'setInterval',
                    'clearInterval',
                    'performance',
                ],
            });
            jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        }
        const written = deferred();
        const answer = deferred();
        try {
            const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
            const sessions = a.db.getRepository(session_entity_1.Session);
            const builder = sessions.createQueryBuilder.bind(sessions);
            let holdClaim = true;
            jest.spyOn(sessions, 'createQueryBuilder').mockImplementation(() => {
                const query = builder();
                if (!holdClaim)
                    return query;
                const update = query.update.bind(query);
                jest.spyOn(query, 'update').mockImplementation(() => {
                    holdClaim = false;
                    const updated = update(session_entity_1.Session);
                    const execute = updated.execute.bind(updated);
                    jest.spyOn(updated, 'execute').mockImplementationOnce(async () => {
                        const result = await execute();
                        written.resolve();
                        await answer.promise;
                        if (failedReply)
                            throw new Error('claim reply unavailable');
                        return result;
                    });
                    return updated;
                });
                return query;
            });
            const outcome = (operation === 'delete' ? a.service.delete(id) : a.service.start(id, { explicit: true })).catch((error) => error);
            deletion = outcome.then(() => undefined);
            await written.promise;
            if (loss) {
                await sessions.update(id, { leaseExpiresAt: lapsed() });
                expect(await b.ownership.claim(id)).toBe(true);
                await sessions.update(id, { leaseExpiresAt: lapsed() });
            }
            if (operation === 'delete') {
                await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            }
            else {
                await a.service.start(id, { explicit: true });
            }
            const before = await sessions.findOneByOrFail({ id });
            const ownsNewClaim = a.ownership.captureClaim(id);
            answer.resolve();
            if (!loss) {
                expect(await outcome).toBeUndefined();
                expect(await rowsOf(id)).toEqual(gone);
                return;
            }
            expect(await outcome).toBeInstanceOf(failedReply ? Error : common_1.ConflictException);
            expect(ownsNewClaim()).toBe(true);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: before.nodeId,
                claimedAt: before.claimedAt,
                leaseExpiresAt: before.leaseExpiresAt,
                nodeUrl: before.nodeUrl,
                desiredState: before.desiredState,
            });
            expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
            if (operation === 'start')
                expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect(a.purge).not.toHaveBeenCalled();
        }
        finally {
            answer.resolve();
            await deletion;
            jest.useRealTimers();
        }
    });
    it.each([false, true])('does not resume an older delete after this node reclaims a peer claim with frozen clock %s', async (frozen) => {
        if (frozen) {
            jest.useFakeTimers({
                doNotFake: [
                    'nextTick',
                    'setImmediate',
                    'queueMicrotask',
                    'setTimeout',
                    'clearTimeout',
                    'setInterval',
                    'clearInterval',
                    'performance',
                ],
            });
            jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        }
        try {
            const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
            await startHeldDelete(id);
            const outcome = deletion.catch((error) => error);
            const sessions = a.db.getRepository(session_entity_1.Session);
            const original = await sessions.findOneByOrFail({ id });
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            expect(await b.ownership.claim(id)).toBe(true);
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            const reclaimed = await sessions.findOneByOrFail({ id });
            expect(reclaimed.nodeId).toBe('node-a');
            if (frozen)
                expect(reclaimed.claimedAt).toEqual(original.claimedAt);
            finish();
            expect(await outcome).toBeInstanceOf(common_1.ConflictException);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: 'node-a',
                claimedAt: reclaimed.claimedAt,
            });
            expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
            expect(a.purge).not.toHaveBeenCalled();
        }
        finally {
            jest.useRealTimers();
        }
    });
    it.each([
        [false, false],
        [true, false],
        [false, true],
        [true, true],
    ])('keeps a newer owner after a delayed delete claim with local reacquisition %s and existing claim %s', async (local, owned) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        if (owned)
            await a.ownership.claim(id);
        const sessions = a.db.getRepository(session_entity_1.Session);
        const reached = deferred();
        const go = deferred();
        const claim = a.ownership.claim.bind(a.ownership);
        jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async (...args) => {
            const result = await claim(...args);
            reached.resolve();
            await go.promise;
            return result;
        });
        const outcome = a.service.delete(id).catch((error) => error);
        deletion = outcome.then(() => undefined);
        try {
            await reached.promise;
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            await b.service.start(id, { explicit: true });
            if (local) {
                await sessions.update(id, { leaseExpiresAt: lapsed() });
                await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            }
            const before = await sessions.findOneByOrFail({ id });
            go.resolve();
            expect(await outcome).toBeInstanceOf(common_1.ConflictException);
            expect(await sessions.findOneByOrFail({ id })).toMatchObject({
                nodeId: before.nodeId,
                claimedAt: before.claimedAt,
                leaseExpiresAt: before.leaseExpiresAt,
                nodeUrl: before.nodeUrl,
                desiredState: before.desiredState,
            });
            expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
            expect(b.service.getEngine(id)).toBe(b.engines[0]);
            expect(a.purge).not.toHaveBeenCalled();
        }
        finally {
            go.resolve();
            await outcome;
        }
    });
    it.each([false, true])('retries a delete after its initial intent transaction fails with a local engine %s', async (active) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        if (active)
            await a.service.start(id, { explicit: true });
        a.hooks.execute.mockClear();
        const sessions = a.db.getRepository(session_entity_1.Session);
        const before = await sessions.findOneByOrFail({ id });
        jest.spyOn(a.db, 'transaction').mockRejectedValueOnce(new Error('intent transaction unavailable'));
        await expect(a.service.delete(id)).rejects.toThrow('intent transaction unavailable');
        const after = await sessions.findOneByOrFail({ id });
        expect(after.status).toBe(before.status);
        expect(after.desiredState).toBeNull();
        expect(after.nodeId).toBe(active ? 'node-a' : null);
        if (active) {
            expect(after.claimedAt).toEqual(before.claimedAt);
            expect(after.nodeUrl).toEqual(before.nodeUrl);
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
        }
        expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
        expect(a.hooks.execute).not.toHaveBeenCalled();
        expect(a.purge).not.toHaveBeenCalled();
        await a.service.delete(id);
        expect(await rowsOf(id)).toEqual(gone);
    });
    it('keeps the same claim when a local start is refused during its delete', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await startHeldDelete(id);
        const sessions = a.db.getRepository(session_entity_1.Session);
        const before = await sessions.findOneByOrFail({ id });
        await new Promise(resolve => setTimeout(resolve, 5));
        await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
        expect(await sessions.findOneByOrFail({ id })).toMatchObject({
            nodeId: before.nodeId,
            claimedAt: before.claimedAt,
            nodeUrl: before.nodeUrl,
        });
        finish();
        await deletion;
        expect(await rowsOf(id)).toEqual(gone);
    });
    (pg ? it : it.skip)('rechecks its captured ownership after the row fence returns', async () => {
        jest.useFakeTimers({
            doNotFake: [
                'nextTick',
                'setImmediate',
                'queueMicrotask',
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'performance',
            ],
        });
        jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        const reached = deferred();
        const go = deferred();
        try {
            const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
            await startHeldDelete(id);
            const outcome = deletion.catch((error) => error);
            const sessions = a.db.getRepository(session_entity_1.Session);
            const original = await sessions.findOneByOrFail({ id });
            const transaction = a.db.transaction.bind(a.db);
            jest.spyOn(a.db, 'transaction').mockImplementationOnce((async (run) => transaction(async (manager) => {
                const builder = manager.createQueryBuilder.bind(manager);
                jest.spyOn(manager, 'createQueryBuilder').mockImplementation((() => {
                    const query = builder();
                    const update = query.update.bind(query);
                    jest.spyOn(query, 'update').mockImplementation((() => {
                        const updated = update(session_entity_1.Session);
                        const execute = updated.execute.bind(updated);
                        jest.spyOn(updated, 'execute').mockImplementationOnce(async () => {
                            reached.resolve();
                            await go.promise;
                            return execute();
                        });
                        return updated;
                    }));
                    return query;
                }));
                return run(manager);
            })));
            finish();
            await reached.promise;
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            expect(await b.ownership.claim(id)).toBe(true);
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            expect(await a.ownership.claim(id)).toBe(true);
            expect((await sessions.findOneByOrFail({ id })).claimedAt).toEqual(original.claimedAt);
            go.resolve();
            expect(await outcome).toBeInstanceOf(common_1.ConflictException);
            expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
        }
        finally {
            go.resolve();
            jest.useRealTimers();
        }
    });
    it('retires old deletion work before a fresh claim write returns', async () => {
        jest.useFakeTimers({
            doNotFake: [
                'nextTick',
                'setImmediate',
                'queueMicrotask',
                'setTimeout',
                'clearTimeout',
                'setInterval',
                'clearInterval',
                'performance',
            ],
        });
        jest.setSystemTime(new Date('2026-06-01T12:00:00Z'));
        const written = deferred();
        const answer = deferred();
        let claiming;
        try {
            const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
            await startHeldDelete(id);
            const outcome = deletion.catch((error) => error);
            const sessions = a.db.getRepository(session_entity_1.Session);
            const original = await sessions.findOneByOrFail({ id });
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            expect(await b.ownership.claim(id)).toBe(true);
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            const builder = sessions.createQueryBuilder.bind(sessions);
            jest.spyOn(sessions, 'createQueryBuilder').mockImplementationOnce(() => {
                const query = builder();
                const update = query.update.bind(query);
                jest.spyOn(query, 'update').mockImplementation(() => {
                    const updated = update(session_entity_1.Session);
                    const execute = updated.execute.bind(updated);
                    jest.spyOn(updated, 'execute').mockImplementationOnce(async () => {
                        const result = await execute();
                        written.resolve();
                        await answer.promise;
                        return result;
                    });
                    return updated;
                });
                return query;
            });
            claiming = a.ownership.claim(id);
            await written.promise;
            expect((await sessions.findOneByOrFail({ id })).claimedAt).toEqual(original.claimedAt);
            finish();
            expect(await outcome).toBeInstanceOf(common_1.ConflictException);
            expect(await rowsOf(id)).toEqual({ sessions: 1, messages: 1, outbox: 0, deliveryFailures: 0 });
        }
        finally {
            answer.resolve();
            await claiming;
            jest.useRealTimers();
        }
    });
    it('keeps an earlier take-back as the fence for a third delete after a second delete is refused', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const update = sessions.update.bind(sessions);
        const clearing = deferred();
        const clear = deferred();
        jest.spyOn(sessions, 'update').mockImplementation(async (where, patch) => {
            if (patch.desiredState === null) {
                clearing.resolve();
                await clear.promise;
            }
            return update(where, patch);
        });
        jest
            .spyOn(session_lifecycle_fences_1.SessionLifecycleFences.prototype, 'awaitPendingTeardown')
            .mockRejectedValueOnce(new common_1.ConflictException('credential teardown pending'));
        const first = a.service.delete(id).catch((error) => error);
        await clearing.promise;
        jest.spyOn(a.ownership, 'claim').mockRejectedValueOnce(new Error('connection reset'));
        await expect(a.service.delete(id)).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        const reached = deferred();
        const done = deferred();
        let removing = false;
        a.hooks.execute.mockImplementation(async (event, data) => {
            if (event === 'session:deleted') {
                removing = true;
                reached.resolve();
                await done.promise;
            }
            return { continue: true, data };
        });
        finish = done.resolve;
        deletion = a.service.delete(id);
        try {
            for (let waited = 0; waited < 200 && !removing; waited += 5) {
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            clear.resolve();
            expect(await first).toBeInstanceOf(common_1.ConflictException);
            await reached.promise;
            expect((await sessions.findOneByOrFail({ id })).desiredState).toBe('deleting');
        }
        finally {
            clear.resolve();
            done.resolve();
            await deletion;
        }
    });
    (pg ? it : it.skip).each([false, true])('rechecks initial intent after the real row lock with takeover=%s', async (takeover) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const reached = deferred(), go = deferred();
        const transact = a.db.transaction.bind(a.db);
        jest.spyOn(a.db, 'transaction').mockImplementationOnce((async (run) => {
            reached.resolve();
            await go.promise;
            return transact(run);
        }));
        const deleting = a.service.delete(id).catch((error) => error);
        await reached.promise;
        const lock = b.db.createQueryRunner();
        const peerRepo = b.db.getRepository(session_entity_1.Session);
        const oldManager = peerRepo.manager;
        await lock.connect();
        await lock.startTransaction();
        await lock.manager.getRepository(session_entity_1.Session).findOne({ where: { id }, lock: { mode: 'pessimistic_write' } });
        try {
            go.resolve();
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                const rows = await b.db.query('SELECT true AS waiting FROM pg_stat_activity WHERE wait_event_type = $1 AND query LIKE $2', ['Lock', `%${options.schema}%`]);
                if (rows.length) {
                    waiting = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
            if (takeover) {
                await lock.manager.update(session_entity_1.Session, id, { leaseExpiresAt: lapsed() });
                Object.assign(peerRepo, { manager: lock.manager });
                await b.service.start(id, { explicit: true });
                expect(b.service.getEngine(id)).toBe(b.engines[0]);
                Object.assign(peerRepo, { manager: oldManager });
            }
            await lock.commitTransaction();
            const result = await deleting;
            if (takeover) {
                expect(result).toBeInstanceOf(common_1.ConflictException);
                expect(await rowsOf(id)).toMatchObject({ sessions: 1, messages: 1 });
                expect(await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
                    nodeId: 'node-b',
                    desiredState: null,
                });
                expect(a.hooks.execute.mock.calls.some(([event]) => event === 'session:deleted')).toBe(false);
            }
            else {
                expect(result).toBeUndefined();
                expect(await rowsOf(id)).toMatchObject({ sessions: 0, messages: 0 });
            }
        }
        finally {
            Object.assign(peerRepo, { manager: oldManager });
            go.resolve();
            if (lock.isTransactionActive)
                await lock.rollbackTransaction();
            await lock.release();
            await deleting;
        }
    });
    it('does not replace newer local ownership when an older failed own renewal returns', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await a.ownership.claim(id);
        const checked = deferred(), checkGo = deferred(), renewed = deferred(), renewGo = deferred();
        const held = a.ownership.isHeldByOtherNode.bind(a.ownership);
        jest.spyOn(a.ownership, 'isHeldByOtherNode').mockImplementationOnce(async (next) => {
            const result = await held(next);
            checked.resolve();
            await checkGo.promise;
            return result;
        });
        const repo = a.db.getRepository(session_entity_1.Session), update = repo.update.bind(repo);
        jest.spyOn(repo, 'update').mockImplementationOnce(async (...args) => {
            const result = await update(...args);
            renewed.resolve();
            await renewGo.promise;
            return result;
        });
        const deleting = a.service.delete(id).catch((error) => error);
        try {
            await checked.promise;
            await b.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
            expect(await b.ownership.claim(id)).toBe(true);
            checkGo.resolve();
            await renewed.promise;
            await b.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
            await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            const valid = a.ownership.captureClaim(id);
            expect(valid()).toBe(true);
            renewGo.resolve();
            expect(await deleting).toBeInstanceOf(common_1.ConflictException);
            expect(await rowsOf(id)).toMatchObject({ sessions: 1, messages: 1 });
            expect(valid()).toBe(true);
        }
        finally {
            checkGo.resolve();
            renewGo.resolve();
            await deleting;
        }
    });
    it.each([false, true])('leaves a newer peer claim in delete cleanup even if expired=%s', async (expired) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        await startHeldDelete(id);
        const outcome = deletion.catch((error) => error);
        await a.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
        await b.service.start(id, { explicit: true });
        if (expired)
            await b.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
        const before = await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id });
        finish();
        expect(await outcome).toBeInstanceOf(common_1.ConflictException);
        const after = await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id });
        expect(after).toMatchObject({
            nodeId: before.nodeId,
            claimedAt: before.claimedAt,
            leaseExpiresAt: before.leaseExpiresAt,
            nodeUrl: before.nodeUrl,
            desiredState: null,
        });
        expect(b.service.getEngine(id)).toBe(b.engines[0]);
        expect(await rowsOf(id)).toMatchObject({ sessions: 1, messages: 1 });
        expect(a.purge).not.toHaveBeenCalled();
    });
    it.each([false, true])('settles abandoned batches when local starts overlap with a delayed claim reply %s', async (overlap) => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            nodeId: 'departed',
            claimedAt: lapsed(),
            leaseExpiresAt: lapsed(),
        });
        const batches = a.db.getRepository(message_batch_entity_1.MessageBatch);
        const batch = await batches.save({
            sessionId: id,
            batchId: (0, crypto_1.randomUUID)(),
            status: message_batch_entity_1.BatchStatus.PROCESSING,
            messages: [
                {
                    chatId: '10000000001@c.us',
                    type: 'image',
                    content: { image: { base64: 'PRIVATE-MEDIA', mimetype: 'image/png' } },
                },
            ],
        });
        const registry = a.lifecycle.engines;
        const bulk = new bulk_message_service_1.BulkMessageService(batches, registry, {}, a.hooks, {}, a.ownership);
        bulk.onModuleInit();
        const reaping = [];
        const reap = bulk.reapProcessingBatches.bind(bulk);
        jest.spyOn(bulk, 'reapProcessingBatches').mockImplementation((...args) => {
            const promise = reap(...args);
            reaping.push(promise);
            return promise;
        });
        const reached = deferred(), go = deferred();
        if (overlap) {
            const claim = a.ownership.claim.bind(a.ownership);
            jest.spyOn(a.ownership, 'claim').mockImplementationOnce(async (...args) => {
                const result = await claim(...args);
                reached.resolve();
                await go.promise;
                return result;
            });
        }
        const first = a.service.start(id, { explicit: true }).catch((error) => error);
        try {
            if (overlap) {
                await reached.promise;
                await a.service.start(id, { explicit: true });
                go.resolve();
                expect(await first).toBeInstanceOf(Error);
            }
            else
                expect(await first).not.toBeInstanceOf(Error);
            await new Promise(resolve => setImmediate(resolve));
            await Promise.all(reaping);
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect(await batches.findOneByOrFail({ id: batch.id })).toMatchObject({ status: message_batch_entity_1.BatchStatus.FAILED });
            expect(JSON.stringify((await batches.findOneByOrFail({ id: batch.id })).messages)).not.toContain('PRIVATE-MEDIA');
        }
        finally {
            go.resolve();
            await first;
            await Promise.all(reaping);
        }
    });
    it.each(['claim', 'stop', 'release'])('settles abandoned work in the ownership transaction before a peer starts after %s', async (operation) => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            nodeId: 'departed',
            claimedAt: lapsed(),
            leaseExpiresAt: lapsed(),
        });
        const batches = a.db.getRepository(message_batch_entity_1.MessageBatch);
        const old = await batches.save({
            sessionId: id,
            batchId: (0, crypto_1.randomUUID)(),
            status: message_batch_entity_1.BatchStatus.PROCESSING,
            messages: [
                { chatId: '10000000001@c.us', type: 'image', content: { image: { base64: 'T0xE', mimetype: 'image/png' } } },
            ],
        });
        const reached = deferred(), go = deferred(), sending = deferred(), sendGo = deferred();
        const processing = [];
        const bulkFor = (node) => {
            const registry = node.lifecycle.engines;
            const bulk = new bulk_message_service_1.BulkMessageService(node.db.getRepository(message_batch_entity_1.MessageBatch), registry, {}, node.hooks, {
                assertSendAllowed: async () => {
                    sending.resolve();
                    await sendGo.promise;
                    throw new Error('fixture finished');
                },
            }, node.ownership);
            bulk.onModuleInit();
            const runner = bulk, process = runner.processBatch.bind(bulk);
            jest.spyOn(runner, 'processBatch').mockImplementation((...args) => {
                const work = process(...args);
                processing.push(work);
                return work;
            });
            return bulk;
        };
        const bulkA = bulkFor(a), bulkB = bulkFor(b);
        const reap = bulkA.reapProcessingBatches.bind(bulkA);
        jest.spyOn(bulkA, 'reapProcessingBatches').mockImplementationOnce(async (...args) => {
            reached.resolve();
            await go.promise;
            return reap(...args);
        });
        const pending = (operation === 'claim'
            ? a.service.start(id, { explicit: true })
            : operation === 'stop'
                ? a.service.stop(id)
                : a.ownership.release(id)).catch((error) => error);
        let peerClaim;
        try {
            await reached.promise;
            if (pg) {
                peerClaim = b.ownership.claim(id);
                let waiting = false;
                for (let i = 0; i < 100; i++) {
                    const rows = await b.db.query('SELECT true AS waiting FROM pg_stat_activity WHERE wait_event_type = $1 AND query LIKE $2', ['Lock', `%${options.schema}%`]);
                    if (rows.length) {
                        waiting = true;
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
                expect(waiting).toBe(true);
            }
            else {
                expect(a.db.driver.databaseConnection
                    .inTransaction).toBe(true);
            }
            go.resolve();
            expect(await pending).not.toBeInstanceOf(Error);
            if (peerClaim)
                expect(await peerClaim).toBe(operation !== 'claim');
            const retired = await batches.findOneByOrFail({ id: old.id });
            expect(retired.status).toBe(message_batch_entity_1.BatchStatus.FAILED);
            expect(JSON.stringify(retired.messages)).not.toContain('T0xE');
            if (operation === 'claim')
                await b.db.getRepository(session_entity_1.Session).update(id, { leaseExpiresAt: lapsed() });
            await b.service.start(id, { explicit: true });
            const callbacks = b.engines[0].initialize.mock.calls[0][0];
            callbacks.onReady?.('628111111111', 'Fixture');
            for (let i = 0; i < 100; i++) {
                if ((await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).status === session_entity_1.SessionStatus.READY)
                    break;
                await new Promise(resolve => setTimeout(resolve, 5));
            }
            expect((await b.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).status).toBe(session_entity_1.SessionStatus.READY);
            const fresh = await bulkB.createBatch(id, {
                batchId: (0, crypto_1.randomUUID)(),
                messages: [
                    {
                        chatId: '10000000001@c.us',
                        type: 'image',
                        content: { image: { base64: 'TkVX', mimetype: 'image/png' } },
                    },
                ],
                options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
            });
            await sending.promise;
            const active = await batches.findOneByOrFail({ id: fresh.id });
            expect(active.status).toBe(message_batch_entity_1.BatchStatus.PROCESSING);
            expect(JSON.stringify(active.messages)).toContain('TkVX');
            expect(b.service.getEngine(id)).toBe(b.engines[0]);
        }
        finally {
            go.resolve();
            sendGo.resolve();
            await pending;
            await peerClaim;
            await Promise.all(processing);
        }
    });
    it.each(['claim', 'stop', 'release'])('keeps the ownership transition when SQL adoption cleanup fails during %s', async (operation) => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            nodeId: 'departed',
            claimedAt: lapsed(),
            leaseExpiresAt: lapsed(),
        });
        const batches = a.db.getRepository(message_batch_entity_1.MessageBatch);
        const old = await batches.save({
            sessionId: id,
            batchId: (0, crypto_1.randomUUID)(),
            status: message_batch_entity_1.BatchStatus.PROCESSING,
            messages: [
                { chatId: '10000000001@c.us', type: 'image', content: { image: { base64: 'T0xE', mimetype: 'image/png' } } },
            ],
        });
        const registry = a.lifecycle.engines;
        const bulk = new bulk_message_service_1.BulkMessageService(batches, registry, {}, a.hooks, {}, a.ownership);
        bulk.onModuleInit();
        const reap = bulk.reapProcessingBatches.bind(bulk);
        jest.spyOn(bulk, 'reapProcessingBatches').mockImplementationOnce(async (...args) => {
            await reap(...args);
            await args[2].query('SELECT * FROM adoption_cleanup_missing_table');
            return 0;
        });
        if (operation === 'claim')
            await a.service.start(id, { explicit: true });
        else if (operation === 'stop')
            await a.service.stop(id);
        else
            await a.ownership.release(id);
        expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
            nodeId: operation === 'claim' ? 'node-a' : null,
            desiredState: operation === 'stop' ? 'stopped' : null,
        });
        const retained = await batches.findOneByOrFail({ id: old.id });
        expect(retained.status).toBe(pg ? message_batch_entity_1.BatchStatus.PROCESSING : message_batch_entity_1.BatchStatus.FAILED);
        if (pg)
            expect(JSON.stringify(retained.messages)).toContain('T0xE');
        else
            expect(JSON.stringify(retained.messages)).not.toContain('T0xE');
    });
    (pg ? it.skip : it).each(['start', 'prepare', 'claim'])('keeps acknowledged local %s writes when adoption SQL cleanup fails', async (admission) => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            desiredState: 'stopped',
            nodeId: 'departed',
            claimedAt: lapsed(),
            leaseExpiresAt: lapsed(),
        });
        const registry = a.lifecycle.engines;
        const bulk = new bulk_message_service_1.BulkMessageService(a.db.getRepository(message_batch_entity_1.MessageBatch), registry, {}, a.hooks, {}, a.ownership);
        bulk.onModuleInit();
        const reached = deferred(), go = deferred();
        jest.spyOn(bulk, 'reapProcessingBatches').mockImplementationOnce(async (_id, _reason, manager) => {
            reached.resolve();
            await go.promise;
            await manager.query('SELECT adoption_admission_missing_column');
            return 0;
        });
        const first = a.ownership.claim(id);
        let second;
        try {
            await reached.promise;
            second =
                admission === 'start'
                    ? a.service.start(id, { explicit: true })
                    : admission === 'prepare'
                        ? a.ownership.prepareStart(id, 'stopped')
                        : a.ownership.claim(id);
            expect(await second).not.toBeInstanceOf(Error);
            if (admission === 'start') {
                const callbacks = a.engines[0].initialize.mock.calls[0][0];
                callbacks.onReady?.('628111111111', 'Fixture');
                for (let i = 0; i < 100; i++) {
                    if ((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).status === session_entity_1.SessionStatus.READY)
                        break;
                    await new Promise(resolve => setTimeout(resolve, 5));
                }
                expect(a.service.getEngine(id)).toBe(a.engines[0]);
                expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).status).toBe(session_entity_1.SessionStatus.READY);
            }
            go.resolve();
            expect(await first).toBe(true);
            expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).toMatchObject({
                nodeId: 'node-a',
                desiredState: admission === 'claim' ? 'stopped' : null,
            });
        }
        finally {
            go.resolve();
            await first;
            await second;
        }
    });
    (pg ? it : it.skip)('locks the session before reading its previous owner for SQL adoption', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const otherId = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const registry = a.lifecycle.engines;
        new bulk_message_service_1.BulkMessageService(a.db.getRepository(message_batch_entity_1.MessageBatch), registry, {}, a.hooks, {}, a.ownership).onModuleInit();
        const reached = deferred(), go = deferred();
        const transaction = a.db.transaction.bind(a.db);
        jest.spyOn(a.db, 'transaction').mockImplementationOnce((async (run) => transaction(async (manager) => {
            const sessions = manager.getRepository(session_entity_1.Session), find = sessions.findOne.bind(sessions);
            jest.spyOn(sessions, 'findOne').mockImplementationOnce(async (options) => {
                const row = await find(options);
                reached.resolve();
                await go.promise;
                return row;
            });
            return run(manager);
        })));
        const first = a.ownership.claim(id);
        await reached.promise;
        const peer = b.ownership.claim(id);
        try {
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                const rows = await b.db.query('SELECT true AS waiting FROM pg_stat_activity WHERE wait_event_type = $1 AND query LIKE $2', ['Lock', `%${options.schema}%`]);
                if (rows.length) {
                    waiting = true;
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            expect(waiting).toBe(true);
            await b.service.start(otherId, { explicit: true });
            expect(b.service.getEngine(otherId)).toBe(b.engines[0]);
            go.resolve();
            expect(await first).toBe(true);
            expect(await peer).toBe(false);
            expect((await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id })).nodeId).toBe('node-a');
        }
        finally {
            go.resolve();
            await first;
            await peer;
        }
    });
    (pg ? it.skip : it).each([
        ['stop', false],
        ['logout', false],
        ['kill', false],
        ['release', false],
        ['stop', true],
        ['release', true],
    ])('keeps an independent %s durable when adoption SQL cleanup fails on same row %s', async (operation, same) => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            nodeId: 'departed',
            claimedAt: lapsed(),
            leaseExpiresAt: lapsed(),
        });
        const other = same ? id : await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const registry = a.lifecycle.engines;
        const bulk = new bulk_message_service_1.BulkMessageService(a.db.getRepository(message_batch_entity_1.MessageBatch), registry, {}, a.hooks, {}, a.ownership);
        bulk.onModuleInit();
        if (!same) {
            if (operation === 'release')
                await a.ownership.claim(other);
            else
                await a.service.start(other, { explicit: true });
        }
        const reached = deferred(), go = deferred();
        jest.spyOn(bulk, 'reapProcessingBatches').mockImplementationOnce(async (_id, _reason, manager) => {
            reached.resolve();
            await go.promise;
            await (manager ?? a.db.manager).query('SELECT definitely_missing_local_fixture_column');
            return 0;
        });
        const first = a.ownership.claim(id).catch((error) => error);
        let second;
        try {
            await reached.promise;
            second = (operation === 'stop'
                ? a.service.stop(other)
                : operation === 'logout'
                    ? a.service.logout(other)
                    : operation === 'kill'
                        ? a.service.forceKill(other)
                        : a.ownership.release(other)).catch((error) => error);
            expect(await second).not.toBeInstanceOf(Error);
            go.resolve();
            expect(await first).toBe(!same);
            expect(a.service.getEngine(other)).toBeUndefined();
            expect(a.ownership.owns(other)).toBe(false);
            expect(await a.db.getRepository(session_entity_1.Session).findOneByOrFail({ id: other })).toMatchObject({
                nodeId: null,
                claimedAt: null,
                leaseExpiresAt: null,
                nodeUrl: null,
                desiredState: operation === 'release' || operation === 'logout' ? null : 'stopped',
            });
        }
        finally {
            go.resolve();
            await first;
            await second;
        }
    });
    (pg ? it.skip : it).each(['batch', 'outbox'])('keeps another session acknowledged %s row when adoption SQL cleanup fails', async (kind) => {
        const id = await seed({
            status: session_entity_1.SessionStatus.DISCONNECTED,
            nodeId: 'departed',
            claimedAt: lapsed(),
            leaseExpiresAt: lapsed(),
        });
        const other = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const registry = a.lifecycle.engines;
        const reached = deferred(), go = deferred(), sending = deferred(), sendGo = deferred();
        const bulk = new bulk_message_service_1.BulkMessageService(a.db.getRepository(message_batch_entity_1.MessageBatch), registry, {}, a.hooks, {
            assertSendAllowed: async () => {
                sending.resolve();
                await sendGo.promise;
                throw new Error('end local fixture hold');
            },
        }, a.ownership);
        bulk.onModuleInit();
        await a.service.start(other, { explicit: true });
        const runner = bulk, process = runner.processBatch.bind(bulk), processing = [];
        jest.spyOn(runner, 'processBatch').mockImplementation((...args) => {
            const work = process(...args);
            processing.push(work);
            return work;
        });
        jest.spyOn(bulk, 'reapProcessingBatches').mockImplementationOnce(async (_id, _reason, manager) => {
            reached.resolve();
            await go.promise;
            await (manager ?? a.db.manager).query('SELECT definitely_missing_local_fixture_column');
            return 0;
        });
        const first = a.ownership.claim(id).catch((error) => error);
        try {
            await reached.promise;
            if (kind === 'batch') {
                const fresh = await bulk.createBatch(other, {
                    batchId: (0, crypto_1.randomUUID)(),
                    messages: [
                        {
                            chatId: '10000000001@c.us',
                            type: 'image',
                            content: { image: { base64: 'TkVX', mimetype: 'image/png' } },
                        },
                    ],
                    options: { delayBetweenMessages: 0, randomizeDelay: false, stopOnError: false },
                });
                await sending.promise;
                expect((await a.db.getRepository(message_batch_entity_1.MessageBatch).findOneByOrFail({ id: fresh.id })).status).toBe(message_batch_entity_1.BatchStatus.PROCESSING);
                go.resolve();
                await first;
                expect(await a.db.getRepository(message_batch_entity_1.MessageBatch).findOneBy({ id: fresh.id })).toMatchObject({
                    status: message_batch_entity_1.BatchStatus.PROCESSING,
                });
            }
            else {
                const key = (0, crypto_1.randomUUID)();
                const outbox = new webhook_outbox_service_1.WebhookOutboxService(a.db.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent));
                await outbox.open({
                    webhookId: (0, crypto_1.randomUUID)(),
                    sessionId: other,
                    event: 'message',
                    idempotencyKey: key,
                    deliveryId: (0, crypto_1.randomUUID)(),
                    payload: { dummy: 'ordinary local write' },
                });
                expect(await a.db.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent).countBy({ idempotencyKey: key })).toBe(1);
                go.resolve();
                await first;
                expect(await a.db.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent).countBy({ idempotencyKey: key })).toBe(1);
            }
        }
        finally {
            go.resolve();
            sendGo.resolve();
            await first;
            await Promise.all(processing);
        }
    });
    it.each([false, true])('retires an old local engine after a peer takes over and a fresh claim fails with SQL error %s', async (sqlError) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        await a.service.start(id, { explicit: true });
        await sessions.update(id, { leaseExpiresAt: lapsed() });
        await b.service.start(id, { explicit: true });
        const before = await sessions.findOneByOrFail({ id });
        const failFresh = jest.fn().mockRejectedValue(new Error('fresh claim SQL unavailable'));
        if (sqlError) {
            const builder = sessions.createQueryBuilder.bind(sessions);
            jest.spyOn(sessions, 'createQueryBuilder').mockImplementationOnce(() => {
                const query = builder();
                const update = query.update.bind(query);
                jest.spyOn(query, 'update').mockImplementation(() => {
                    const updated = update(session_entity_1.Session);
                    jest.spyOn(updated, 'execute').mockImplementationOnce(failFresh);
                    return updated;
                });
                return query;
            });
        }
        if (sqlError) {
            await expect(a.service.start(id, { explicit: true })).rejects.toThrow('fresh claim SQL unavailable');
            expect(failFresh).toHaveBeenCalledTimes(1);
        }
        else {
            await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.ConflictException);
        }
        await a.ownership.renew();
        expect(a.service.getEngine(id)).toBeUndefined();
        expect(a.engines[0].destroy).toHaveBeenCalled();
        expect(b.service.getEngine(id)).toBe(b.engines[0]);
        expect(b.engines[0].destroy).not.toHaveBeenCalled();
        expect(await sessions.findOneByOrFail({ id })).toMatchObject({
            nodeId: before.nodeId,
            claimedAt: before.claimedAt,
            leaseExpiresAt: before.leaseExpiresAt,
            nodeUrl: before.nodeUrl,
            desiredState: before.desiredState,
            status: before.status,
        });
    });
    it('keeps an acknowledged local renewal when an older fresh SQL reply fails', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const written = deferred(), answer = deferred();
        const builder = sessions.createQueryBuilder.bind(sessions);
        jest.spyOn(sessions, 'createQueryBuilder').mockImplementationOnce(() => {
            const query = builder(), update = query.update.bind(query);
            jest.spyOn(query, 'update').mockImplementation(() => {
                const updated = update(session_entity_1.Session), execute = updated.execute.bind(updated);
                jest.spyOn(updated, 'execute').mockImplementationOnce(async () => {
                    await execute();
                    written.resolve();
                    await answer.promise;
                    throw new Error('old claim reply unavailable');
                });
                return updated;
            });
            return query;
        });
        const first = a.service.start(id, { explicit: true }).catch((error) => error);
        try {
            await written.promise;
            await a.service.start(id, { explicit: true });
            const current = a.ownership.captureClaim(id);
            expect(current()).toBe(true);
            answer.resolve();
            expect(await first).toBeInstanceOf(Error);
            expect(a.ownership.owns(id)).toBe(true);
            expect(current()).toBe(true);
            await a.ownership.renew();
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect(current()).toBe(true);
            expect((await sessions.findOneByOrFail({ id })).nodeId).toBe('node-a');
            await a.service.stop(id);
            expect(current()).toBe(false);
            expect((await sessions.findOneByOrFail({ id })).nodeId).toBeNull();
        }
        finally {
            answer.resolve();
            await first;
        }
    });
    it('keeps a pending newer claim when an older fresh SQL reply throws', async () => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        const written = [deferred(), deferred()], answer = [deferred(), deferred()];
        const builder = sessions.createQueryBuilder.bind(sessions);
        let attempt = 0;
        jest.spyOn(sessions, 'createQueryBuilder').mockImplementation(() => {
            const query = builder();
            if (attempt >= 2)
                return query;
            const update = query.update.bind(query);
            jest.spyOn(query, 'update').mockImplementation(() => {
                const index = attempt++;
                const updated = update(session_entity_1.Session), execute = updated.execute.bind(updated);
                jest.spyOn(updated, 'execute').mockImplementationOnce(async () => {
                    const result = await execute();
                    written[index].resolve();
                    await answer[index].promise;
                    if (index === 0)
                        throw new Error('old claim reply unavailable');
                    return result;
                });
                return updated;
            });
            return query;
        });
        const first = a.service.start(id, { explicit: true }).catch((error) => error);
        let second;
        try {
            await written[0].promise;
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            expect(await b.ownership.claim(id)).toBe(true);
            await sessions.update(id, { leaseExpiresAt: lapsed() });
            second = a.service.start(id, { explicit: true }).catch((error) => error);
            await written[1].promise;
            answer[0].resolve();
            expect(await first).toBeInstanceOf(Error);
            answer[1].resolve();
            expect(await second).not.toBeInstanceOf(Error);
            expect(a.ownership.captureClaim(id)()).toBe(true);
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect((await sessions.findOneByOrFail({ id })).nodeId).toBe('node-a');
        }
        finally {
            answer.forEach(hold => hold.resolve());
            await Promise.all([first, second]);
        }
    });
    it.each([false, true])('clears tracking after a completed delete overlaps a missing-row start with SQL error %s', async (sqlError) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        await a.service.start(id, { explicit: true });
        const reached = deferred(), go = deferred();
        const release = a.ownership.release.bind(a.ownership);
        jest.spyOn(a.ownership, 'release').mockImplementationOnce(async (...args) => {
            reached.resolve();
            await go.promise;
            return release(...args);
        });
        const deleting = a.service.delete(id);
        try {
            await reached.promise;
            expect((await rowsOf(id)).sessions).toBe(0);
            if (sqlError) {
                const builder = sessions.createQueryBuilder.bind(sessions);
                jest.spyOn(sessions, 'createQueryBuilder').mockImplementationOnce(() => {
                    const query = builder(), update = query.update.bind(query);
                    jest.spyOn(query, 'update').mockImplementation(() => {
                        const updated = update(session_entity_1.Session);
                        jest.spyOn(updated, 'execute').mockRejectedValueOnce(new Error('missing row claim SQL unavailable'));
                        return updated;
                    });
                    return query;
                });
                await expect(a.service.start(id, { explicit: true })).rejects.toThrow('missing row claim SQL unavailable');
            }
            else {
                await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.NotFoundException);
            }
            expect(a.ownership.owns(id)).toBe(false);
            go.resolve();
            await deleting;
            expect(a.ownership.owns(id)).toBe(false);
            expect(a.service.getEngine(id)).toBeUndefined();
            expect(a.lifecycle.isEngineActive(id)).toBe(false);
        }
        finally {
            go.resolve();
            await deleting;
        }
    });
    it.each([false, true])('preserves suspended loss detection while reconciling a failed claim with SQL error %s', async (sqlError) => {
        const id = await seed({ status: session_entity_1.SessionStatus.DISCONNECTED });
        const sessions = a.db.getRepository(session_entity_1.Session);
        await a.service.start(id, { explicit: true });
        await sessions.update(id, { leaseExpiresAt: lapsed() });
        await b.service.start(id, { explicit: true });
        const resume = a.ownership.suspendLossDetection();
        try {
            if (sqlError) {
                const builder = sessions.createQueryBuilder.bind(sessions);
                jest.spyOn(sessions, 'createQueryBuilder').mockImplementationOnce(() => {
                    const query = builder(), update = query.update.bind(query);
                    jest.spyOn(query, 'update').mockImplementation(() => {
                        const updated = update(session_entity_1.Session);
                        jest.spyOn(updated, 'execute').mockRejectedValueOnce(new Error('suspended claim SQL unavailable'));
                        return updated;
                    });
                    return query;
                });
                await expect(a.service.start(id, { explicit: true })).rejects.toThrow('suspended claim SQL unavailable');
            }
            else {
                await expect(a.service.start(id, { explicit: true })).rejects.toBeInstanceOf(common_1.ConflictException);
            }
            expect(a.ownership.owns(id)).toBe(true);
            expect(a.service.getEngine(id)).toBe(a.engines[0]);
            expect(a.engines[0].destroy).not.toHaveBeenCalled();
        }
        finally {
            resume();
        }
        await a.ownership.renew();
        expect(a.ownership.owns(id)).toBe(false);
        expect(a.service.getEngine(id)).toBeUndefined();
        expect(b.service.getEngine(id)).toBe(b.engines[0]);
        expect(b.engines[0].destroy).not.toHaveBeenCalled();
        expect((await sessions.findOneByOrFail({ id })).nodeId).toBe('node-b');
    });
});
