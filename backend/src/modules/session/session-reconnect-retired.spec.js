"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const ID = '11111111-1111-4111-8111-111111111111';
function fixture(row) {
    const stored = { id: ID, name: 'retired-reconnect', phone: '628111', config: {}, ...row };
    const repository = {
        findOne: jest.fn(() => Promise.resolve({ ...stored })),
        exists: jest.fn().mockResolvedValue(false),
        update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const state = { attachTo: (value) => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
    const engine = {
        initialize: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn().mockResolvedValue(undefined),
        forceDestroy: jest.fn().mockResolvedValue(undefined),
    };
    const factory = { create: jest.fn(() => engine), purgeSessionData: jest.fn().mockResolvedValue(undefined) };
    const registry = new engine_registry_service_1.EngineRegistry();
    const lifecycle = new session_engine_lifecycle_service_1.SessionEngineLifecycle(repository, {}, factory, registry, {}, {}, state, state, state, { emitSessionStatus: jest.fn() }, { dispatch: jest.fn().mockResolvedValue(undefined) }, { execute: jest.fn().mockResolvedValue({ continue: true }) }, {});
    const reconnect = (reconnectState) => lifecycle.executeReconnect(ID, { ...stored }, reconnectState);
    const states = () => lifecycle.reconnectStates;
    return { lifecycle, registry, engine, reconnect, states };
}
describe('a reconnect that finishes initializing for a stopped session', () => {
    it('leaves nothing pending once the engine it built is retired', async () => {
        const f = fixture({ desiredState: 'stopped' });
        const state = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
        f.states().set(ID, state);
        await f.reconnect(state);
        expect(f.engine.destroy).toHaveBeenCalled();
        expect(f.registry.has(ID)).toBe(false);
        expect(f.lifecycle.isEngineActive(ID)).toBe(false);
        expect(f.lifecycle.startSlotHolders().has(ID)).toBe(false);
    });
    it('keeps the engine and the pending attempt of a session that is still wanted', async () => {
        const f = fixture({ desiredState: null });
        const state = { attempts: 1, timer: null, maxAttempts: 5, baseDelay: 5000 };
        f.states().set(ID, state);
        await f.reconnect(state);
        expect(f.engine.destroy).not.toHaveBeenCalled();
        expect(f.registry.has(ID)).toBe(true);
        expect(f.lifecycle.isEngineActive(ID)).toBe(true);
    });
});
