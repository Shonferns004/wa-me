"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SESSION_WATCHDOG_MAX_FAILURES = exports.SESSION_WATCHDOG_PROBE_TIMEOUT_MS = exports.SESSION_WATCHDOG_INTERVAL_MS = exports.SessionLivenessWatchdog = void 0;
const common_1 = require("@nestjs/common");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const logger_service_1 = require("../../common/services/logger.service");
const shutdown_service_1 = require("../../common/services/shutdown.service");
/**
 * Session liveness watchdog. The engine layer is event-driven, so an engine that dies WITHOUT
 * emitting a disconnect (a killed Chromium, a silently wedged socket) would otherwise sit READY
 * forever. This actively probes every live engine on an interval and, after repeated failures,
 * hands the session to the caller's disconnect path.
 *
 * Split out of SessionService because it is a self-contained supervisor: one timer, one failure
 * counter, and exactly one outward effect (`onDead`). Keeping it separate means the probe timeout,
 * the failure threshold, and the observe-only ACTION_REQUIRED rules are testable with a fake clock
 * instead of a live engine.
 */
let SessionLivenessWatchdog = class SessionLivenessWatchdog {
    engines;
    shutdownService;
    logger = (0, logger_service_1.createLogger)('SessionLivenessWatchdog');
    /** Consecutive failed liveness probes per session id. Cleared on recovery or on a status change. */
    failures = new Map();
    timer = null;
    /** Invoked when a session has failed enough consecutive probes to be treated as disconnected. */
    onDead = () => Promise.resolve();
    constructor(engines, shutdownService) {
        this.engines = engines;
        this.shutdownService = shutdownService;
    }
    /**
     * Start the watchdog (idempotent). One unref'd interval probes every registered engine.
     *
     * @param onDead Called after MAX_FAILURES consecutive failures, to treat the session exactly like
     *   an engine-reported disconnect.
     */
    start(onDead, intervalMs = exports.SESSION_WATCHDOG_INTERVAL_MS) {
        this.onDead = onDead;
        if (this.timer)
            return;
        this.timer = setInterval(() => {
            // allSettled inside the tick keeps a failing session from ever throwing into the timer.
            void this.tick();
        }, intervalMs);
        // The watchdog must never keep the process alive on its own.
        this.timer.unref();
    }
    /** Stop the watchdog and forget all accrued failures. */
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.failures.clear();
    }
    /** Forget a session's accrued failures (e.g. it just reported ready). */
    clear(id) {
        this.failures.delete(id);
    }
    /** Probe all live engines in parallel; a slow/failed probe must not delay or abort the others. */
    async tick() {
        // Mid-shutdown the disconnect path would schedule a reconnect racing onModuleDestroy's teardown
        // (same guard as scheduleReconnect) — leave the sessions to the drain instead.
        if (this.shutdownService?.isShuttingDown()) {
            return;
        }
        await Promise.allSettled([...this.engines].map(([id, engine]) => this.probe(id, engine)));
    }
    /**
     * Actively probe one engine. Only READY sessions are expected to answer (anything else is owned by
     * the QR/reconnect flows); engines without `probeLiveness` keep relying on engine events alone.
     * MAX_FAILURES consecutive failures treat the session exactly like an engine-reported disconnect.
     *
     * ACTION_REQUIRED is probed too, but OBSERVE-ONLY: the engine is still running and a human has to
     * act, and clearing that status is theirs to do (stop, then start). Acting on a failed probe would
     * hand the session to the reconnect path and silently drop the very status that asked for
     * attention — so the probe result only reaches the log. Without probing at all, a page that dies
     * while waiting for the operator left no trace anywhere, which is what this closes.
     */
    async probe(id, engine) {
        const status = engine.getStatus();
        const observeOnly = status === whatsapp_engine_interface_1.EngineStatus.ACTION_REQUIRED;
        if (status !== whatsapp_engine_interface_1.EngineStatus.READY && !observeOnly) {
            // Not expected to answer right now — and any accrued failures belong to a previous READY
            // stretch, so the next one starts clean. This also self-cleans the observe-only counter below:
            // every path out of ACTION_REQUIRED passes through a status that lands here (or through
            // onReady, which clears it), so an observe-only count can never be inherited by a READY
            // stretch and push it over MAX_FAILURES early.
            this.failures.delete(id);
            return;
        }
        // Feature-detect: an engine whose transport already self-detects death may skip the probe.
        if (typeof engine.probeLiveness !== 'function') {
            return;
        }
        // A wedged connection can hang the probe itself, so race it against a timeout; a timeout or a
        // probe error both count as "not proven alive".
        let alive;
        let probeTimer;
        try {
            alive = await Promise.race([
                engine.probeLiveness(),
                new Promise((_, reject) => {
                    probeTimer = setTimeout(() => reject(new Error('liveness probe timed out')), exports.SESSION_WATCHDOG_PROBE_TIMEOUT_MS);
                }),
            ]);
        }
        catch {
            alive = false;
        }
        finally {
            if (probeTimer)
                clearTimeout(probeTimer);
        }
        // The session may have been stopped/restarted (engine superseded) while the probe was in flight;
        // a stale result must not touch it (mirrors the isLive gate on engine callbacks).
        if (!this.engines.isLive(id, engine)) {
            return;
        }
        // The engine left the state this probe was taken in (a reconnect of its own, or a step only an
        // operator can take): the result says nothing about it now, and a failure must not recycle it.
        if (engine.getStatus() !== status) {
            this.failures.delete(id);
            return;
        }
        if (alive) {
            // Note a recovery on the observe-only path, so the log shows the page came back rather than
            // leaving the earlier warning as the last word.
            if (observeOnly && this.failures.has(id)) {
                this.logger.log('Liveness probe answering again while the session awaits operator action', {
                    sessionId: id,
                    action: 'watchdog_probe_recovered',
                });
            }
            this.failures.delete(id);
            return;
        }
        const failures = (this.failures.get(id) ?? 0) + 1;
        if (observeOnly) {
            this.failures.set(id, failures);
            // One warning per unresponsive stretch, not one per tick: a session can sit in
            // ACTION_REQUIRED until a human gets to it, and at a 60s interval an unbounded log would bury
            // everything else. The count keeps rising so the recovery branch above can tell it happened.
            if (failures === 1) {
                this.logger.warn('Liveness probe failed while the session awaits operator action; not reconnecting it — ' +
                    'the status is operator-owned. If the page is gone, stop and start the session.', { sessionId: id, action: 'watchdog_probe_failed_observe_only' });
            }
            return;
        }
        if (failures < exports.SESSION_WATCHDOG_MAX_FAILURES) {
            this.failures.set(id, failures);
            this.logger.warn('Liveness probe failed; will treat the session as dead after repeated failures', {
                sessionId: id,
                failures,
                action: 'watchdog_probe_failed',
            });
            return;
        }
        this.failures.delete(id);
        this.logger.warn('Liveness probe failed repeatedly; handling the session as disconnected', {
            sessionId: id,
            failures,
            action: 'watchdog_disconnect',
        });
        await this.onDead(id, engine, 'liveness probe failed (watchdog)');
    }
};
exports.SessionLivenessWatchdog = SessionLivenessWatchdog;
exports.SessionLivenessWatchdog = SessionLivenessWatchdog = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [engine_registry_service_1.EngineRegistry,
        shutdown_service_1.ShutdownService])
], SessionLivenessWatchdog);
/**
 * Session liveness watchdog cadence. The engine layer is event-driven, so an engine that dies
 * WITHOUT emitting a disconnect would otherwise sit READY forever.
 */
exports.SESSION_WATCHDOG_INTERVAL_MS = 60_000;
/** A wedged connection can hang the probe itself, so each probe is raced against this deadline. */
exports.SESSION_WATCHDOG_PROBE_TIMEOUT_MS = 15_000;
/** Consecutive failed probes before a session is treated as disconnected. */
exports.SESSION_WATCHDOG_MAX_FAILURES = 2;
