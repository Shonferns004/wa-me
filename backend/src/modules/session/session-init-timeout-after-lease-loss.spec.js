"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_entity_1 = require("./entities/session.entity");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const ID = '55555555-5555-4555-8555-555555555555';
const ME = 'node-a';
const PEER = 'node-b';
/** Whether an update's where clause selects the stored row, for the id, nodeId and IsNull() forms used here. */
function selects(where, row) {
    if (typeof where === 'string')
        return where === row.id;
    const clauses = Array.isArray(where) ? where : [where];
    return clauses.some(clause => Object.entries(clause).every(([key, value]) => {
        const actual = row[key];
        if (value && typeof value === 'object' && value.type === (0, typeorm_1.IsNull)().type) {
            return actual == null;
        }
        if (value && typeof value === 'object')
            return true; // other operators are not under test here
        return actual === value;
    }));
}
/**
 * Once this node has lost a session's lease, the row belongs to the peer that claimed it: the local
 * engine is torn down and nothing this node still has in flight for that session may write the row
 * (docs/31 INV-6). An engine whose initialization is still pending when the loss is noticed has an init
 * deadline still armed; when it fires during the lease-loss teardown it must leave the peer's status alone.
 */
function fixture(nodeId = ME) {
    const stored = {
        id: ID,
        name: 'lease-lost-during-init',
        phone: '628111',
        config: {},
        status: session_entity_1.SessionStatus.DISCONNECTED,
        desiredState: null,
        nodeId,
    };
    const repository = {
        findOne: jest.fn(() => Promise.resolve({ ...stored })),
        exists: jest.fn().mockResolvedValue(true),
        update: jest.fn((where, patch) => {
            const hit = selects(where, stored);
            if (hit)
                Object.assign(stored, patch);
            return Promise.resolve({ affected: hit ? 1 : 0 });
        }),
    };
    // initialize() never settles (a navigation that never completes), and a graceful destroy() of that
    // wedged browser never settles either; the SIGKILL in forceDestroy() does.
    const engine = {
        initialize: jest.fn(() => new Promise(() => undefined)),
        getStatus: () => whatsapp_engine_interface_1.EngineStatus.INITIALIZING,
        destroy: jest.fn(() => new Promise(() => undefined)),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        logout: jest.fn().mockResolvedValue(undefined),
    };
    const factory = { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
    const state = { attachTo: (value) => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
    const restrictions = { ...state, clearIfDisprovedByReady: jest.fn() };
    const presence = { clear: jest.fn(), getOwnIntent: jest.fn() };
    const events = {
        emitSessionStatus: jest.fn(),
        emitSessionDisconnected: jest.fn(),
        emitSessionAuthenticated: jest.fn(),
    };
    let owned = true;
    const ownership = {
        nodeId: ME,
        owns: jest.fn(() => owned),
        prepareStart: jest.fn().mockResolvedValue(true),
    };
    const registry = new engine_registry_service_1.EngineRegistry();
    const lifecycle = new session_engine_lifecycle_service_1.SessionEngineLifecycle(repository, {}, factory, registry, { clear: jest.fn() }, {}, state, restrictions, presence, events, { dispatch: jest.fn().mockResolvedValue(undefined) }, { execute: jest.fn().mockResolvedValue({ continue: true }) }, {}, undefined, undefined, undefined, ownership);
    /** The peer takes the lapsed lease over and its own engine reports ready; this node notices the loss. */
    const peerAdopts = () => {
        stored.nodeId = PEER;
        stored.status = session_entity_1.SessionStatus.READY;
        owned = false;
    };
    return { lifecycle, registry, stored, events, peerAdopts };
}
describe('an init deadline that fires after this node lost the lease', () => {
    const previous = process.env.WWEBJS_AUTH_TIMEOUT_MS;
    beforeEach(() => {
        delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
        if (previous === undefined)
            delete process.env.WWEBJS_AUTH_TIMEOUT_MS;
        else
            process.env.WWEBJS_AUTH_TIMEOUT_MS = previous;
    });
    it("leaves the peer's status on the row while the lease-loss teardown is still running", async () => {
        const f = fixture();
        const start = f.lifecycle.start(ID).catch((error) => error);
        await jest.advanceTimersByTimeAsync(0);
        expect(f.registry.has(ID)).toBe(true);
        // 55 s into the init, the heartbeat finds the claim gone and tears the local engine down
        // (SessionService's onLeaseLoss handler), which writes no row.
        await jest.advanceTimersByTimeAsync(55_000);
        f.peerAdopts();
        const orphanStop = f.lifecycle.stopOrphanEngines([ID]);
        // The 60 s init deadline fires while the graceful destroy of the wedged engine is still pending.
        await jest.advanceTimersByTimeAsync(30_000);
        await orphanStop;
        await start;
        // The fake repository applies a write only to a row its where clause selects.
        expect(f.stored.status).toBe(session_entity_1.SessionStatus.READY);
        expect(f.stored.nodeId).toBe(PEER);
        expect(f.events.emitSessionStatus).not.toHaveBeenCalledWith(ID, session_entity_1.SessionStatus.DISCONNECTED);
    });
    it.each([
        ['still holds', ME],
        ['has no owner of', null],
    ])('still marks the session disconnected when this node %s the row', async (_case, nodeId) => {
        const f = fixture(nodeId);
        const start = f.lifecycle.start(ID).catch((error) => error);
        await jest.advanceTimersByTimeAsync(60_000);
        await start;
        expect(f.registry.has(ID)).toBe(false);
        expect(f.stored.status).toBe(session_entity_1.SessionStatus.DISCONNECTED);
        expect(f.events.emitSessionStatus).toHaveBeenLastCalledWith(ID, session_entity_1.SessionStatus.DISCONNECTED);
    });
});
