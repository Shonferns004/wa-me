"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const session_ownership_service_1 = require("./session-ownership.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_entity_1 = require("./entities/session.entity");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const ID = '22222222-2222-4222-8222-222222222222';
const ME = 'node-a';
const PEER = 'node-b';
/**
 * A start (or reconnect) whose post-init read finds the session retired meanwhile tears its own engine
 * down. Both shipped adapters report DISCONNECTED through onStateChanged from inside destroy()
 * (whatsapp-web.js via beginClientTeardown, Baileys via setStatus at the end of destroy), while the
 * engine is still registered. When a peer has claimed the row, that report must not land on it: the
 * peer's engine is the live one, and nothing on the peer rewrites a status it already holds. When the
 * row is still this node's, or has no owner, it must still end DISCONNECTED.
 */
function fixture(afterInit) {
    let initialized = false;
    let row = {
        id: ID,
        name: 'retired-launch',
        phone: '628111',
        config: {},
        status: session_entity_1.SessionStatus.DISCONNECTED,
        desiredState: null,
        nodeId: ME,
        leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const settle = () => {
        if (afterInit === 'deleted')
            row = null;
        else if (afterInit === 'peer-claimed')
            // The peer took the lapsed claim and its engine is already up.
            Object.assign(row, { nodeId: PEER, leaseExpiresAt: new Date(Date.now() + 60_000), status: session_entity_1.SessionStatus.READY });
        else if (afterInit === 'own-lease-lapsed')
            // A database stall longer than the TTL; nobody took the row.
            Object.assign(row, { leaseExpiresAt: new Date(Date.now() - 1_000) });
        else
            // A peer's stop of the lapsed claim cleared it and recorded the stop.
            Object.assign(row, { nodeId: null, leaseExpiresAt: null, desiredState: 'stopped' });
    };
    // A repository that honours the columns a where clause names, so a write the predicate keeps off the
    // row really changes nothing.
    const matches = (where) => {
        if (!row)
            return false;
        if (typeof where === 'string')
            return where === row.id;
        if (Array.isArray(where))
            return where.some(matches);
        return Object.entries(where).every(([column, expected]) => {
            const actual = row[column];
            if (expected instanceof typeorm_1.FindOperator)
                return expected.type === 'isNull' ? actual == null : true;
            return actual === expected;
        });
    };
    let tearingDown = false;
    const teardownWrites = [];
    const repository = {
        findOne: jest.fn(() => Promise.resolve(row ? { ...row } : null)),
        exists: jest.fn().mockResolvedValue(true),
        update: jest.fn((where, patch) => {
            if (tearingDown)
                teardownWrites.push(patch);
            const hit = matches(where);
            if (hit)
                Object.assign(row, patch);
            return Promise.resolve({ affected: hit ? 1 : 0 });
        }),
    };
    // The real ownership service, so "do we own it?" is answered by its own in-memory claim set.
    const claimQuery = {
        update: () => claimQuery,
        set: () => claimQuery,
        where: () => claimQuery,
        andWhere: () => claimQuery,
        execute: () => Promise.resolve({ affected: 1 }),
    };
    const ownershipRepository = {
        createQueryBuilder: () => claimQuery,
        update: jest.fn().mockResolvedValue({ affected: 1 }),
        findOne: jest.fn(() => Promise.resolve(row ? { ...row } : null)),
    };
    const ownership = new session_ownership_service_1.SessionOwnershipService(ownershipRepository, {
        get: (key) => (key === 'session.nodeId' ? ME : undefined),
    });
    let callbacks;
    // What both adapters do on entry to their teardown: report DISCONNECTED synchronously.
    const reportTeardown = () => {
        tearingDown = true;
        callbacks?.onStateChanged?.(whatsapp_engine_interface_1.EngineStatus.DISCONNECTED);
        tearingDown = false;
        return Promise.resolve();
    };
    const engine = {
        initialize: jest.fn((cb) => {
            callbacks = cb;
            initialized = true;
            settle();
            return Promise.resolve();
        }),
        getStatus: () => whatsapp_engine_interface_1.EngineStatus.INITIALIZING,
        destroy: jest.fn(reportTeardown),
        forceDestroy: jest.fn(reportTeardown),
        disconnect: jest.fn().mockResolvedValue(undefined),
    };
    const factory = { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
    const state = { attachTo: (value) => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
    const emitSessionStatus = jest.fn();
    const registry = new engine_registry_service_1.EngineRegistry();
    const lifecycle = new session_engine_lifecycle_service_1.SessionEngineLifecycle(repository, {}, factory, registry, { clear: jest.fn() }, {}, state, state, state, { emitSessionStatus }, { dispatch: jest.fn().mockResolvedValue(undefined) }, { execute: jest.fn().mockResolvedValue({ continue: true }) }, {}, undefined, undefined, undefined, ownership);
    const announced = (status) => emitSessionStatus.mock.calls.filter(([, emitted]) => emitted === status).length;
    const reconnect = (reconnectState) => lifecycle.executeReconnect(ID, { ...row }, reconnectState);
    const states = () => lifecycle.reconnectStates;
    return {
        lifecycle,
        ownership,
        registry,
        engine,
        factory,
        repository,
        teardownWrites,
        announced,
        reconnect,
        states,
        row: () => row,
        initialized: () => initialized,
    };
}
const reconnectState = () => ({ attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 });
describe('a launch retired because a peer claimed its session', () => {
    it('start(): tears its own engine down without writing DISCONNECTED over the peer row', async () => {
        const f = fixture('peer-claimed');
        await expect(f.ownership.claim(ID)).resolves.toBe(true);
        await f.lifecycle.start(ID, { explicit: true });
        // The retirement happened: the engine this start built is gone.
        expect(f.engine.destroy).toHaveBeenCalled();
        expect(f.registry.has(ID)).toBe(false);
        // The row is the peer's; this node must not have written or announced a status for it after reading so.
        expect(f.teardownWrites).toEqual([]);
        expect(f.row()?.status).toBe(session_entity_1.SessionStatus.READY);
        expect(f.announced(session_entity_1.SessionStatus.DISCONNECTED)).toBe(0);
    });
    it('executeReconnect(): tears its own engine down without writing DISCONNECTED over the peer row', async () => {
        const f = fixture('peer-claimed');
        await expect(f.ownership.claim(ID)).resolves.toBe(true);
        const state = reconnectState();
        f.states().set(ID, state);
        await f.reconnect(state);
        expect(f.engine.destroy).toHaveBeenCalled();
        expect(f.registry.has(ID)).toBe(false);
        expect(f.teardownWrites).toEqual([]);
        expect(f.row()?.status).toBe(session_entity_1.SessionStatus.READY);
        expect(f.announced(session_entity_1.SessionStatus.DISCONNECTED)).toBe(0);
    });
});
describe('a launch retired on a row that is still this node or nobody', () => {
    // A launch retired on its OWN lapsed lease (nobody took the row) still settles the row to DISCONNECTED,
    // so it does not keep reading READY or INITIALIZING with no engine.
    it.each([
        ['start()', 'own-lease-lapsed'],
        ['executeReconnect()', 'own-lease-lapsed'],
        ['start()', 'peer-stopped'],
        ['executeReconnect()', 'peer-stopped'],
    ])('%s settles the row to DISCONNECTED when it reads %s', async (path, afterInit) => {
        const f = fixture(afterInit);
        await expect(f.ownership.claim(ID)).resolves.toBe(true);
        if (path === 'start()') {
            await f.lifecycle.start(ID, { explicit: true });
        }
        else {
            const state = reconnectState();
            f.states().set(ID, state);
            await f.reconnect(state);
        }
        expect(f.engine.destroy).toHaveBeenCalled();
        expect(f.registry.has(ID)).toBe(false);
        expect(f.row()?.status).toBe(session_entity_1.SessionStatus.DISCONNECTED);
        expect(f.announced(session_entity_1.SessionStatus.DISCONNECTED)).toBe(1);
    });
    it('start(): announces no status for a session deleted while it initialized', async () => {
        const f = fixture('deleted');
        await expect(f.ownership.claim(ID)).resolves.toBe(true);
        await expect(f.lifecycle.start(ID, { explicit: true })).rejects.toThrow('not found');
        expect(f.engine.destroy).toHaveBeenCalled();
        expect(f.registry.has(ID)).toBe(false);
        expect(f.factory.purgeSessionData).toHaveBeenCalledWith(ID);
        expect(f.announced(session_entity_1.SessionStatus.DISCONNECTED)).toBe(0);
    });
    // The engine is already gone when the status write runs, so a database that fails it must not turn the
    // retirement into a failed start: the start answers with the row it can read, as before.
    it('start(): still answers when the status write of the retirement fails', async () => {
        const f = fixture('own-lease-lapsed');
        const update = f.repository.update.getMockImplementation();
        f.repository.update.mockImplementation((where, patch) => Array.isArray(where) ? Promise.reject(new Error('database unavailable')) : update(where, patch));
        await expect(f.ownership.claim(ID)).resolves.toBe(true);
        await expect(f.lifecycle.start(ID, { explicit: true })).resolves.toMatchObject({ id: ID });
        expect(f.engine.destroy).toHaveBeenCalled();
        expect(f.registry.has(ID)).toBe(false);
        expect(f.announced(session_entity_1.SessionStatus.DISCONNECTED)).toBe(0);
    });
});
