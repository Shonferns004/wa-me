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
exports.WebhookReconcilerService = void 0;
exports.resolveWebhookReconcilerOptions = resolveWebhookReconcilerOptions;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const webhook_entity_1 = require("./entities/webhook.entity");
const webhook_outbox_service_1 = require("./webhook-outbox.service");
const webhook_delivery_service_1 = require("./webhook-delivery.service");
const deliver_once_1 = require("./utils/deliver-once");
const logger_service_1 = require("../../common/services/logger.service");
const configuration_1 = require("../../config/configuration");
function resolveWebhookReconcilerOptions(env = process.env) {
    const batch = Number(env.WEBHOOK_RECONCILE_BATCH_SIZE);
    const maxAttempts = Number(env.WEBHOOK_RECONCILE_MAX_ATTEMPTS);
    return {
        intervalMs: (0, configuration_1.resolveNonNegativeIntEnv)(env.WEBHOOK_RECONCILE_INTERVAL_MS, 60_000),
        graceMs: (0, configuration_1.resolveNonNegativeIntEnv)(env.WEBHOOK_RECONCILE_GRACE_MS, 60_000),
        batchSize: Number.isInteger(batch) && batch >= 1 ? batch : 50,
        maxAttempts: Number.isInteger(maxAttempts) && maxAttempts >= 1 ? maxAttempts : 5,
    };
}
/**
 * Closes the crash window on outbound webhook delivery.
 *
 * Fan-out is fire-and-forget from the projector, so before the outbox row existed a hard crash
 * between persisting a message and completing its POST lost the delivery with nothing left behind
 * in either mode, while the documented contract promises at-least-once. The row makes the intent
 * durable; this sweep is what turns durability into delivery.
 *
 * Mirrors IngressReconcilerService on the inbound side: an unref'd interval started on module init,
 * an overlap guard so a slow pass never stacks, a bounded batch, and a per-row replay budget.
 *
 * The sweep does NOT claim a row, so two nodes running against one database can both replay the
 * same delivery. That is deliberate and matches the inbound reconciler: the replay carries the
 * stored idempotency key, which is exactly the header a receiver dedups on, so the cost of the
 * race is a duplicate the contract already tells consumers to expect. Claiming would trade that
 * for a lock whose holder can die mid-flight.
 */
let WebhookReconcilerService = class WebhookReconcilerService {
    webhooks;
    outbox;
    delivery;
    configService;
    logger = (0, logger_service_1.createLogger)('WebhookReconcilerService');
    timer;
    // The pass in flight, settled when it ends; doubles as the overlap guard.
    inFlight;
    // Aborted on destroy: stops the pass at the next row and the replay in hand before its next retry.
    // A row already past its last check, or a retry POST already started, still sends that one POST.
    stop = new AbortController();
    cursor;
    constructor(webhooks, outbox, delivery, configService) {
        this.webhooks = webhooks;
        this.outbox = outbox;
        this.delivery = delivery;
        this.configService = configService;
    }
    onModuleInit() {
        const opts = resolveWebhookReconcilerOptions();
        if (opts.intervalMs <= 0) {
            this.logger.log('Webhook delivery reconciler disabled (WEBHOOK_RECONCILE_INTERVAL_MS=0)');
            return;
        }
        this.timer = setInterval(() => {
            this.sweep(opts).catch(err => this.logger.error('Webhook reconcile sweep failed', err instanceof Error ? err.stack : String(err)));
        }, opts.intervalMs);
        this.timer.unref?.();
    }
    /**
     * Clearing the interval only stops the NEXT pass. A replay holds no dispatch slot, so the delivery
     * drain neither waits for nor stops a pass already running: it would go on POSTing after the drain,
     * and after PluginLoaderService has unregistered the `webhook:before` hooks. Stop it at the next row,
     * stop the replay in hand without a further retry, and wait for it, at most WEBHOOK_SHUTDOWN_DRAIN_MS
     * like the delivery drain beside it: the replay's hooks are not capped, and a queue lookup or add made
     * before Redis has ever connected waits up to REDIS_CONNECT_TIMEOUT_MS. A row given up on stays
     * 'pending' unless the replay in hand completes before the process exits.
     */
    async onModuleDestroy() {
        this.stop.abort();
        if (this.timer)
            clearInterval(this.timer);
        if (!this.inFlight)
            return;
        // Above MAX_TIMER_MS a Node timer fires after 1 ms; the delivery drain honours such a value in full.
        const waitMs = Math.min(this.configService.get('webhook.shutdownDrainMs', webhook_delivery_service_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS), configuration_1.MAX_TIMER_MS);
        let timer;
        const settled = await Promise.race([
            this.inFlight.then(() => true),
            new Promise(resolve => (timer = setTimeout(resolve, waitMs, false))),
        ]);
        clearTimeout(timer);
        if (!settled) {
            this.logger.warn('Webhook reconcile pass still running at shutdown; continuing without it', {
                waitMs,
                action: 'webhook_reconcile_shutdown_timeout',
            });
        }
    }
    /** One bounded pass over the stranded backlog. Overlap-guarded. */
    async sweep(opts, now = new Date()) {
        const stats = { scanned: 0, replayed: 0, failed: 0, skipped: 0 };
        if (this.inFlight || this.stop.signal.aborted)
            return stats;
        let settle;
        this.inFlight = new Promise(resolve => (settle = resolve));
        try {
            const cutoff = new Date(now.getTime() - opts.graceMs);
            // The last id the page covered, which can lie beyond its last readable row: a row whose stored
            // payload is unreadable is skipped, and the cursor must pass it or a page of them is read forever.
            let scannedThrough;
            const onScanned = (id) => {
                scannedThrough = id;
            };
            let rows = await this.outbox.findStale(cutoff, opts.batchSize, this.cursor, onScanned);
            if (rows.length === 0 && !scannedThrough && this.cursor) {
                this.cursor = undefined;
                rows = await this.outbox.findStale(cutoff, opts.batchSize, undefined, onScanned);
            }
            // Live jobs may occupy a whole page. Advance past them without spending their replay budget.
            this.cursor = scannedThrough ?? rows.at(-1)?.id;
            stats.scanned = rows.length;
            // Webhooks whose replay did not deliver in this pass. Direct mode replays one row at a time with
            // the full retry schedule, so a receiver that never answers would cost that schedule per stranded
            // row and hold every webhook behind it. The first failure has shown it is down: its further rows
            // make one attempt each, and the next sweep is their retry.
            const failedWebhooks = new Set();
            for (const row of rows) {
                if (this.stop.signal.aborted)
                    break;
                if (this.delivery.isLocallyPending(row.idempotencyKey)) {
                    // Still owned by a dispatch on this node (parked in the limiter or mid retry loop), so it
                    // is slow rather than stranded. Replaying it would POST alongside the original and outside
                    // the dispatch concurrency bound, and would spend its budget while it is still running.
                    stats.skipped++;
                    continue;
                }
                const webhook = await this.webhooks.findOne({ where: { id: row.webhookId } });
                if (!(0, deliver_once_1.isDeliverableWebhook)(webhook, row.event, row.sessionId)) {
                    // The subscription is gone, switched off or no longer lists this event; replaying it would
                    // deliver an event the operator has already unsubscribed from. Same test as the queue
                    // processor applies before every attempt.
                    await this.outbox.close(row.webhookId, row.idempotencyKey, 'failed');
                    stats.skipped++;
                    continue;
                }
                if (row.deliveryId && (await this.delivery.isQueueJobPending(row.deliveryId))) {
                    stats.skipped++;
                    continue;
                }
                if (row.deliveryId && (await this.delivery.hasQueueJobCompleted(row.deliveryId))) {
                    // A worker settled this job and its outbox row was left behind (a worker that never closes the
                    // outbox, or a close that failed). It is not stranded: a replay would POST an event the receiver
                    // already has, up to the budget, and then record a failure for a delivery that succeeded.
                    await this.outbox.close(row.webhookId, row.idempotencyKey, 'dispatched');
                    stats.skipped++;
                    continue;
                }
                if (row.attempts >= opts.maxAttempts) {
                    // A database fault may have prevented every terminal failure write. Keep the outbox
                    // payload until this handoff succeeds, without sending beyond the replay budget.
                    if (await this.delivery.recordReplayExhaustion(row, webhook.url)) {
                        await this.outbox.close(row.webhookId, row.idempotencyKey, 'failed');
                    }
                    stats.failed++;
                    continue;
                }
                // Shutdown may have begun during the lookups above; stop before spending budget or POSTing.
                if (this.stop.signal.aborted)
                    break;
                if (!(await this.outbox.countAttempt(row.id, row.attempts))) {
                    // Settled since the batch was read, typically a local dispatch that finished while an
                    // earlier row in this pass was replaying. The copy in hand is stale; replaying it duplicates.
                    stats.skipped++;
                    continue;
                }
                try {
                    // The outcome is a RETURN VALUE, not an exception. Every delivery failure is handled in
                    // place (dead-letter row, hook, log), so redeliver resolves either way and a catch here
                    // would see nothing: retiring on resolve alone marked dead-lettered events 'dispatched'
                    // and nulled their payload, spending the whole budget on one sweep.
                    const outcome = await this.delivery.redeliver(webhook, row.sessionId, row.event, row.idempotencyKey, row.payload, { signal: this.stop.signal, oneDirectAttempt: failedWebhooks.has(row.webhookId) });
                    if (outcome === 'failed' || outcome === 'unrecorded') {
                        // Left 'pending' on purpose: the next sweep retries it until the budget is spent.
                        this.logger.warn(`Replay of ${row.event} to webhook ${row.webhookId} did not deliver`);
                        failedWebhooks.add(row.webhookId);
                        stats.failed++;
                        continue;
                    }
                    // Enqueued rows retain their copy until the worker settles them, and redeliver has already
                    // retired a delivered one. A deliberate cancellation retires here.
                    if (outcome === 'cancelled')
                        await this.outbox.close(row.webhookId, row.idempotencyKey, 'dispatched');
                    stats.replayed++;
                }
                catch (error) {
                    // A replay cut short in its retry backoff by shutdown was interrupted, not failed. Any other
                    // exception is an unexpected fault rather than a delivery failure. The row stays pending.
                    if ((0, webhook_delivery_service_1.isAbortedBackoff)(error, this.stop.signal)) {
                        this.logger.log(`Replay of ${row.event} to webhook ${row.webhookId} interrupted by shutdown`);
                        stats.skipped++;
                        continue;
                    }
                    this.logger.warn(`Replay of ${row.event} to webhook ${row.webhookId} failed: ${String(error)}`);
                    stats.failed++;
                }
            }
        }
        finally {
            this.inFlight = undefined;
            settle();
        }
        return stats;
    }
};
exports.WebhookReconcilerService = WebhookReconcilerService;
exports.WebhookReconcilerService = WebhookReconcilerService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(webhook_entity_1.Webhook, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        webhook_outbox_service_1.WebhookOutboxService,
        webhook_delivery_service_1.WebhookDeliveryService,
        config_1.ConfigService])
], WebhookReconcilerService);
