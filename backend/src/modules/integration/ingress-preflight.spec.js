"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const ingress_preflight_1 = require("./ingress-preflight");
function route(response) {
    return {
        route: 'r',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 1024,
        signature: { scheme: 'none' },
        response,
    };
}
describe('evaluatePreflight', () => {
    it('passes (null) when no preflight is declared', () => {
        expect((0, ingress_preflight_1.evaluatePreflight)(route(), 'sess-1', () => whatsapp_engine_interface_1.EngineStatus.READY)).toBeNull();
    });
    it('passes when the concrete session is READY', () => {
        expect((0, ingress_preflight_1.evaluatePreflight)(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => whatsapp_engine_interface_1.EngineStatus.READY)).toBeNull();
    });
    it('passes (accept-and-defer) for a recoverable status', () => {
        for (const s of [
            whatsapp_engine_interface_1.EngineStatus.INITIALIZING,
            whatsapp_engine_interface_1.EngineStatus.QR_READY,
            whatsapp_engine_interface_1.EngineStatus.AUTHENTICATING,
            whatsapp_engine_interface_1.EngineStatus.DISCONNECTED,
        ]) {
            expect((0, ingress_preflight_1.evaluatePreflight)(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => s)).toBeNull();
        }
    });
    it('rejects with 503 when the concrete session is FAILED', () => {
        expect((0, ingress_preflight_1.evaluatePreflight)(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => whatsapp_engine_interface_1.EngineStatus.FAILED)).toEqual({
            status: 503,
            body: 'session not ready',
            headers: { 'Retry-After': '5' },
        });
    });
    it('rejects with 503 when there is no live engine (stopped/deleted)', () => {
        expect((0, ingress_preflight_1.evaluatePreflight)(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', () => undefined)).toEqual({
            status: 503,
            body: 'session not ready',
            headers: { 'Retry-After': '5' },
        });
    });
    it('skips (passes) for a wildcard scope — no single session to probe', () => {
        expect((0, ingress_preflight_1.evaluatePreflight)(route({ preflight: [{ type: 'session-alive' }] }), '*', () => whatsapp_engine_interface_1.EngineStatus.FAILED)).toBeNull();
        expect((0, ingress_preflight_1.evaluatePreflight)(route({ preflight: [{ type: 'session-alive' }] }), null, () => whatsapp_engine_interface_1.EngineStatus.FAILED)).toBeNull();
    });
    it('skips (passes) when sessionStatus is unwired — pure tests must not false-reject', () => {
        expect((0, ingress_preflight_1.evaluatePreflight)(route({ preflight: [{ type: 'session-alive' }] }), 'sess-1', undefined)).toBeNull();
    });
});
