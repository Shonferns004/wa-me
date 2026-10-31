"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_liveness_watchdog_service_1 = require("./session-liveness-watchdog.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const engineOf = (status, probe) => ({
    getStatus: jest.fn().mockReturnValue(status),
    ...(probe ? { probeLiveness: probe } : {}),
});
describe('SessionLivenessWatchdog', () => {
    let engines;
    let onDead;
    let watchdog;
    const failuresOf = (w) => w.failures;
    beforeEach(() => {
        engines = new engine_registry_service_1.EngineRegistry();
        onDead = jest.fn().mockResolvedValue(undefined);
        watchdog = new session_liveness_watchdog_service_1.SessionLivenessWatchdog(engines);
    });
    afterEach(() => {
        watchdog.stop();
    });
    describe('probe eligibility', () => {
        it('treats a READY engine that answers as alive', async () => {
            const probe = jest.fn().mockResolvedValue(true);
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, probe);
            engines.set('s1', engine);
            watchdog.start(onDead);
            await watchdog.probe('s1', engine);
            expect(probe).toHaveBeenCalled();
            expect(onDead).not.toHaveBeenCalled();
        });
        it('skips a non-READY engine entirely (owned by the QR/reconnect flows)', async () => {
            const probe = jest.fn().mockResolvedValue(false);
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.INITIALIZING, probe);
            engines.set('s1', engine);
            await watchdog.probe('s1', engine);
            expect(probe).not.toHaveBeenCalled();
        });
        it('clears failures accrued in a previous READY stretch when the status leaves READY', async () => {
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(false));
            engines.set('s1', engine);
            await watchdog.probe('s1', engine);
            expect(failuresOf(watchdog).get('s1')).toBe(1);
            engine.getStatus.mockReturnValue(whatsapp_engine_interface_1.EngineStatus.DISCONNECTED);
            await watchdog.probe('s1', engine);
            expect(failuresOf(watchdog).has('s1')).toBe(false);
        });
        it('skips an engine without probeLiveness (relies on engine events alone)', async () => {
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY);
            engines.set('s1', engine);
            watchdog.start(onDead);
            await watchdog.probe('s1', engine);
            expect(onDead).not.toHaveBeenCalled();
            expect(failuresOf(watchdog).has('s1')).toBe(false);
        });
    });
    describe('failure threshold', () => {
        it(`treats the session as dead after ${session_liveness_watchdog_service_1.SESSION_WATCHDOG_MAX_FAILURES} consecutive failures`, async () => {
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(false));
            engines.set('s1', engine);
            watchdog.start(onDead);
            for (let i = 0; i < session_liveness_watchdog_service_1.SESSION_WATCHDOG_MAX_FAILURES; i++) {
                await watchdog.probe('s1', engine);
            }
            expect(onDead).toHaveBeenCalledTimes(1);
            expect(onDead).toHaveBeenCalledWith('s1', engine, 'liveness probe failed (watchdog)');
        });
        it('does not act on a single failure', async () => {
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(false));
            engines.set('s1', engine);
            watchdog.start(onDead);
            await watchdog.probe('s1', engine);
            expect(onDead).not.toHaveBeenCalled();
            expect(failuresOf(watchdog).get('s1')).toBe(1);
        });
        it('resets the streak on a successful probe, so failures must be CONSECUTIVE', async () => {
            const probe = jest.fn().mockResolvedValue(false);
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, probe);
            engines.set('s1', engine);
            watchdog.start(onDead);
            await watchdog.probe('s1', engine);
            probe.mockResolvedValue(true);
            await watchdog.probe('s1', engine);
            probe.mockResolvedValue(false);
            await watchdog.probe('s1', engine);
            expect(onDead).not.toHaveBeenCalled();
        });
        it('counts a probe that rejects as a failure', async () => {
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockRejectedValue(new Error('socket gone')));
            engines.set('s1', engine);
            watchdog.start(onDead);
            await watchdog.probe('s1', engine);
            expect(failuresOf(watchdog).get('s1')).toBe(1);
        });
        it('counts a hung probe as a failure once the deadline passes', async () => {
            jest.useFakeTimers();
            try {
                // A wedged connection can hang the probe itself; without the race the tick would stall.
                const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockReturnValue(new Promise(() => { })));
                engines.set('s1', engine);
                watchdog.start(onDead);
                const pending = watchdog.probe('s1', engine);
                await jest.advanceTimersByTimeAsync(session_liveness_watchdog_service_1.SESSION_WATCHDOG_PROBE_TIMEOUT_MS);
                await pending;
                expect(failuresOf(watchdog).get('s1')).toBe(1);
            }
            finally {
                jest.useRealTimers();
            }
        });
    });
    describe('ACTION_REQUIRED is observe-only', () => {
        it('probes the engine but never acts on a failure (the status is operator-owned)', async () => {
            const probe = jest.fn().mockResolvedValue(false);
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.ACTION_REQUIRED, probe);
            engines.set('s1', engine);
            watchdog.start(onDead);
            for (let i = 0; i < session_liveness_watchdog_service_1.SESSION_WATCHDOG_MAX_FAILURES + 3; i++) {
                await watchdog.probe('s1', engine);
            }
            expect(probe).toHaveBeenCalled();
            // Acting here would silently drop the very status asking for attention.
            expect(onDead).not.toHaveBeenCalled();
            expect(failuresOf(watchdog).get('s1')).toBeGreaterThan(session_liveness_watchdog_service_1.SESSION_WATCHDOG_MAX_FAILURES);
        });
        it('clears the observe-only count when the probe answers again', async () => {
            const probe = jest.fn().mockResolvedValue(false);
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.ACTION_REQUIRED, probe);
            engines.set('s1', engine);
            watchdog.start(onDead);
            await watchdog.probe('s1', engine);
            probe.mockResolvedValue(true);
            await watchdog.probe('s1', engine);
            expect(failuresOf(watchdog).has('s1')).toBe(false);
        });
    });
    describe('stale results', () => {
        it.each([whatsapp_engine_interface_1.EngineStatus.ACTION_REQUIRED, whatsapp_engine_interface_1.EngineStatus.DISCONNECTED])('drops a pending READY result when status changes to %s', async (status) => {
            let settle = () => undefined;
            const probe = jest
                .fn()
                .mockResolvedValueOnce(false)
                .mockImplementationOnce(() => new Promise(resolve => {
                settle = resolve;
            }));
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, probe);
            engines.set('s1', engine);
            watchdog.start(onDead);
            await watchdog.probe('s1', engine);
            const pending = watchdog.probe('s1', engine);
            engine.getStatus.mockReturnValue(status);
            settle(false);
            await pending;
            expect(onDead).not.toHaveBeenCalled();
            expect(failuresOf(watchdog).has('s1')).toBe(false);
            engine.getStatus.mockReturnValue(whatsapp_engine_interface_1.EngineStatus.READY);
            probe.mockResolvedValue(false);
            await watchdog.probe('s1', engine);
            expect(onDead).not.toHaveBeenCalled();
            expect(failuresOf(watchdog).get('s1')).toBe(1);
        });
        it('drops a timed-out READY probe after operator action becomes necessary', async () => {
            jest.useFakeTimers();
            try {
                const probe = jest
                    .fn()
                    .mockResolvedValueOnce(false)
                    .mockImplementationOnce(() => new Promise(() => undefined));
                const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, probe);
                engines.set('s1', engine);
                watchdog.start(onDead);
                await watchdog.probe('s1', engine);
                const pending = watchdog.probe('s1', engine);
                engine.getStatus.mockReturnValue(whatsapp_engine_interface_1.EngineStatus.ACTION_REQUIRED);
                await jest.advanceTimersByTimeAsync(session_liveness_watchdog_service_1.SESSION_WATCHDOG_PROBE_TIMEOUT_MS);
                await pending;
                expect(onDead).not.toHaveBeenCalled();
                expect(failuresOf(watchdog).has('s1')).toBe(false);
            }
            finally {
                jest.useRealTimers();
            }
        });
        it('ignores a probe result for an engine superseded while it was in flight', async () => {
            const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(false));
            engines.set('s1', engine);
            watchdog.start(onDead);
            failuresOf(watchdog).set('s1', session_liveness_watchdog_service_1.SESSION_WATCHDOG_MAX_FAILURES - 1);
            // A stop()/restart replaces the engine before the probe settles.
            engines.set('s1', engineOf(whatsapp_engine_interface_1.EngineStatus.READY));
            await watchdog.probe('s1', engine);
            expect(onDead).not.toHaveBeenCalled();
        });
    });
    describe('lifecycle', () => {
        it('probes every live engine on each tick', async () => {
            jest.useFakeTimers();
            try {
                const a = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(true));
                const b = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(true));
                engines.set('a', a);
                engines.set('b', b);
                watchdog.start(onDead);
                await jest.advanceTimersByTimeAsync(session_liveness_watchdog_service_1.SESSION_WATCHDOG_INTERVAL_MS);
                expect(a.probeLiveness).toHaveBeenCalled();
                expect(b.probeLiveness).toHaveBeenCalled();
            }
            finally {
                jest.useRealTimers();
            }
        });
        it('is idempotent: a second start does not add a second interval', () => {
            jest.useFakeTimers();
            try {
                watchdog.start(onDead);
                watchdog.start(onDead);
                expect(jest.getTimerCount()).toBe(1);
            }
            finally {
                watchdog.stop();
                jest.useRealTimers();
            }
        });
        it('stop() clears the interval and the accrued failures, and is safe to call twice', () => {
            jest.useFakeTimers();
            try {
                watchdog.start(onDead);
                failuresOf(watchdog).set('s1', 1);
                watchdog.stop();
                watchdog.stop();
                expect(jest.getTimerCount()).toBe(0);
                expect(failuresOf(watchdog).size).toBe(0);
            }
            finally {
                jest.useRealTimers();
            }
        });
        it('skips the whole tick while shutting down (a reconnect would race teardown)', async () => {
            jest.useFakeTimers();
            const shutdown = { isShuttingDown: () => true };
            const draining = new session_liveness_watchdog_service_1.SessionLivenessWatchdog(engines, shutdown);
            try {
                const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(false));
                engines.set('s1', engine);
                draining.start(onDead);
                await jest.advanceTimersByTimeAsync(session_liveness_watchdog_service_1.SESSION_WATCHDOG_INTERVAL_MS);
                expect(engine.probeLiveness).not.toHaveBeenCalled();
            }
            finally {
                draining.stop();
                jest.useRealTimers();
            }
        });
        it('clear() forgets one session without disturbing another', () => {
            failuresOf(watchdog).set('s1', 1);
            failuresOf(watchdog).set('s2', 1);
            watchdog.clear('s1');
            expect(failuresOf(watchdog).has('s1')).toBe(false);
            expect(failuresOf(watchdog).get('s2')).toBe(1);
        });
        it('a failing probe never throws into the timer', async () => {
            jest.useFakeTimers();
            try {
                const engine = engineOf(whatsapp_engine_interface_1.EngineStatus.READY, jest.fn().mockResolvedValue(false));
                engines.set('s1', engine);
                watchdog.start(() => Promise.reject(new Error('disconnect handler blew up')));
                await expect(jest.advanceTimersByTimeAsync(session_liveness_watchdog_service_1.SESSION_WATCHDOG_INTERVAL_MS * (session_liveness_watchdog_service_1.SESSION_WATCHDOG_MAX_FAILURES + 1))).resolves.not.toThrow();
            }
            finally {
                jest.useRealTimers();
            }
        });
    });
});
