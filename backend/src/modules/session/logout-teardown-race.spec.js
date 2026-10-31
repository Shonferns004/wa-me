"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const common_1 = require("@nestjs/common");
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
const SESSION_NAME = 'test-session';
const SESSION_UUID = 'sess-uuid-1';
function createMockSession(overrides = {}) {
    return {
        id: SESSION_UUID,
        name: SESSION_NAME,
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
    };
}
// Shared machine-code contract for the name-scoped teardown fence. Attaches a handler synchronously
// so a promise that already settled (or settles during a fake-timer advance before the await) is not
// flagged as an unhandled rejection. A resolved promise fails the assertion (the operation must NOT
// have proceeded); a rejected one asserts the stable code.
async function expectNameTeardownPending(p) {
    // Attach a handler synchronously to mark the rejection as handled.
    const captured = p.then(() => undefined, (e) => e);
    const err = await captured;
    // Nest serializes an object-response ConflictException into { statusCode, message, error, ...fields }.
    // The stable code is attached on the response object so REST callers can branch on it without parsing
    // the human message.
    const thrown = err;
    expect(thrown).toBeInstanceOf(common_1.ConflictException);
    expect(thrown?.response?.code).toBe('SESSION_NAME_TEARDOWN_PENDING');
}
/** The messages of a session are read through a query builder: every chain call returns itself, the raw read is empty. */
const emptyMessageQuery = () => {
    const query = { getRawMany: jest.fn().mockResolvedValue([]) };
    for (const name of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
        query[name] = jest.fn().mockReturnValue(query);
    }
    return query;
};
describe('SessionService logout() name-scoped teardown fence', () => {
    let service;
    // The teardown fence + lifecycle state live on the engine-lifecycle owner after the god-object
    // split; the white-box pokes below target it directly, the public-API calls stay on `service`.
    let lifecycle;
    let repository;
    let engineFactory;
    beforeEach(async () => {
        repository = {
            findOne: jest.fn().mockResolvedValue(createMockSession()),
            update: jest.fn().mockResolvedValue({ affected: 1 }),
            exists: jest.fn().mockResolvedValue(false),
        };
        const messageRepository = {
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: jest.fn(emptyMessageQuery),
            delete: jest.fn(),
        };
        const manager = { delete: jest.fn().mockResolvedValue({ affected: 1 }), remove: jest.fn() };
        const dataSource = {
            options: { type: 'better-sqlite3' },
            getRepository: jest.fn(() => messageRepository),
            transaction: jest.fn(async (cb) => cb(manager)),
        };
        const mockEngine = {
            initialize: jest.fn().mockResolvedValue(undefined),
            destroy: jest.fn().mockResolvedValue(undefined),
            forceDestroy: jest.fn().mockResolvedValue(undefined),
            disconnect: jest.fn().mockResolvedValue(undefined),
            getQRCode: jest.fn().mockReturnValue(null),
        };
        engineFactory = {
            create: jest.fn().mockReturnValue(mockEngine),
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
                { provide: (0, typeorm_1.getRepositoryToken)(message_entity_1.Message, 'data'), useValue: messageRepository },
                { provide: (0, typeorm_1.getDataSourceToken)('data'), useValue: dataSource },
                { provide: engine_factory_1.EngineFactory, useValue: engineFactory },
                // Real registry: this suite asserts on engine map state across the teardown fence.
                engine_registry_service_1.EngineRegistry,
                session_lid_resolver_service_1.SessionLidResolver,
                session_liveness_watchdog_service_1.SessionLivenessWatchdog,
                message_projector_service_1.MessageProjector,
                {
                    provide: events_gateway_1.EventsGateway,
                    useValue: { emitSessionStatus: jest.fn(), emitSessionDisconnected: jest.fn(), emitQRCode: jest.fn() },
                },
                { provide: webhook_service_1.WebhookService, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
                { provide: hooks_1.HookManager, useValue: { execute: jest.fn().mockResolvedValue({ continue: true, data: {} }) } },
                {
                    provide: config_1.ConfigService,
                    useValue: { get: jest.fn().mockImplementation((_k, d) => d) },
                },
                { provide: lid_mapping_store_service_1.LidMappingStoreService, useValue: { remember: jest.fn(), onSecondLid: jest.fn() } },
                { provide: status_store_service_1.StatusStoreService, useValue: { ingest: jest.fn() } },
            ],
        }).compile();
        service = module.get(session_service_1.SessionService);
        lifecycle = module.get(session_engine_lifecycle_service_1.SessionEngineLifecycle);
    });
    const enginesOf = () => service.engines;
    const pendingOf = () => lifecycle.pendingTeardowns;
    const stoppingOf = () => lifecycle.stoppingSessions;
    const reconnectStatesOf = () => lifecycle.reconnectStates;
    const errorsOf = () => service.sessionErrors;
    const lastStatusOf = () => lifecycle.lastDispatchedStatus;
    const rejectRebind = (previous, incoming, engine) => lifecycle.rejectRebind(SESSION_UUID, engine, SESSION_NAME, previous, incoming);
    it('rejectRebind logs the wrong account out, fails the session, and keeps the original binding', async () => {
        const logout = jest.fn().mockResolvedValue(undefined);
        const engine = { logout };
        enginesOf().set(SESSION_UUID, engine);
        await rejectRebind('628111', '628999', engine);
        // The wrong account is torn down, the session is parked in FAILED with a reason naming both
        // numbers, and the engine is dropped. The original binding is preserved: no `{ phone: null }`.
        expect(logout).toHaveBeenCalledTimes(1);
        expect(lastStatusOf().get(SESSION_UUID)).toBe(session_entity_1.SessionStatus.FAILED);
        expect(errorsOf().get(SESSION_UUID)).toEqual(expect.stringContaining('628111'));
        expect(errorsOf().get(SESSION_UUID)).toEqual(expect.stringContaining('628999'));
        expect(enginesOf().has(SESSION_UUID)).toBe(false);
        expect(stoppingOf().has(SESSION_UUID)).toBe(true);
        expect(repository.update).not.toHaveBeenCalledWith(SESSION_UUID, { phone: null });
    });
    it('rejectRebind on a stale engine does nothing (isLiveEngine gate)', async () => {
        const logout = jest.fn().mockResolvedValue(undefined);
        const staleEngine = { logout };
        // A DIFFERENT engine is the live one, so the stale handler must not log out or fail the session.
        enginesOf().set(SESSION_UUID, { logout: jest.fn() });
        await rejectRebind('628111', '628999', staleEngine);
        expect(logout).not.toHaveBeenCalled();
        expect(lastStatusOf().get(SESSION_UUID)).not.toBe(session_entity_1.SessionStatus.FAILED);
    });
    it('quick-settling teardown: start waits for it, then proceeds', async () => {
        let releaseLogout;
        const wedgedLogout = new Promise(res => {
            releaseLogout = res;
        });
        const engine = { logout: jest.fn().mockReturnValue(wedgedLogout) };
        enginesOf().set(SESSION_UUID, engine);
        jest.useFakeTimers();
        try {
            const logoutCall = service.logout(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(10_000); // logout loses its deadline race → 502
            await expect(logoutCall).rejects.toBeInstanceOf(common_1.BadGatewayException);
            // Tracked under the session NAME, not the UUID.
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            expect(pendingOf().has(SESSION_UUID)).toBe(false);
            const startCall = service.start(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(1_000); // inside the bounded wait
            expect(engineFactory.create).not.toHaveBeenCalled();
            releaseLogout();
            await startCall;
            expect(engineFactory.create).toHaveBeenCalledTimes(1);
            expect(pendingOf().has(SESSION_NAME)).toBe(false); // self-removed on settlement
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('quick-settling teardown: delete waits for it, then proceeds and purges', async () => {
        repository.findOne.mockResolvedValue(createMockSession({ id: SESSION_UUID, name: SESSION_NAME }));
        let releaseLogout;
        const wedgedLogout = new Promise(res => {
            releaseLogout = res;
        });
        enginesOf().set(SESSION_UUID, { logout: jest.fn().mockReturnValue(wedgedLogout) });
        jest.useFakeTimers();
        try {
            const logoutCall = service.logout(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(10_000);
            await expect(logoutCall).rejects.toBeInstanceOf(common_1.BadGatewayException);
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            const deleteCall = service.delete(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(1_000); // inside the bounded wait
            expect(engineFactory.purgeSessionData).not.toHaveBeenCalled();
            releaseLogout();
            await deleteCall;
            expect(engineFactory.purgeSessionData).toHaveBeenCalledWith(SESSION_UUID, SESSION_NAME);
            expect(pendingOf().has(SESSION_NAME)).toBe(false);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('old-name teardown still pending past 10s: start rejects 409 and does not create the engine', async () => {
        // The wedged logout never settles: its rm sits behind the wedge but is still "in flight" against
        // this session NAME. A start() for a (re)created session under the SAME name must refuse rather
        // than re-create credentials the rm could still hit.
        const neverSettles = new Promise(() => undefined);
        const engine = { logout: jest.fn().mockReturnValue(neverSettles) };
        enginesOf().set(SESSION_UUID, engine);
        jest.useFakeTimers();
        try {
            const logoutCall = service.logout(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(10_000); // logout loses its race → 502; raw keeps running
            await expect(logoutCall).rejects.toBeInstanceOf(common_1.BadGatewayException);
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            const startCall = service.start(SESSION_UUID);
            startCall.catch(() => undefined); // mark rejection handled across the timer advance below
            await jest.advanceTimersByTimeAsync(10_000); // bounded wait exhausts → fail CLOSED
            await expectNameTeardownPending(startCall);
            expect(engineFactory.create).not.toHaveBeenCalled();
            // The fence is NOT dropped on a refused start.
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('old-name teardown still pending past 10s: delete rejects 409, transaction parent removal and purgeSessionData not called (unique name still reserved)', async () => {
        const manager = { delete: jest.fn().mockResolvedValue({ affected: 1 }), remove: jest.fn() };
        const dataSource = {
            options: { type: 'better-sqlite3' },
            getRepository: jest.fn(() => ({
                find: jest.fn().mockResolvedValue([]),
                createQueryBuilder: jest.fn(emptyMessageQuery),
                delete: jest.fn(),
            })),
            transaction: jest.fn(async (cb) => cb(manager)),
        };
        // Swap in a dataSource whose transaction we can assert was NOT run. delete() runs on the
        // lifecycle owner now, so the swap must land there to intercept the path under test.
        lifecycle.dataSource = dataSource;
        repository.findOne.mockResolvedValue(createMockSession({ id: SESSION_UUID, name: SESSION_NAME }));
        const neverSettles = new Promise(() => undefined);
        enginesOf().set(SESSION_UUID, { logout: jest.fn().mockReturnValue(neverSettles) });
        jest.useFakeTimers();
        try {
            const logoutCall = service.logout(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(10_000);
            await expect(logoutCall).rejects.toBeInstanceOf(common_1.BadGatewayException);
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            const deleteCall = service.delete(SESSION_UUID);
            deleteCall.catch(() => undefined); // mark rejection handled across the timer advance below
            await jest.advanceTimersByTimeAsync(10_000); // first fence already pending → fail fast
            await expectNameTeardownPending(deleteCall);
            expect(dataSource.transaction).not.toHaveBeenCalled();
            expect(engineFactory.purgeSessionData).not.toHaveBeenCalled();
            // Name still reserved: the fence survives the refused delete.
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('on a first-fence 409, start does not touch reconnect timer / engine / last status / error / recovery state', async () => {
        // Arm a reconnect timer + a stale FAILED error + a last-dispatched status BEFORE the start attempt,
        // then ensure a refused start (409) leaves ALL of them untouched.
        const neverSettles = new Promise(() => undefined);
        enginesOf().set(SESSION_UUID, { logout: jest.fn().mockReturnValue(neverSettles) });
        jest.useFakeTimers();
        try {
            const logoutCall = service.logout(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(10_000);
            await expect(logoutCall).rejects.toBeInstanceOf(common_1.BadGatewayException);
            // Seed lifecycle state that a buggy "clear on 409" would wipe.
            reconnectStatesOf().set(SESSION_UUID, {
                attempts: 3,
                timer: setTimeout(() => undefined, 999_999),
                maxAttempts: 5,
                baseDelay: 1000,
            });
            errorsOf().set(SESSION_UUID, 'previously failed');
            lastStatusOf().set(SESSION_UUID, session_entity_1.SessionStatus.FAILED);
            // The prior logout already cleared the engine from the map; capture membership NOW so the
            // assertion checks the start's 409 did not mutate it (rather than the prior logout's effect).
            const enginePresentBefore = enginesOf().has(SESSION_UUID);
            const startCall = service.start(SESSION_UUID);
            startCall.catch(() => undefined); // mark rejection handled across the timer advance below
            await jest.advanceTimersByTimeAsync(10_000);
            await expectNameTeardownPending(startCall);
            // None of the pre-existing lifecycle state was cleared by the refused start.
            expect(reconnectStatesOf().has(SESSION_UUID)).toBe(true);
            expect(errorsOf().get(SESSION_UUID)).toBe('previously failed');
            expect(lastStatusOf().get(SESSION_UUID)).toBe(session_entity_1.SessionStatus.FAILED);
            // The engine map was not mutated by the refused start either.
            expect(enginesOf().has(SESSION_UUID)).toBe(enginePresentBefore);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('a refused delete does NOT drop the pending fence', async () => {
        const neverSettles = new Promise(() => undefined);
        enginesOf().set(SESSION_UUID, { logout: jest.fn().mockReturnValue(neverSettles) });
        jest.useFakeTimers();
        try {
            const logoutCall = service.logout(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(10_000);
            await expect(logoutCall).rejects.toBeInstanceOf(common_1.BadGatewayException);
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            const deleteCall = service.delete(SESSION_UUID);
            deleteCall.catch(() => undefined); // mark rejection handled across the timer advance below
            await jest.advanceTimersByTimeAsync(10_000); // first fence exhausts its bounded wait → fail CLOSED
            await expectNameTeardownPending(deleteCall);
            // The fence is owned by the session NAME and outlives the refused delete.
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('a logout starting after delete first fence but before engine eviction is caught by the second fence', async () => {
        // delete() runs two fences: one right after findOne, one right after the engine is evicted. A logout
        // that slips past fence #1 (no pending teardown yet) but captures the live engine before eviction
        // must register its destructive promise synchronously (the adapter fires onCredentialTeardownStarted
        // the instant engine.logout() begins), so fence #2 sees it and the delete refuses instead of freeing
        // the name while an old remover is live.
        repository.findOne.mockResolvedValue(createMockSession({ id: SESSION_UUID, name: SESSION_NAME }));
        let releaseLogout;
        const logoutPromise = new Promise(res => {
            releaseLogout = res;
        });
        // The engine is torn down via forceDestroy during delete. A concurrent logout that captured this
        // engine fires its credential-teardown callback synchronously inside that teardown window — between
        // fence #1 and fence #2. Drive the service's own tracking the same way the adapter would.
        const trackPending = lifecycle.trackPendingCredentialTeardown.bind(lifecycle);
        enginesOf().set(SESSION_UUID, {
            forceDestroy: jest.fn().mockImplementation(() => {
                // Simulate the adapter firing onCredentialTeardownStarted for a logout that captured this
                // engine mid-delete — registers under the session name synchronously, before fence #2 runs.
                trackPending(SESSION_NAME, logoutPromise);
                return Promise.resolve();
            }),
        });
        jest.useFakeTimers();
        try {
            const deleteCall = service.delete(SESSION_UUID);
            deleteCall.catch(() => undefined); // mark rejection handled across the timer advance below
            await jest.advanceTimersByTimeAsync(10_000); // second fence exhausts its bounded wait
            await expectNameTeardownPending(deleteCall);
            expect(engineFactory.purgeSessionData).not.toHaveBeenCalled();
            // Row/name still reserved: the second fence refused before the transaction.
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            // The engine was already destroyed and evicted before this fence, so the surviving row must not
            // keep advertising a status it can no longer honour — the retry this 409 asks for should not have
            // to look past a session that still reads READY with nothing behind it.
            expect(enginesOf().has(SESSION_UUID)).toBe(false);
            expect(repository.update).toHaveBeenCalledWith(SESSION_UUID, expect.objectContaining({ status: session_entity_1.SessionStatus.DISCONNECTED }));
            // After the raw teardown settles, the name is released.
            releaseLogout();
            await jest.advanceTimersByTimeAsync(0);
            expect(pendingOf().has(SESSION_NAME)).toBe(false);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('after the raw teardown resolves, retry start succeeds and the entry self-removes', async () => {
        let releaseLogout;
        const wedgedLogout = new Promise(res => {
            releaseLogout = res;
        });
        const engine = { logout: jest.fn().mockReturnValue(wedgedLogout) };
        enginesOf().set(SESSION_UUID, engine);
        jest.useFakeTimers();
        try {
            const logoutCall = service.logout(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(10_000);
            await expect(logoutCall).rejects.toBeInstanceOf(common_1.BadGatewayException);
            const startCall = service.start(SESSION_UUID);
            startCall.catch(() => undefined); // mark rejection handled across the timer advance below
            await jest.advanceTimersByTimeAsync(10_000);
            await expectNameTeardownPending(startCall);
            releaseLogout();
            await jest.advanceTimersByTimeAsync(0);
            expect(pendingOf().has(SESSION_NAME)).toBe(false);
            // Retry start now proceeds cleanly.
            const retry = service.start(SESSION_UUID);
            await jest.advanceTimersByTimeAsync(0);
            await retry;
            expect(engineFactory.create).toHaveBeenCalledTimes(1);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('two concurrent logouts for the same name keep the fence until BOTH settle', async () => {
        // The first logout's raw wedges (its profile rm outlives the request); the second logout's raw
        // rejects fast (the client is already tearing down). The fence must stay until the FIRST
        // (still-running) raw settles — otherwise the second's fast settlement would drop the entry while
        // the first rm is still pending.
        let settleFirst;
        const wedgedLogout = new Promise(res => {
            settleFirst = res;
        });
        const logout = jest
            .fn()
            .mockImplementationOnce(() => wedgedLogout)
            .mockImplementationOnce(() => 
        // The client is already tearing down after the first logout captured it; mirror the adapter's
        // own "no live client" refusal. Built lazily so no stray unhandled rejection is created.
        Promise.reject(new Error('No live WhatsApp Web client — the unlink was not sent')));
        enginesOf().set(SESSION_UUID, { logout });
        jest.useFakeTimers();
        try {
            const first = service.logout(SESSION_UUID);
            first.catch(() => undefined); // mark rejection handled across the timer advances below
            await jest.advanceTimersByTimeAsync(0);
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            const second = service.logout(SESSION_UUID);
            await expect(second).rejects.toBeInstanceOf(common_1.BadGatewayException);
            // The second's fast-rejecting raw has settled, but the FIRST raw is still wedged → fence stays.
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            // The first loses its 10s deadline race → 502 (unconfirmed), but its raw keeps running.
            await jest.advanceTimersByTimeAsync(10_000);
            await expect(first).rejects.toBeInstanceOf(common_1.BadGatewayException);
            // Still wedged → fence STILL up (the fast settlement of the second did not drop it).
            expect(pendingOf().has(SESSION_NAME)).toBe(true);
            settleFirst();
            await jest.advanceTimersByTimeAsync(0);
            expect(pendingOf().has(SESSION_NAME)).toBe(false);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('map assertions use the session name, not the UUID', async () => {
        // Regression guard: the key MUST be the session name (the on-disk auth-dir key), never the UUID.
        const engine = { logout: jest.fn().mockResolvedValue(undefined) };
        enginesOf().set(SESSION_UUID, engine);
        await service.logout(SESSION_UUID);
        expect(pendingOf().has(SESSION_UUID)).toBe(false);
        // A quick-settling logout self-removes, so neither key is present.
        expect(pendingOf().has(SESSION_NAME)).toBe(false);
        expect(stoppingOf().has(SESSION_UUID)).toBe(true);
    });
});
