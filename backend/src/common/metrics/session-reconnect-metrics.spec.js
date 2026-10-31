"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_reconnect_metrics_1 = require("./session-reconnect-metrics");
describe('session-reconnect-metrics', () => {
    it('monotonically increments the reconnect-attempts total', () => {
        const before = (0, session_reconnect_metrics_1.getSessionReconnectAttemptsTotal)();
        (0, session_reconnect_metrics_1.incrementSessionReconnectAttempts)();
        (0, session_reconnect_metrics_1.incrementSessionReconnectAttempts)();
        expect((0, session_reconnect_metrics_1.getSessionReconnectAttemptsTotal)()).toBe(before + 2);
    });
    it('reconnect-attempts total never decreases', () => {
        const a = (0, session_reconnect_metrics_1.getSessionReconnectAttemptsTotal)();
        (0, session_reconnect_metrics_1.incrementSessionReconnectAttempts)();
        const b = (0, session_reconnect_metrics_1.getSessionReconnectAttemptsTotal)();
        expect(b).toBeGreaterThan(a);
    });
    it('monotonically increments the loop-alerts total', () => {
        const before = (0, session_reconnect_metrics_1.getSessionReconnectLoopAlertsTotal)();
        (0, session_reconnect_metrics_1.incrementSessionReconnectLoopAlerts)();
        (0, session_reconnect_metrics_1.incrementSessionReconnectLoopAlerts)();
        expect((0, session_reconnect_metrics_1.getSessionReconnectLoopAlertsTotal)()).toBe(before + 2);
    });
    it('loop-alerts total never decreases', () => {
        const a = (0, session_reconnect_metrics_1.getSessionReconnectLoopAlertsTotal)();
        (0, session_reconnect_metrics_1.incrementSessionReconnectLoopAlerts)();
        const b = (0, session_reconnect_metrics_1.getSessionReconnectLoopAlertsTotal)();
        expect(b).toBeGreaterThan(a);
    });
    it('tracks attempts and alerts independently', () => {
        const attemptsBefore = (0, session_reconnect_metrics_1.getSessionReconnectAttemptsTotal)();
        const alertsBefore = (0, session_reconnect_metrics_1.getSessionReconnectLoopAlertsTotal)();
        (0, session_reconnect_metrics_1.incrementSessionReconnectAttempts)();
        expect((0, session_reconnect_metrics_1.getSessionReconnectLoopAlertsTotal)()).toBe(alertsBefore);
        (0, session_reconnect_metrics_1.incrementSessionReconnectLoopAlerts)();
        expect((0, session_reconnect_metrics_1.getSessionReconnectAttemptsTotal)()).toBe(attemptsBefore + 1);
    });
});
