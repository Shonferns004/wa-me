"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
const session_engine_controls_1 = require("./session-engine-controls");
const config_1 = require("@nestjs/config");
const session_service_1 = require("./session.service");
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const session_error_store_service_1 = require("./session-error-store.service");
const session_restriction_store_service_1 = require("./session-restriction-store.service");
const presence_store_service_1 = require("./presence-store.service");
const session_entity_1 = require("./entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
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
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const ID = 'sess-uuid-1';
const NAME = 'test-session';
const session = (overrides = {}) => ({
    id: ID,
    name: NAME,
    status: session_entity_1.SessionStatus.CREATED,
    phone: null,
    pushName: null,
    config: {},
    proxyUrl: null,
    proxyType: null,
    connectedAt: null,
    lastActiveAt: null,
    nodeId: null,
    claimedAt: null,
    leaseExpiresAt: null,
    desiredState: null,
    nodeUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
});
const makeEngine = () => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    destroy: jest.fn().mockResolvedValue(undefined),
    forceDestroy: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    logout: jest.fn().mockResolvedValue(undefined),
    getQRCode: jest.fn().mockReturnValue(null),
});
/** A promise the test settles by hand. */
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};
const flush = async () => {
    for (let i = 0; i < 5; i++)
        await new Promise(resolve => setImmediate(resolve));
};
describe('SessionEngineLifecycle races', () => {
    let lifecycle;
    let internals;
    let repository;
    let engineFactory;
    let webhookService;
    let config;
    let dataSource;
    let hookManager;
    beforeEach(async () => {
        config = {};
        dataSource = {};
        hookManager = { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) };
        repository = {
            findOne: jest.fn().mockResolvedValue(session()),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            exists: jest.fn().mockResolvedValue(false),
        };
        engineFactory = {
            create: jest.fn().mockImplementation(() => makeEngine()),
            purgeSessionData: jest.fn().mockResolvedValue(undefined),
        };
        const module = await testing_1.Test.createTestingModule({
            providers: [
                session_service_1.SessionService,
                session_engine_lifecycle_service_1.SessionEngineLifecycle,
                session_error_store_service_1.SessionErrorStore,
                session_restriction_store_service_1.SessionRestrictionStore,
                presence_store_service_1.PresenceStore,
                { provide: (0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'), useValue: repository },
                { provide: (0, typeorm_1.getRepositoryToken)(message_entity_1.Message, 'data'), useValue: { find: jest.fn().mockResolvedValue([]) } },
                { provide: (0, typeorm_1.getDataSourceToken)('data'), useValue: dataSource },
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
                { provide: hooks_1.HookManager, useValue: hookManager },
                {
                    provide: config_1.ConfigService,
                    useValue: { get: jest.fn((key, def) => (key in config ? config[key] : def)) },
                },
                { provide: lid_mapping_store_service_1.LidMappingStoreService, useValue: { remember: jest.fn(), onSecondLid: jest.fn() } },
                { provide: status_store_service_1.StatusStoreService, useValue: { ingest: jest.fn() } },
            ],
        }).compile();
        lifecycle = module.get(session_engine_lifecycle_service_1.SessionEngineLifecycle);
        internals = lifecycle;
        webhookService = module.get(webhook_service_1.WebhookService);
    });
    afterEach(() => {
        for (const state of internals.reconnectStates.values())
            if (state.timer)
                clearTimeout(state.timer);
    });
    describe('MAX_CONCURRENT_SESSIONS', () => {
        it('counts a session waiting out a failed relaunch, which holds no engine', async () => {
            config['sessions.maxConcurrent'] = 1;
            const timer = setTimeout(() => undefined, 60_000);
            internals.reconnectStates.set('other', { attempts: 1, timer, maxAttempts: 5, baseDelay: 5000 });
            await expect(lifecycle.start(ID)).rejects.toThrow(new common_1.BadRequestException('Maximum concurrent sessions reached (1)'));
            expect(engineFactory.create).not.toHaveBeenCalled();
        });
        it('does not count the reconnect state of the session being started', async () => {
            config['sessions.maxConcurrent'] = 1;
            const timer = setTimeout(() => undefined, 60_000);
            internals.reconnectStates.set(ID, { attempts: 1, timer, maxAttempts: 5, baseDelay: 5000 });
            await lifecycle.start(ID);
            expect(internals.engines.has(ID)).toBe(true);
        });
    });
    describe('stopOrphanEngines against a start still reading its row', () => {
        it('retires the start instead of letting it clear the stop mark', async () => {
            const read = deferred();
            repository.findOne.mockReturnValueOnce(read.promise);
            const starting = lifecycle.start(ID);
            const outcome = starting.then(() => undefined, (e) => e);
            await flush();
            await expect(lifecycle.stopOrphanEngines([ID])).resolves.toEqual({
                stopped: [],
                notRunning: [ID],
                failed: [],
            });
            read.resolve(session());
            expect(await outcome).toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(engineFactory.create).not.toHaveBeenCalled();
            expect(internals.engines.has(ID)).toBe(false);
        });
        it('still clears a stop mark left from before the start began', async () => {
            await lifecycle.stopOrphanEngines([ID]);
            await lifecycle.start(ID);
            expect(internals.engines.has(ID)).toBe(true);
        });
        it('retires the start when an older stop mark was already present', async () => {
            await lifecycle.stopOrphanEngines([ID]);
            const read = deferred();
            repository.findOne.mockReturnValueOnce(read.promise);
            const outcome = lifecycle.start(ID).then(() => undefined, (e) => e);
            await flush();
            await expect(lifecycle.stopOrphanEngines([ID])).resolves.toEqual({
                stopped: [],
                notRunning: [ID],
                failed: [],
            });
            read.resolve(session());
            expect(await outcome).toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(engineFactory.create).not.toHaveBeenCalled();
        });
    });
    // A delete removes the rows of a session with a long history in many batches, long after its engine is gone.
    // The stop mark it set cannot refuse a start for that long: start() takes a mark that was already there when
    // it began for a stale one and clears it, which for the mark of a delete left an engine running on the
    // deleted session.
    describe('start against a delete in flight', () => {
        let gates;
        let transaction;
        // The next delete to look up rows waits here, which is where a delete spends its time on a long history.
        const hold = () => {
            const gate = deferred();
            gates.push(gate);
            return gate;
        };
        // What the delete ended with: nothing, or its error.
        const settle = (deleting) => deleting.then(() => undefined, (e) => e);
        // Starts a delete and leaves it waiting on its first batch, after it evicted the engine of a running session.
        const deleteInBatchPhase = async () => {
            await lifecycle.start(ID);
            const gate = hold();
            const settled = settle(lifecycle.delete(ID));
            await flush();
            expect(internals.engines.has(ID)).toBe(false);
            return { gate, settled };
        };
        beforeEach(() => {
            gates = [];
            const read = jest.fn(() => gates.shift()?.promise ?? Promise.resolve([]));
            // The messages of a session are read through a query builder: every chain call returns itself.
            const query = { getRawMany: read };
            for (const name of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
                query[name] = jest.fn().mockReturnValue(query);
            }
            const rows = { find: read, createQueryBuilder: jest.fn(() => query), delete: jest.fn() };
            const manager = { delete: jest.fn().mockResolvedValue({ affected: 0 }), remove: jest.fn() };
            transaction = jest.fn((work) => work(manager));
            Object.assign(dataSource, {
                options: { type: 'better-sqlite3' },
                getRepository: jest.fn(() => rows),
                transaction,
            });
        });
        it.each([
            ['an operator start', { explicit: true }],
            ['a boot or takeover start', { explicit: false }],
        ])('refuses %s and registers no engine', async (_who, options) => {
            const { gate, settled } = await deleteInBatchPhase();
            await expect(lifecycle.start(ID, options)).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(engineFactory.create).toHaveBeenCalledTimes(1);
            expect(internals.engines.has(ID)).toBe(false);
            gate.resolve([]);
            expect(await settled).toBeUndefined();
            expect(internals.engines.has(ID)).toBe(false);
        });
        it('leaves the stop mark of the delete in place for the whole delete', async () => {
            const { gate, settled } = await deleteInBatchPhase();
            await expect(lifecycle.start(ID)).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(internals.stoppingSessions.has(ID)).toBe(true);
            gate.resolve([]);
            await settled;
            expect(internals.stoppingSessions.has(ID)).toBe(false);
        });
        it('counts the delete as live until the rows are gone, so the lease of the session is renewed', async () => {
            expect(lifecycle.isEngineActive(ID)).toBe(false);
            const { gate, settled } = await deleteInBatchPhase();
            // The engine is evicted and nothing is starting or reconnecting: only the delete is left.
            expect(lifecycle.isEngineActive(ID)).toBe(true);
            gate.resolve([]);
            await settled;
            expect(lifecycle.isEngineActive(ID)).toBe(false);
        });
        it('lets the session start again when the delete failed', async () => {
            transaction.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
            const { gate, settled } = await deleteInBatchPhase();
            gate.resolve([]);
            expect((await settled).message).toContain('statement timeout');
            expect(lifecycle.isEngineActive(ID)).toBe(false);
            await lifecycle.start(ID, { explicit: true });
            expect(internals.engines.has(ID)).toBe(true);
        });
        it('holds back a start until the last of two overlapping deletes ends', async () => {
            transaction.mockRejectedValueOnce(new Error('canceling statement due to statement timeout'));
            const first = await deleteInBatchPhase();
            const secondGate = hold();
            const second = settle(lifecycle.delete(ID));
            await flush();
            // The first delete fails and drops the stop mark the second one is still running under.
            first.gate.resolve([]);
            expect((await first.settled).message).toContain('statement timeout');
            await expect(lifecycle.start(ID)).rejects.toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(internals.engines.has(ID)).toBe(false);
            secondGate.resolve([]);
            expect(await second).toBeUndefined();
            await lifecycle.start(ID);
            expect(internals.engines.has(ID)).toBe(true);
        });
        it('retires a start whose row read was still pending when the delete began', async () => {
            const read = deferred();
            repository.findOne.mockReturnValueOnce(read.promise);
            const starting = lifecycle.start(ID, { explicit: true }).then(() => undefined, (e) => e);
            await flush();
            const gate = hold();
            const settled = settle(lifecycle.delete(ID));
            await flush();
            read.resolve(session());
            expect(await starting).toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(engineFactory.create).not.toHaveBeenCalled();
            gate.resolve([]);
            await settled;
            expect(internals.engines.has(ID)).toBe(false);
        });
        // A start waiting in its session:starting hook has armed no reconnect state yet, so the stop or delete that
        // retires it has nothing to cancel. The start arms the state afterwards and must drop it when it is retired.
        describe('a start retired while it waits in its session:starting hook', () => {
            const parkInHook = async () => {
                const hook = deferred();
                hookManager.execute.mockImplementation(async (event) => {
                    if (event === 'session:starting')
                        await hook.promise;
                    return { continue: true, data: {} };
                });
                const outcome = lifecycle.start(ID, { explicit: true }).then(() => undefined, (e) => e);
                await flush();
                expect(internals.reconnectStates.has(ID)).toBe(false);
                return { release: hook.resolve, outcome };
            };
            it('leaves no reconnect state behind after a stop', async () => {
                const { release, outcome } = await parkInHook();
                await lifecycle.stop(ID);
                release();
                await outcome;
                expect(internals.engines.has(ID)).toBe(false);
                expect(internals.reconnectStates.has(ID)).toBe(false);
            });
            it('leaves no reconnect state behind after a delete that is still running', async () => {
                const { release, outcome } = await parkInHook();
                const gate = hold();
                const deleted = settle(lifecycle.delete(ID));
                await flush();
                release();
                await outcome;
                expect(internals.engines.has(ID)).toBe(false);
                expect(internals.reconnectStates.has(ID)).toBe(false);
                gate.resolve([]);
                await deleted;
            });
            it('leaves no reconnect state behind after a delete that has finished', async () => {
                const { release, outcome } = await parkInHook();
                await settle(lifecycle.delete(ID));
                repository.findOne.mockResolvedValue(null);
                release();
                await outcome;
                expect(internals.engines.has(ID)).toBe(false);
                expect(internals.reconnectStates.has(ID)).toBe(false);
            });
            it('keeps the state of an engine that registered while the retired one was torn down', async () => {
                const destroyed = deferred();
                const retired = { ...makeEngine(), destroy: jest.fn().mockReturnValue(destroyed.promise) };
                const replacement = makeEngine();
                const state = { attempts: 0, timer: null, maxAttempts: 5, baseDelay: 5000 };
                internals.engines.set(ID, retired);
                const reaping = internals.controls.reapRetiredEngine(ID, retired);
                await flush();
                internals.engines.set(ID, replacement);
                internals.reconnectStates.set(ID, state);
                destroyed.resolve();
                await reaping;
                expect(internals.engines.get(ID)).toBe(replacement);
                expect(internals.reconnectStates.get(ID)).toBe(state);
            });
        });
    });
    describe('stop against an explicit start still reading its row', () => {
        it('yields to a stop that lands while it waits, after an earlier stop', async () => {
            repository.findOne.mockResolvedValue(session({ desiredState: 'stopped' }));
            await lifecycle.stop(ID);
            const read = deferred();
            repository.findOne.mockReturnValueOnce(read.promise);
            const outcome = lifecycle.start(ID, { explicit: true }).then(() => undefined, (e) => e);
            await flush();
            await lifecycle.stop(ID);
            read.resolve(session({ desiredState: 'stopped' }));
            expect(await outcome).toBeInstanceOf(session_engine_controls_1.SessionStoppedException);
            expect(internals.engines.has(ID)).toBe(false);
        });
    });
    describe('rejectRebind', () => {
        const failedWrites = () => repository.update.mock.calls.filter(([, patch]) => patch.status === session_entity_1.SessionStatus.FAILED).length;
        it("retires the refused account's engine before its logout runs", async () => {
            const logout = deferred();
            const engine = { ...makeEngine(), logout: jest.fn().mockReturnValue(logout.promise) };
            internals.engines.set(ID, engine);
            const rejecting = internals.rejectRebind(ID, engine, NAME, '628111', '628999');
            await flush();
            // Every inbound callback is gated on this, so nothing the refused account sends while the
            // logout runs is stored or dispatched under this session.
            expect(engine.logout).toHaveBeenCalledTimes(1);
            expect(internals.engines.isLive(ID, engine)).toBe(false);
            logout.resolve();
            await rejecting;
            expect(failedWrites()).toBe(1);
        });
        it('leaves a start that registered an engine during the logout alone', async () => {
            const logout = deferred();
            const engine = { ...makeEngine(), logout: jest.fn().mockReturnValue(logout.promise) };
            const replacement = makeEngine();
            internals.engines.set(ID, engine);
            const rejecting = internals.rejectRebind(ID, engine, NAME, '628111', '628999');
            await flush();
            internals.engines.set(ID, replacement);
            logout.resolve();
            await rejecting;
            expect(internals.engines.get(ID)).toBe(replacement);
            expect(failedWrites()).toBe(0);
        });
    });
    describe('stop hooks', () => {
        it('records the stop after the session read and before the teardown', async () => {
            await lifecycle.start(ID);
            const engine = engineFactory.create.mock.results[0].value;
            const order = [];
            repository.findOne.mockImplementationOnce(() => {
                order.push('read');
                return Promise.resolve(session());
            });
            engine.disconnect.mockImplementation(() => {
                order.push('teardown');
                return Promise.resolve();
            });
            await lifecycle.stop(ID, {
                afterRead: () => {
                    order.push('record');
                    return Promise.resolve();
                },
            });
            expect(order).toEqual(['read', 'record', 'teardown']);
        });
        it('takes nothing down when recording the stop fails', async () => {
            await lifecycle.start(ID);
            const engine = engineFactory.create.mock.results[0].value;
            await expect(lifecycle.stop(ID, { afterRead: () => Promise.reject(new Error('SQLITE_BUSY')) })).rejects.toThrow('SQLITE_BUSY');
            expect(engine.disconnect).not.toHaveBeenCalled();
            expect(internals.engines.has(ID)).toBe(true);
        });
        it.each([
            [
                'stop',
                (onReadFailed, afterRead) => lifecycle.stop(ID, { afterRead, onReadFailed }),
            ],
            ['delete', (onReadFailed) => lifecycle.delete(ID, { onReadFailed })],
        ])('%s() reports a failed session read and records nothing', async (_verb, call) => {
            const onReadFailed = jest.fn();
            const afterRead = jest.fn().mockResolvedValue(undefined);
            repository.findOne.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
            await expect(call(onReadFailed, afterRead)).rejects.toThrow('Connection terminated unexpectedly');
            expect(onReadFailed).toHaveBeenCalledTimes(1);
            expect(afterRead).not.toHaveBeenCalled();
        });
    });
    describe('engine-driven status writes', () => {
        const rejectStatus = (status) => {
            repository.update.mockImplementation((_id, patch) => patch.status === status ? Promise.reject(new Error('SQLITE_BUSY')) : Promise.resolve({ affected: 1 }));
        };
        it('logs a failed DISCONNECTED write instead of leaving it unhandled', async () => {
            const warn = jest.spyOn(internals.logger, 'warn');
            rejectStatus(session_entity_1.SessionStatus.DISCONNECTED);
            const engine = makeEngine();
            internals.engines.set(ID, engine);
            await lifecycle.handleEngineDisconnected(ID, engine, 'NAVIGATION');
            await flush();
            expect(warn).toHaveBeenCalledWith('Failed to persist the disconnected status', {
                sessionId: ID,
                error: 'SQLITE_BUSY',
            });
        });
        it('logs a failed write of a status the engine reported', async () => {
            const warn = jest.spyOn(internals.logger, 'warn');
            await lifecycle.start(ID);
            const engine = engineFactory.create.mock.results[0].value;
            const callbacks = engine.initialize.mock.calls[0][0];
            rejectStatus(session_entity_1.SessionStatus.AUTHENTICATING);
            callbacks.onStateChanged?.(whatsapp_engine_interface_1.EngineStatus.AUTHENTICATING);
            await flush();
            expect(warn).toHaveBeenCalledWith('Failed to persist an engine status', {
                sessionId: ID,
                status: session_entity_1.SessionStatus.AUTHENTICATING,
                error: 'SQLITE_BUSY',
            });
        });
        it('logs a failed FAILED write when reconnect attempts run out', async () => {
            const warn = jest.spyOn(internals.logger, 'warn');
            rejectStatus(session_entity_1.SessionStatus.FAILED);
            internals.reconnectStates.set(ID, { attempts: 5, timer: null, maxAttempts: 5, baseDelay: 5000 });
            internals.scheduleReconnect(ID, session());
            await flush();
            expect(warn).toHaveBeenCalledWith('Failed to persist the reconnect-exhausted FAILED state', {
                sessionId: ID,
                error: 'SQLITE_BUSY',
            });
        });
    });
    // The engine reports DISCONNECTED itself, so the liveness watchdog never probes it again, and it stays
    // registered with its lease renewed: a disconnect whose row read fails once is not handled again by anything.
    describe('a disconnect whose session read fails', () => {
        afterEach(() => jest.useRealTimers());
        const disconnectWithFailedRead = async () => {
            await lifecycle.start(ID);
            const engine = engineFactory.create.mock.results[0].value;
            const callbacks = engine.initialize.mock.calls[0][0];
            const state = internals.reconnectStates.get(ID);
            jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
            repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
            callbacks.onDisconnected?.('NAVIGATION');
            await flush();
            return { engine, state };
        };
        it('handles the disconnect again, so a reconnect is armed once the read succeeds', async () => {
            const { engine, state } = await disconnectWithFailedRead();
            expect(state.attempts).toBe(0);
            expect(state.timer).not.toBeNull();
            jest.advanceTimersByTime(state.baseDelay);
            await flush();
            expect(state.attempts).toBe(1);
            expect(state.timer).not.toBeNull();
            expect(internals.engines.get(ID)).toBe(engine);
        });
        it('waits longer after each failed read, up to the reconnect backoff cap', async () => {
            const { state } = await disconnectWithFailedRead();
            repository.findOne.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
            const base = state.baseDelay;
            const before = repository.findOne.mock.calls.length;
            const readsAfter = async (ms) => {
                jest.advanceTimersByTime(ms);
                await flush();
                return repository.findOne.mock.calls.length - before;
            };
            expect(await readsAfter(base)).toBe(1);
            expect(await readsAfter(2 * base - 1)).toBe(1);
            expect(await readsAfter(1)).toBe(2);
            expect(await readsAfter(4 * base)).toBe(3);
            expect(await readsAfter(8 * base)).toBe(4);
            expect(await readsAfter(16 * base)).toBe(5);
            expect(await readsAfter(32 * base)).toBe(6);
            // The next wait would be 64 times the base delay, past the 5-minute cap the reconnect backoff keeps.
            expect(await readsAfter(300_000)).toBe(7);
        });
        it('starts the backoff over once the session reaches READY', async () => {
            const { engine, state } = await disconnectWithFailedRead();
            repository.findOne.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
            jest.advanceTimersByTime(state.baseDelay);
            await flush();
            jest.advanceTimersByTime(2 * state.baseDelay);
            await flush();
            internals.handleEngineReady(ID, engine, '628111', 'Push');
            await flush();
            expect(state.timer).toBeNull();
            const callbacks = engine.initialize.mock.calls[0][0];
            const before = repository.findOne.mock.calls.length;
            callbacks.onDisconnected?.('NAVIGATION');
            await flush();
            expect(repository.findOne.mock.calls.length - before).toBe(1);
            jest.advanceTimersByTime(state.baseDelay);
            await flush();
            expect(repository.findOne.mock.calls.length - before).toBe(2);
        });
        it('drops the pending retry when another report of the same disconnect reads the row', async () => {
            const { engine, state } = await disconnectWithFailedRead();
            const retry = state.timer;
            expect(retry).not.toBeNull();
            const published = () => webhookService.dispatch.mock.calls.filter(([, event]) => event === 'session.disconnected').length;
            await lifecycle.handleEngineDisconnected(ID, engine, 'NAVIGATION');
            await flush();
            // The reconnect was armed by this report, in place of the retry, which would publish it again.
            expect(published()).toBe(1);
            expect(state.attempts).toBe(1);
            expect(state.timer).not.toBeNull();
            expect(state.timer).not.toBe(retry);
        });
        it('does not read again once a stop has retired the engine', async () => {
            const { state } = await disconnectWithFailedRead();
            await lifecycle.stop(ID);
            const reads = repository.findOne.mock.calls.length;
            jest.advanceTimersByTime(state.baseDelay * 2);
            await flush();
            expect(repository.findOne.mock.calls.length).toBe(reads);
            expect(internals.reconnectStates.has(ID)).toBe(false);
        });
    });
    describe('a reconnect attempt failing while the next one tears its engine down', () => {
        it.each(['older first', 'later first'])('launches only the latest attempt when teardown finishes %s', async (order) => {
            const state = { attempts: 2, timer: null, maxAttempts: 5, baseDelay: 5000 };
            internals.reconnectStates.set(ID, state);
            const olderDestroy = deferred();
            const laterDestroy = deferred();
            const oldEngine = {
                ...makeEngine(),
                destroy: jest.fn().mockReturnValueOnce(olderDestroy.promise).mockReturnValueOnce(laterDestroy.promise),
            };
            internals.engines.set(ID, oldEngine);
            const older = internals.executeReconnect(ID, session(), state);
            await flush();
            const later = internals.executeReconnect(ID, session(), state);
            await flush();
            try {
                if (order === 'older first') {
                    olderDestroy.resolve();
                    await older;
                    laterDestroy.resolve();
                    await later;
                }
                else {
                    laterDestroy.resolve();
                    await later;
                    olderDestroy.resolve();
                    await older;
                }
                expect(engineFactory.create).toHaveBeenCalledTimes(1);
                const replacement = engineFactory.create.mock.results[0].value;
                expect(internals.engines.get(ID)).toBe(replacement);
                expect(replacement.destroy).not.toHaveBeenCalled();
                expect(replacement.forceDestroy).not.toHaveBeenCalled();
                expect(state).toMatchObject({ attempts: 2, started: 2, timer: null });
                expect(internals.reconnectStates.get(ID)).toBe(state);
            }
            finally {
                olderDestroy.resolve();
                laterDestroy.resolve();
                await Promise.allSettled([older, later]);
            }
        });
        it.each(['resolves', 'rejects'])('keeps the later initialization and parked failure when the older one %s', async (outcome) => {
            const state = { attempts: 2, timer: null, maxAttempts: 5, baseDelay: 5000 };
            internals.reconnectStates.set(ID, state);
            const olderInit = deferred();
            const laterInit = deferred();
            const olderEngine = { ...makeEngine(), initialize: jest.fn().mockReturnValue(olderInit.promise) };
            const laterEngine = {
                ...makeEngine(),
                initialize: jest.fn().mockReturnValue(laterInit.promise),
            };
            engineFactory.create.mockReturnValueOnce(olderEngine).mockReturnValueOnce(laterEngine);
            const older = internals.executeReconnect(ID, session(), state);
            await flush();
            const later = internals.executeReconnect(ID, session(), state);
            await flush();
            try {
                const callbacks = laterEngine.initialize.mock.calls[0][0];
                callbacks.onError?.('temporary network failure');
                const parked = state.parkedFailure;
                expect(parked).toBeDefined();
                if (outcome === 'resolves')
                    olderInit.resolve();
                else
                    olderInit.reject(new Error('Target closed'));
                await older;
                expect(state.initInFlight).toBe(true);
                expect(state.parkedFailure).toBe(parked);
                expect(internals.engines.get(ID)).toBe(laterEngine);
                expect(laterEngine.destroy).not.toHaveBeenCalled();
                expect(laterEngine.forceDestroy).not.toHaveBeenCalled();
                expect(state).toMatchObject({ attempts: 2, started: 2, timer: null });
            }
            finally {
                olderInit.resolve();
                laterInit.resolve();
                await Promise.allSettled([older, later]);
            }
        });
        it.each(['removed', 'stopped'])('keeps the replacement when an older retirement read finds the session %s', async (retired) => {
            const state = { attempts: 2, timer: null, maxAttempts: 5, baseDelay: 5000 };
            internals.reconnectStates.set(ID, state);
            const read = deferred();
            repository.findOne.mockReturnValueOnce(read.promise);
            const olderEngine = makeEngine();
            const laterEngine = makeEngine();
            engineFactory.create.mockReturnValueOnce(olderEngine).mockReturnValueOnce(laterEngine);
            const older = internals.executeReconnect(ID, session(), state);
            await flush();
            const later = internals.executeReconnect(ID, session(), state);
            try {
                await later;
                read.resolve(retired === 'removed' ? null : session({ desiredState: 'stopped' }));
                await older;
                expect(internals.engines.get(ID)).toBe(laterEngine);
                expect(olderEngine.destroy).toHaveBeenCalledTimes(1);
                expect(laterEngine.destroy).not.toHaveBeenCalled();
                expect(laterEngine.forceDestroy).not.toHaveBeenCalled();
                expect(internals.reconnectStates.get(ID)).toBe(state);
                expect(state).toMatchObject({ attempts: 2, started: 2, timer: null });
            }
            finally {
                read.resolve(session());
                await Promise.allSettled([older, later]);
            }
        });
        it('leaves the episode to the later attempt instead of arming another over it', async () => {
            const state = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
            internals.reconnectStates.set(ID, state);
            const initA = deferred();
            const destroyA = deferred();
            const engineA = {
                ...makeEngine(),
                initialize: jest.fn().mockReturnValue(initA.promise),
                destroy: jest.fn().mockReturnValue(destroyA.promise),
            };
            const engineB = makeEngine();
            engineFactory.create.mockReturnValueOnce(engineA).mockReturnValueOnce(engineB);
            const attemptA = internals.executeReconnect(ID, session(), state);
            await flush();
            expect(internals.engines.get(ID)).toBe(engineA);
            // Engine A drops mid-init: the next attempt is armed and fires, then waits on A's destroy.
            internals.scheduleReconnect(ID, session());
            clearTimeout(state.timer);
            state.timer = null;
            const attemptB = internals.executeReconnect(ID, session(), state);
            await flush();
            // Closing A is what makes its pending initialize() reject, before B has registered anything.
            initA.reject(new Error('Target closed'));
            await attemptA;
            expect(state.timer).toBeNull();
            destroyA.resolve();
            await attemptB;
            await flush();
            expect(internals.engines.get(ID)).toBe(engineB);
            expect(state.timer).toBeNull();
            expect(engineFactory.create).toHaveBeenCalledTimes(2);
        });
        // The browser of an attempt dies during its own init: it reports the disconnect while the session
        // read fails once, which arms a read retry on the episode's timer, and the same crash rejects init.
        describe('when the disconnect of its own engine armed a read retry', () => {
            afterEach(() => jest.useRealTimers());
            const crashDuringInit = async (readFails) => {
                jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
                const state = {
                    attempts: 1,
                    timer: null,
                    maxAttempts: Number.POSITIVE_INFINITY,
                    baseDelay: 5000,
                };
                internals.reconnectStates.set(ID, state);
                const init = deferred();
                const engine = { ...makeEngine(), initialize: jest.fn().mockReturnValue(init.promise) };
                engineFactory.create.mockReturnValueOnce(engine);
                const attempt = internals.executeReconnect(ID, session(), state);
                await flush();
                const callbacks = engine.initialize.mock.calls[0][0];
                if (readFails)
                    repository.findOne.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
                callbacks.onDisconnected?.('NAVIGATION');
                await flush();
                init.reject(new Error('Protocol error: Target closed'));
                await attempt;
                await flush();
                return state;
            };
            it('arms the next attempt instead of leaving the session with no engine and no timer', async () => {
                const state = await crashDuringInit(true);
                for (let i = 0; i < 4; i++) {
                    jest.advanceTimersByTime(300_000);
                    await flush();
                }
                expect(engineFactory.create.mock.calls.length).toBeGreaterThan(1);
                expect(state.readRetry).toBeUndefined();
            });
            it('relaunches the same way when the read answered', async () => {
                await crashDuringInit(false);
                for (let i = 0; i < 4; i++) {
                    jest.advanceTimersByTime(300_000);
                    await flush();
                }
                expect(engineFactory.create.mock.calls.length).toBeGreaterThan(1);
            });
        });
        it('re-arms when the attempt armed after it was cancelled by a READY before it fired', async () => {
            const state = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
            internals.reconnectStates.set(ID, state);
            const initA = deferred();
            const engineA = { ...makeEngine(), initialize: jest.fn().mockReturnValue(initA.promise) };
            engineFactory.create.mockReturnValueOnce(engineA);
            const attemptA = internals.executeReconnect(ID, session(), state);
            await flush();
            expect(internals.engines.get(ID)).toBe(engineA);
            // Engine A drops mid-init and arms the next attempt, then reaches READY, which cancels that timer.
            internals.scheduleReconnect(ID, session());
            expect(state.timer).not.toBeNull();
            internals.handleEngineReady(ID, engineA, '628111', 'Push');
            expect(state.timer).toBeNull();
            // A's init still rejects afterwards: nothing else owns the episode, so A must arm a recovery.
            initA.reject(new Error('Engine initialization timed out'));
            await attemptA;
            expect(internals.engines.has(ID)).toBe(false);
            expect(state.timer).not.toBeNull();
        });
    });
});
