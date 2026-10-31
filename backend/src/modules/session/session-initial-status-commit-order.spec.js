"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_entity_1 = require("./entities/session.entity");
const ID = '55555555-5555-4555-8555-555555555555';
/**
 * INV-2 at the control level: the INITIALIZING update issued before initialize() may COMMIT after a
 * retiring control has issued its own write (a PostgreSQL pool runs them on different connections).
 * Each retiring verb awaits that pending write first, so its own effect lands last. Here the
 * INITIALIZING effect is applied only when its reply arrives, inside the verb's wait bound.
 */
function fixture() {
    let row = { id: ID, name: 'late-commit', phone: '628111', config: {} };
    const ops = [];
    let releaseInitial;
    const initialReply = new Promise(resolve => (releaseInitial = resolve));
    let firstInitial = true;
    const repository = {
        findOne: jest.fn(() => Promise.resolve(row ? { ...row } : null)),
        exists: jest.fn().mockResolvedValue(false),
        update: jest.fn((_id, patch) => {
            const apply = () => {
                if (row)
                    Object.assign(row, patch);
                if (patch.status)
                    ops.push(String(patch.status));
                return { affected: row ? 1 : 0 };
            };
            if (patch.status === session_entity_1.SessionStatus.INITIALIZING && firstInitial) {
                firstInitial = false;
                return initialReply.then(apply);
            }
            return Promise.resolve(apply());
        }),
    };
    const query = {
        select: jest.fn(),
        addSelect: jest.fn(),
        where: jest.fn(),
        andWhere: jest.fn(),
        orderBy: jest.fn(),
        addOrderBy: jest.fn(),
        limit: jest.fn(),
        getRawMany: jest.fn().mockResolvedValue([]),
    };
    for (const method of ['select', 'addSelect', 'where', 'andWhere', 'orderBy', 'addOrderBy', 'limit']) {
        query[method].mockReturnValue(query);
    }
    const manager = {
        delete: jest.fn().mockResolvedValue({ affected: 0 }),
        remove: jest.fn(() => {
            row = null;
            ops.push('removed');
            return Promise.resolve();
        }),
    };
    const dataSource = {
        options: { type: 'postgres' },
        getRepository: (target) => ({
            target,
            find: jest.fn().mockResolvedValue([]),
            createQueryBuilder: () => query,
        }),
        transaction: jest.fn((run) => run(manager)),
    };
    const engine = {
        initialize: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
        logout: jest.fn().mockResolvedValue(undefined),
    };
    const state = { attachTo: (value) => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
    const lifecycle = new session_engine_lifecycle_service_1.SessionEngineLifecycle(repository, dataSource, { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) }, new engine_registry_service_1.EngineRegistry(), {}, {}, state, state, state, { emitSessionStatus: jest.fn() }, { dispatch: jest.fn().mockResolvedValue(undefined) }, { execute: jest.fn().mockResolvedValue({ continue: true }) }, {});
    const init = lifecycle
        .initializeEngine(ID, { ...row })
        .catch(() => undefined);
    return { lifecycle, ops, releaseInitial, init, row: () => row };
}
describe('a retiring control while the INITIALIZING write commits late', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });
    it.each(['stop', 'logout', 'forceKill', 'delete'])('%s lands after the INITIALIZING commit', async (verb) => {
        const f = fixture();
        const control = f.lifecycle[verb](ID).catch(() => undefined);
        // Let the control run as far as it goes without the INITIALIZING reply.
        await jest.advanceTimersByTimeAsync(0);
        f.releaseInitial();
        await jest.advanceTimersByTimeAsync(0);
        await control;
        await f.init;
        if (verb === 'delete') {
            expect(f.ops).toEqual([session_entity_1.SessionStatus.INITIALIZING, 'removed']);
        }
        else {
            expect(f.ops[0]).toBe(session_entity_1.SessionStatus.INITIALIZING);
            expect(f.row()?.status).toBe(session_entity_1.SessionStatus.DISCONNECTED);
        }
    });
});
