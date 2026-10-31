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
exports.SessionTakeoverService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const logger_service_1 = require("../../common/services/logger.service");
const feature_flags_1 = require("../../config/feature-flags");
const session_entity_1 = require("../session/entities/session.entity");
const session_ownership_service_1 = require("../session/session-ownership.service");
const shutdown_service_1 = require("../../common/services/shutdown.service");
const session_service_1 = require("../session/session.service");
const session_engine_controls_1 = require("../session/session-engine-controls");
const session_engine_lifecycle_service_1 = require("../session/session-engine-lifecycle.service");
/**
 * Statuses worth adopting from a lapsed node. They all mean "an engine was (or should be) running".
 * QR_READY is deliberately absent — an unpaired session on a dead node has nothing to resume, and
 * restarting it elsewhere just renders a QR nobody asked for. FAILED is deliberately absent too:
 * it marks a session an operator must look at, and silently relocating it would hide that.
 *
 * DISCONNECTED is present, so the status correction must never write it over a row this sweep would
 * otherwise leave alone: markLapsedDisconnected corrects READY, INITIALIZING, AUTHENTICATING and
 * ACTION_REQUIRED, which are adopted either way, and QR_READY only on a row with no phone, which
 * isEligible refuses either way.
 */
const TAKEOVER_STATUSES = new Set([
    session_entity_1.SessionStatus.READY,
    session_entity_1.SessionStatus.INITIALIZING,
    session_entity_1.SessionStatus.AUTHENTICATING,
    session_entity_1.SessionStatus.ACTION_REQUIRED,
    session_entity_1.SessionStatus.DISCONNECTED,
]);
/** Pause between successive engine launches, matching the boot auto-start's Chromium stagger. */
const TAKEOVER_START_STAGGER_MS = 2000;
/**
 * How many lease TTLs past its expiry a lease must be before the status correction treats its holder
 * as "really gone".
 *
 * Two, not one. A lease lapses while its holder is perfectly healthy whenever a query runs long, and
 * the next heartbeat re-extends it; correcting a status on a single lapse would report a live peer's
 * sessions as disconnected, and nothing would put that right, because the peer's own renewal still
 * finds its nodeId and detects no loss. A lease expires one TTL after the holder's last renewal, so a
 * row is corrected more than three TTLs after that renewal, plus up to one sweep interval.
 *
 * Adoption does not wait for this and acts on the first lapse. It goes through claim(), which takes a
 * lapsed lease outright: a holder that was only slow loses the session and tears its engine down at
 * its next heartbeat.
 */
const STRANDED_LEASE_TTL_MULTIPLE = 2;
/**
 * Adopts sessions whose holder's lease has lapsed.
 *
 * Boot auto-start runs exactly once, so it misses two real cases, both observed live: a peer that
 * crashes AFTER this node booted, and a container recreate whose new boot lands BEFORE the old
 * identity's lease expires (the claim is correctly refused, and nothing ever retried — the session
 * sat disconnected until someone called POST /start). This sweep is the retry: every tick it looks
 * for lapsed-lease sessions and starts them here through the ordinary start path, so the claim
 * stays race-safe against peers doing the same.
 *
 * The lapsed holder's unfinished bulk batches are failed after the claim, by the adoption handler
 * BulkMessageService registers with SessionOwnershipService, the same as for an explicit POST
 * /start, so the sweep only starts sessions.
 */
let SessionTakeoverService = class SessionTakeoverService {
    sessionService;
    ownership;
    configService;
    shutdownService;
    logger = (0, logger_service_1.createLogger)('SessionTakeoverService');
    sweepTimer;
    sweepInFlight = false;
    /**
     * Set by onModuleDestroy. Clearing the interval stops the NEXT sweep; it does nothing about one
     * already running, which is neither aborted nor awaited. Without this signal a sweep mid-flight
     * during a rolling restart could construct and register an engine after the shutdown path had
     * already emptied the registry — nothing would tear it down — and claim the ownership lease for a
     * process about to exit, pinning the session to a dead node until the lease lapsed.
     */
    shuttingDown = false;
    constructor(sessionService, ownership, configService, shutdownService) {
        this.sessionService = sessionService;
        this.ownership = ownership;
        this.configService = configService;
        this.shutdownService = shutdownService;
    }
    /** True once EITHER the drain has begun or Nest has torn this module down. */
    get stopping() {
        return this.shuttingDown || this.shutdownService?.isShuttingDown() === true;
    }
    onApplicationBootstrap() {
        // Deliberately NOT gated on auto-start any more. The sweep now has a second job that starts
        // nothing: correcting a status whose owner is gone. Nothing else revisits one, because the boot
        // reset skips a foreign claim that is still live and after a container recreate the previous
        // hostname IS foreign, so with auto-start off the row went on reporting a running engine no
        // process holds. The adopt loop below is still behind the flag: an operator who disabled
        // auto-start asked for no spontaneous engine starts, not for a dashboard that lies.
        const sweepMs = this.configService?.get('session.takeoverSweepMs', 30_000) ?? 30_000;
        this.sweepTimer = setInterval(() => {
            // At most one sweep at a time: a slow start (Chromium launch) must not stack a second sweep
            // on top of the first — the claim would refuse, but the log noise and DB churn are pointless.
            if (this.sweepInFlight)
                return;
            this.sweepInFlight = true;
            void this.sweep()
                .catch(error => this.logger.warn('Takeover sweep failed', {
                error: error instanceof Error ? error.message : String(error),
            }))
                .finally(() => {
                this.sweepInFlight = false;
            });
        }, sweepMs);
        this.sweepTimer.unref?.();
    }
    onModuleDestroy() {
        this.shuttingDown = true;
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
    }
    /**
     * One pass: correct every stale status a vanished node left behind, then, when AUTO_START_SESSIONS
     * is on, adopt every eligible lapsed session. Runs on every node whatever that flag says, and a
     * failed correction is logged without costing the pass its adoptions. Exposed for the spec; the
     * timer drives it.
     */
    async sweep() {
        if (this.stopping)
            return;
        const lapsed = await this.ownership.lapsedHeldByOthers();
        // Correct the stale statuses BEFORE adopting: a row this pass goes on to start gets its
        // INITIALIZING written by start() afterwards, so the correction can never land on a live engine.
        // Idempotent, because DISCONNECTED is not one of the statuses it acts on. A failure leaves no
        // write pending, so the adopt loop still runs; the next pass retries the correction.
        const goneBefore = new Date(Date.now() - this.ownership.leaseTtlMs * STRANDED_LEASE_TTL_MULTIPLE);
        try {
            await this.sessionService.markLapsedDisconnected(lapsed, goneBefore);
        }
        catch (error) {
            this.logger.warn('Lapsed session status correction failed', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        if (!(0, feature_flags_1.resolveFeatureFlags)(this.configService).autoStartSessions)
            return;
        const eligible = lapsed.filter(session => this.isEligible(session));
        if (eligible.length === 0)
            return;
        for (let i = 0; i < eligible.length; i++) {
            const session = eligible[i];
            // Re-checked per iteration, not just at entry: each adoption costs a browser launch plus a
            // stagger, so the loop spans a large part of the sweep interval and shutdown can begin partway
            // through. Everything already adopted is left to the normal teardown; nothing further starts.
            if (this.stopping)
                return;
            // start() refuses at the cap without touching the lease, so stopping here only saves a refused
            // launch per remaining row; the lease stays where a peer with room adopts it.
            if (!this.hasStartCapacity()) {
                this.logger.debug('Takeover paused: this node is at MAX_CONCURRENT_SESSIONS', {
                    pending: eligible.length - i,
                });
                return;
            }
            try {
                await this.sessionService.start(session.id);
                this.logger.log(`Adopted session ${session.name} from lapsed node ${session.nodeId ?? '?'}`, {
                    sessionId: session.id,
                    fromNode: session.nodeId,
                    action: 'session_takeover',
                });
            }
            catch (error) {
                if (error instanceof session_engine_controls_1.SessionStoppedException) {
                    // Stopped between the sweep's read and this start; the start refused it, as it should.
                    this.logger.debug(`Session ${session.name} skipped: stopped by an operator`, { sessionId: session.id });
                }
                else if (error instanceof session_engine_controls_1.ServerShuttingDownException) {
                    // Shutdown began while this start was in flight; the session is left for a peer or the next boot.
                    this.logger.debug(`Takeover of session ${session.name} abandoned: shutting down`, { sessionId: session.id });
                    return;
                }
                else if (error instanceof common_1.ConflictException) {
                    // A peer won the race — exactly the claim doing its job.
                    this.logger.debug(`Session ${session.name} was adopted by another node first`, { sessionId: session.id });
                }
                else {
                    this.logger.warn(`Takeover start failed for session ${session.name}`, {
                        sessionId: session.id,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            if (i < eligible.length - 1) {
                await new Promise(resolve => setTimeout(resolve, TAKEOVER_START_STAGGER_MS));
            }
        }
    }
    /** The same count the start path's MAX_CONCURRENT_SESSIONS check uses. */
    hasStartCapacity() {
        const max = (0, session_engine_lifecycle_service_1.resolveMaxConcurrentSessions)(this.configService);
        return max === null || this.sessionService.hasStartCapacity(max);
    }
    isEligible(session) {
        // Only authenticated sessions (phone set): an engine is worth relaunching exactly when the
        // saved credentials can restore the link without a human scanning anything. A session an
        // operator stopped, or whose delete failed part-way, stays down until an explicit start, wherever
        // its claim lapsed.
        return Boolean(session.phone) && TAKEOVER_STATUSES.has(session.status) && !session.desiredState;
    }
};
exports.SessionTakeoverService = SessionTakeoverService;
exports.SessionTakeoverService = SessionTakeoverService = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Optional)()),
    __param(3, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [session_service_1.SessionService,
        session_ownership_service_1.SessionOwnershipService,
        config_1.ConfigService,
        shutdown_service_1.ShutdownService])
], SessionTakeoverService);
