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
exports.ShutdownService = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const logger_service_1 = require("./logger.service");
const shutdown_budget_1 = require("./shutdown-budget");
// The delay counts 1:1 against the kill deadline; see shutdown-budget.ts.
const MAX_SHUTDOWN_DELAY_MS = 30_000;
let ShutdownService = class ShutdownService {
    config;
    logger = (0, logger_service_1.createLogger)('ShutdownService');
    destroyCallback = null;
    shutdownListeners = [];
    shuttingDown = false;
    shutdownScheduled = false;
    tearingDown = false;
    constructor(config) {
        this.config = config;
    }
    /**
     * Set the shutdown callback (called from main.ts after app creation)
     */
    setShutdownCallback(callback) {
        this.destroyCallback = callback;
    }
    /**
     * Run `listener` when shutdown begins, before the grace and every destroy hook. It runs inside the
     * signal handler, so it must not throw or block.
     */
    onShutdown(listener) {
        this.shutdownListeners.push(listener);
    }
    /**
     * True once shutdown has begun. The readiness probe reports 503 while draining so the
     * load balancer / orchestrator stops routing NEW traffic before teardown.
     */
    isShuttingDown() {
        return this.shuttingDown;
    }
    /**
     * True once the grace has elapsed and teardown has started. Nest keeps the HTTP listener open
     * until every destroy hook has finished, so the request gate in configure-app.ts refuses new
     * requests from this point on.
     */
    isTearingDown() {
        return this.tearingDown;
    }
    /** Flip the draining flag (idempotent). Safe to call synchronously from a signal handler. */
    markShuttingDown() {
        if (!this.shuttingDown) {
            this.shuttingDown = true;
            this.logger.log('Entering draining state — readiness now reports 503');
            for (const listener of this.shutdownListeners)
                listener();
        }
    }
    /**
     * Trigger graceful shutdown after a bounded grace window. Readiness flips to 503 first
     * (drain), then after the delay the teardown callback runs and the process exits.
     */
    shutdown(delayMs) {
        this.markShuttingDown();
        // Idempotent: a repeated signal (double Ctrl+C, or a SIGTERM overlapping an admin restart) must not
        // schedule a second grace timer / second app.close() / second process.exit. The first call wins.
        if (this.shutdownScheduled)
            return;
        this.shutdownScheduled = true;
        const delay = Math.min(delayMs ?? this.resolveDelay(), MAX_SHUTDOWN_DELAY_MS);
        this.logger.log('Graceful shutdown requested', { delayMs: delay });
        setTimeout(() => {
            this.logger.log('Initiating shutdown...');
            this.tearingDown = true;
            // The only bound on the waits that have none of their own (the database waits, queue and pool
            // close), and the only one on the admin-restart path, where no orchestrator kill follows. Armed
            // here, after the grace, so a raised SHUTDOWN_DELAY_MS moves it with the kill deadline; see
            // shutdown-budget.ts. Not unref'd: a teardown parked on a promise that holds no handle would let
            // the loop drain and the process exit 0 with the remaining hooks never run.
            const budgetMs = (0, shutdown_budget_1.shutdownTeardownLimitMs)(this.config?.get('webhook.shutdownDrainMs') ?? shutdown_budget_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
            const forceExit = setTimeout(() => {
                this.logger.error('Shutdown teardown exceeded its budget, forcing exit', undefined, { budgetMs });
                process.exit(1);
            }, budgetMs);
            const doShutdown = async () => {
                // The exit status mirrors the teardown outcome: 0 when teardown completed, 1 when it
                // failed, so an orchestrator (k8s, systemd, docker restart policies) must not read a
                // resource-leaking shutdown as a clean one. A teardown that hangs is cut by the force-exit
                // timer above, or by a repeat stop signal 1 s or more after the first (stop-signals.ts; a
                // repeat inside that window is the same signal delivered twice and is ignored).
                let exitCode = 0;
                try {
                    if (this.destroyCallback) {
                        await this.destroyCallback();
                    }
                }
                catch (error) {
                    exitCode = 1;
                    this.logger.error('Shutdown teardown failed — exiting non-zero', error instanceof Error ? error.message : String(error));
                }
                finally {
                    clearTimeout(forceExit);
                    process.exit(exitCode);
                }
            };
            void doShutdown();
        }, delay);
    }
    /**
     * Bounded, configurable grace (SHUTDOWN_DELAY_MS), capped at 30s. An explicit value always wins.
     * When unset, the default is the full 3s drain window (so a load balancer observes the 503 before
     * teardown) for EVERY real deployment — even an ad-hoc run that never sets NODE_ENV. Only an
     * explicit `development`/`test` skips the window (delay 0), so a `nest start --watch` hot reload
     * or a dev Ctrl+C is not slowed by a grace it does not need.
     */
    resolveDelay() {
        const parsed = Number.parseInt(process.env.SHUTDOWN_DELAY_MS ?? '', 10);
        if (Number.isInteger(parsed) && parsed >= 0)
            return parsed;
        const env = process.env.NODE_ENV;
        return env === 'development' || env === 'test' ? 0 : shutdown_budget_1.DEFAULT_SHUTDOWN_DELAY_MS;
    }
};
exports.ShutdownService = ShutdownService;
exports.ShutdownService = ShutdownService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [config_1.ConfigService])
], ShutdownService);
