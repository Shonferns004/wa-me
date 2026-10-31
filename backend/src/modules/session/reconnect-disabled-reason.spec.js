"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const session_error_store_service_1 = require("./session-error-store.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const session_entity_1 = require("./entities/session.entity");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const ID = '44444444-4444-4444-8444-444444444444';
/**
 * `maxReconnectAttempts: 0` turns the gateway's reconnect off. The first drop then ends the episode at
 * once, and the reason recorded for it is what GET /sessions/:id serves as `lastError` next to the
 * status the row was left in. The two must describe the same state.
 */
describe('a drop with reconnect disabled', () => {
    it('records a reason that matches the status the session is left in', async () => {
        const stored = {
            id: ID,
            name: 'no-reconnect',
            phone: '628111',
            config: { maxReconnectAttempts: 0 },
            status: session_entity_1.SessionStatus.DISCONNECTED,
            desiredState: null,
        };
        const repository = {
            findOne: jest.fn(() => Promise.resolve({ ...stored })),
            exists: jest.fn().mockResolvedValue(true),
            update: jest.fn((_where, patch) => {
                Object.assign(stored, patch);
                return Promise.resolve({ affected: 1 });
            }),
        };
        let callbacks;
        const engine = {
            initialize: jest.fn((cb) => {
                callbacks = cb;
                return Promise.resolve();
            }),
            getStatus: () => whatsapp_engine_interface_1.EngineStatus.READY,
            destroy: jest.fn().mockResolvedValue(undefined),
            forceDestroy: jest.fn().mockResolvedValue(undefined),
        };
        const errors = new session_error_store_service_1.SessionErrorStore();
        const state = { attachTo: (value) => value, clear: jest.fn(), set: jest.fn(), get: jest.fn() };
        const lifecycle = new session_engine_lifecycle_service_1.SessionEngineLifecycle(repository, {}, { create: jest.fn(() => engine), purgeSessionData: jest.fn() }, new engine_registry_service_1.EngineRegistry(), { clear: jest.fn() }, {}, errors, state, { clear: jest.fn() }, { emitSessionStatus: jest.fn(), emitSessionDisconnected: jest.fn() }, { dispatch: jest.fn().mockResolvedValue(undefined) }, { execute: jest.fn().mockResolvedValue({ continue: true }) }, {});
        await lifecycle.start(ID, { explicit: true });
        callbacks.onDisconnected('TIMEOUT');
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        const lastError = errors.attachTo({ ...stored }).lastError ?? '';
        expect(stored.status).toBe(session_entity_1.SessionStatus.FAILED);
        // A failed session must not be described as one that was left disconnected.
        expect(lastError).not.toMatch(/left disconnected/);
        expect(lastError).toMatch(/marked failed/);
    });
});
