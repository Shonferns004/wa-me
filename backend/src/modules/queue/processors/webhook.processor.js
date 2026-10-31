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
exports.WebhookProcessor = void 0;
const bullmq_1 = require("@nestjs/bullmq");
const bullmq_2 = require("bullmq");
const typeorm_1 = require("@nestjs/typeorm");
const config_1 = require("@nestjs/config");
const typeorm_2 = require("typeorm");
const logger_service_1 = require("../../../common/services/logger.service");
const queue_names_1 = require("../queue-names");
const redis_connection_1 = require("../redis-connection");
const close_worker_1 = require("./close-worker");
const webhook_entity_1 = require("../../webhook/entities/webhook.entity");
const webhook_outbox_service_1 = require("../../webhook/webhook-outbox.service");
const webhook_delivery_failure_entity_1 = require("../../webhook/entities/webhook-delivery-failure.entity");
const record_delivery_failure_1 = require("../../webhook/utils/record-delivery-failure");
const deliver_once_1 = require("../../webhook/utils/deliver-once");
const hooks_1 = require("../../../core/hooks");
const ssrf_guard_1 = require("../../../common/security/ssrf-guard");
const webhook_delivery_metrics_1 = require("../../../common/metrics/webhook-delivery-metrics");
/**
 * The exact `failedReason` BullMQ 6.x sets when a job stalls more than `maxStalledCount` (worker
 * default 1, so the SECOND genuine stall): the stalled checker (moveStalledJobsToWait Lua script)
 * stores it as the job's deferred failure, and the worker then fails the job itself — emitting
 * 'failed' WITHOUT ever calling process(). Lock renewal means a slow-but-alive processor never
 * stalls, so reaching this sentinel implies the job genuinely died twice mid-processing.
 */
const STALL_EXHAUSTION_MESSAGE = 'job stalled more than allowable limit';
// Override the Worker's connection so it does NOT inherit the producer's `enableOfflineQueue: false`
// from the shared BullModule connection — the Worker must tolerate a brief Redis reconnect. Set an
// explicit concurrency: BullMQ defaults a Worker to 1, which serializes every session's webhook
// deliveries behind one slow/timing-out receiver.
let WebhookProcessor = class WebhookProcessor extends bullmq_1.WorkerHost {
    webhookRepository;
    failureRepository;
    hookManager;
    configService;
    outbox;
    logger = (0, logger_service_1.createLogger)('WebhookProcessor');
    /**
     * Webhooks whose last attempt on this worker failed, until one succeeds. A job for one of them
     * takes a per-session slot first, at most `degradedSessionConcurrency` per session; over that it
     * goes back to the delayed set without spending an attempt. One session's failing receivers then
     * cannot fill the shared pool, while healthy receivers are never held back.
     */
    failingWebhooks = new Set();
    degradedInFlight = new Map();
    degradedSessionConcurrency;
    constructor(webhookRepository, failureRepository, hookManager, configService, outbox) {
        super();
        this.webhookRepository = webhookRepository;
        this.failureRepository = failureRepository;
        this.hookManager = hookManager;
        this.configService = configService;
        this.outbox = outbox;
        // WEBHOOK_DEGRADED_SESSION_CONCURRENCY, else a quarter of the worker pool.
        this.degradedSessionConcurrency =
            this.configService.get('webhook.degradedSessionConcurrency') ??
                Math.max(1, Math.floor((0, redis_connection_1.webhookWorkerConcurrency)() / 4));
    }
    // Stop taking jobs before the plugins are torn down, so a final attempt's webhook:error hook still
    // reaches them; see IngressProcessor.onModuleDestroy. The wait is min(WEBHOOK_TIMEOUT + 5 s, 10 s), so it
    // covers one POST plus its bookkeeping only while WEBHOOK_TIMEOUT is 5 s or less; a job still active at the
    // cap is re-run after the next start.
    async onModuleDestroy() {
        await (0, close_worker_1.closeWorkerIfStarted)(this, this.configService.get('webhook.timeout', 10000) + 5000);
    }
    async process(job, token) {
        const { webhookId, payload } = job.data;
        const sessionId = payload.sessionId;
        const gated = this.failingWebhooks.has(webhookId);
        if (gated) {
            const inFlight = this.degradedInFlight.get(sessionId) ?? 0;
            if (inFlight >= this.degradedSessionConcurrency) {
                // Before the try below on purpose: this is not an attempt, so it must never be logged as a
                // failure or file a dead-letter row. moveToDelayed does not spend one of the job's attempts.
                // At least a second: a job delayed to "now" is promoted straight back and would spin.
                const base = Math.max(1000, this.configService.get('webhook.retryDelay', 5000));
                // Each bounce doubles the job's wait, up to 64x, so a dead receiver's backlog is not promoted
                // and bounced again every few seconds, a churn that would grow with the backlog. attemptsStarted
                // counts every activation and attemptsMade only real attempts, so the gap, less this
                // activation, is how many times this job was already bounced.
                const bounces = Math.max(0, job.attemptsStarted - job.attemptsMade - 1);
                const delay = base * 2 ** Math.min(bounces, 6);
                await job.moveToDelayed(Date.now() + delay + Math.floor(Math.random() * delay), token);
                throw new bullmq_2.DelayedError();
            }
            this.degradedInFlight.set(sessionId, inFlight + 1);
        }
        try {
            return await this.deliver(job);
        }
        finally {
            if (gated) {
                const left = (this.degradedInFlight.get(sessionId) ?? 1) - 1;
                if (left > 0)
                    this.degradedInFlight.set(sessionId, left);
                else
                    this.degradedInFlight.delete(sessionId);
            }
        }
    }
    async deliver(job) {
        const { webhookId, event, payload, maxRetries } = job.data;
        const startTime = Date.now();
        const sessionId = payload.sessionId;
        this.logger.log(`Processing webhook job ${job.id}`, {
            webhookId,
            event,
            deliveryId: payload.deliveryId,
            idempotencyKey: payload.idempotencyKey,
            attempt: job.attemptsMade + 1,
            action: 'webhook_process_start',
        });
        const ctx = {
            job,
            webhookId,
            url: job.data.url,
            event,
            payload,
            maxRetries,
            sessionId,
            startTime,
        };
        try {
            // The job carries a snapshot taken at enqueue time. Re-read the row before every attempt: a
            // webhook that was deleted, disabled or unsubscribed from this event since then must not
            // receive it (the reconciler applies the same test; neither re-applies the webhook's filters,
            // which need the event data). Completing the job instead of throwing
            // stops the retries and files no dead-letter row. Otherwise deliver with the CURRENT url,
            // headers and secret, as the reconciler's replay does, so a receiver move or a rotated
            // secret or auth header applies to jobs already waiting in the queue.
            // A read error lands in the catch below and counts as a failed attempt, like a failed POST.
            const current = await this.loadDeliverableWebhook(webhookId, event, sessionId);
            if (!current) {
                this.logger.warn('Skipping queued webhook delivery: webhook removed, disabled or unsubscribed', {
                    webhookId,
                    event,
                    deliveryId: payload.deliveryId,
                    idempotencyKey: payload.idempotencyKey,
                    action: 'webhook_skipped_stale',
                });
                this.failingWebhooks.delete(webhookId);
                await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
                return { statusCode: 0, success: false, error: 'webhook removed, disabled or unsubscribed', responseTime: 0 };
            }
            ctx.url = current.url;
            const body = JSON.stringify(payload);
            const requestHeaders = (0, deliver_once_1.buildDeliveryHeaders)(current, event, payload.idempotencyKey, payload.deliveryId, body, job.attemptsMade);
            const { status, responseTime } = await this.postToReceiver(ctx, body, requestHeaders);
            this.failingWebhooks.delete(webhookId);
            await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
            await this.recordSuccessfulDelivery(ctx, status, responseTime);
            return {
                statusCode: status,
                success: true,
                responseTime,
            };
        }
        catch (error) {
            this.failingWebhooks.add(webhookId);
            await this.recordDeliveryFailure(ctx, error);
            // Re-throw to trigger BullMQ retry
            throw error;
        }
    }
    /** The webhook row as it is now, or null when it was deleted, disabled or no longer takes `event`. */
    async loadDeliverableWebhook(webhookId, event, sessionId) {
        const row = await this.webhookRepository.findOne({ where: { id: webhookId } });
        return (0, deliver_once_1.isDeliverableWebhook)(row, event, sessionId) ? row : null;
    }
    /**
     * POST the payload to the receiver through the SSRF-guarded fetch and classify the response:
     * a non-ok status throws into the failure path. Returns the status and measured response time.
     */
    async postToReceiver(ctx, body, requestHeaders) {
        const { url, startTime } = ctx;
        const { status } = await (0, deliver_once_1.postWebhookPayload)(url, body, requestHeaders, 
        // Honor WEBHOOK_TIMEOUT on the queued path too, as the direct path does.
        this.configService.get('webhook.timeout', 10000));
        const responseTime = Date.now() - startTime;
        return { status, responseTime };
    }
    /**
     * Post-delivery bookkeeping for a 2xx answer: guarded lastTriggeredAt update, the
     * webhook:delivered hook, and the success log.
     */
    async recordSuccessfulDelivery(ctx, status, responseTime) {
        const { job, webhookId, event, payload, sessionId } = ctx;
        // The receiver already answered 2xx — the delivery SUCCEEDED. Everything up to the return is
        // bookkeeping and must never throw back into the failure path: a rethrow would make BullMQ
        // retry (a duplicate POST for an already-delivered event) and, on the final attempt, file a
        // false dead-letter row. Log a bookkeeping failure and keep the success outcome.
        try {
            await this.webhookRepository.update(webhookId, {
                lastTriggeredAt: new Date(),
            });
        }
        catch (bookkeepingError) {
            this.logger.error('Webhook delivered but lastTriggeredAt update failed', bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError), { webhookId, deliveryId: payload.deliveryId, action: 'webhook_bookkeeping_failed' });
        }
        // A delivered event must not stay listed as lost. A failure row exists for it only when an
        // earlier dispatch of the same delivery was shed, refused or failed before this job ran. An
        // indexed delete that usually matches nothing.
        await (0, record_delivery_failure_1.clearDeliveryFailureRows)(this.failureRepository, this.logger, webhookId, payload.idempotencyKey);
        // Execute hook after successful delivery
        await this.hookManager.execute('webhook:delivered', {
            sessionId,
            event,
            webhookId,
            deliveryId: payload.deliveryId,
            statusCode: status,
            responseTime,
            attempt: job.attemptsMade + 1,
        }, { sessionId, source: 'WebhookProcessor' });
        this.logger.log(`Webhook delivered successfully`, {
            webhookId,
            event,
            deliveryId: payload.deliveryId,
            idempotencyKey: payload.idempotencyKey,
            statusCode: status,
            responseTime,
            attempt: job.attemptsMade + 1,
            action: 'webhook_delivered',
        });
    }
    /**
     * Failure-path bookkeeping: log the delivery failure and, on the final attempt, fire the
     * webhook:error hook, persist the durable dead-letter row, and bump the failures metric.
     */
    async recordDeliveryFailure(ctx, error) {
        const { job, webhookId, url, event, payload, maxRetries, sessionId, startTime } = ctx;
        const responseTime = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isFinalAttempt = job.attemptsMade + 1 >= maxRetries;
        this.logger.error(`Webhook delivery failed`, errorMessage, {
            webhookId,
            event,
            deliveryId: payload.deliveryId,
            idempotencyKey: payload.idempotencyKey,
            responseTime,
            attempt: job.attemptsMade + 1,
            maxRetries,
            isFinalAttempt,
            action: 'webhook_failed',
        });
        // On final failure (all retries exhausted): fire the error hook AND persist a durable record so
        // the lost event is visible after the BullMQ failed-set / logs roll off.
        if (isFinalAttempt) {
            // The hook payload and the durable row are surfaced to operators/plugins — redact SSRF detail
            // (resolved internal IP) from the client-facing message. The full `errorMessage` is already
            // logged server-side above; statusCodeFromError never matches an SSRF block (matches ^HTTP \d{3}).
            const clientError = (0, ssrf_guard_1.redactSsrfError)(error);
            await this.hookManager.execute('webhook:error', {
                sessionId,
                event,
                webhookId,
                deliveryId: payload.deliveryId,
                error: clientError,
                attempt: job.attemptsMade + 1,
            }, { sessionId, source: 'WebhookProcessor' });
            const recorded = await (0, record_delivery_failure_1.recordWebhookDeliveryFailure)(this.failureRepository, this.logger, {
                webhookId,
                sessionId,
                event,
                url,
                idempotencyKey: payload.idempotencyKey,
                deliveryId: payload.deliveryId,
                attempts: job.attemptsMade + 1,
                lastStatusCode: (0, record_delivery_failure_1.statusCodeFromError)(errorMessage),
                lastError: clientError,
                // The producer attaches the pre-hook event data only while payload retention is on.
                ...(this.configService.get('webhook.failurePayloadRetentionHours', 0) > 0 && job.data.replayData
                    ? { payload: job.data.replayData }
                    : {}),
            });
            if (recorded !== false)
                (0, webhook_delivery_metrics_1.incrementWebhookDeliveryFailures)();
            if (recorded !== null)
                await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
        }
    }
    /**
     * A job failed by stall exhaustion never enters process(): the worker fails it internally after
     * the second stall and only emits 'failed'. Without this handler such a job bypasses every product
     * failure channel — no dead-letter row, no metric, no webhook:error hook. Normal delivery failures
     * are already recorded by process() on the final attempt (and non-final ones are retried), so this
     * handler MUST ignore anything but the stall-exhaustion sentinel, or every failure is recorded
     * twice. `job` can be undefined when the queue's bounded `removeOnFail` window (see QueueModule's
     * WEBHOOK_QUEUE_JOB_OPTIONS) pruned it before this event fired — that window keeps failed-job
     * retention bounded, and each retained payload was size-gated before enqueue.
     */
    async onWorkerFailed(job, error) {
        // The sentinel text alone is not proof: a failed attempt whose error reads the same is retried and is not
        // this. BullMQ marks a job it fails for stalling by storing the reason as its deferred failure.
        if (!job || job.deferredFailure !== STALL_EXHAUSTION_MESSAGE || error.message !== STALL_EXHAUSTION_MESSAGE) {
            return;
        }
        const { webhookId, event, payload } = job.data;
        const sessionId = payload.sessionId;
        // Same rule as process(): no dead-letter row or webhook:error for a webhook that is gone, disabled
        // or unsubscribed, and the row records the URL a retry would have used. If the read itself fails,
        // record against the enqueue-time snapshot rather than lose the failure.
        let url = job.data.url;
        try {
            const current = await this.loadDeliverableWebhook(webhookId, event, sessionId);
            if (!current) {
                return;
            }
            url = current.url;
        }
        catch (readError) {
            this.logger.warn('Could not re-read webhook for a stalled job; recording the enqueue-time URL', {
                webhookId,
                error: readError instanceof Error ? readError.message : String(readError),
            });
        }
        this.logger.error('Webhook job failed after stalling beyond the recovery limit', error.message, {
            webhookId,
            event,
            deliveryId: payload.deliveryId,
            idempotencyKey: payload.idempotencyKey,
            attemptsMade: job.attemptsMade,
            action: 'webhook_stall_exhausted',
        });
        await this.hookManager.execute('webhook:error', {
            sessionId,
            event,
            webhookId,
            deliveryId: payload.deliveryId,
            error: error.message,
            attempt: job.attemptsMade,
        }, { sessionId, source: 'WebhookProcessor' });
        const recorded = await (0, record_delivery_failure_1.recordWebhookDeliveryFailure)(this.failureRepository, this.logger, {
            webhookId,
            sessionId,
            event,
            url,
            idempotencyKey: payload.idempotencyKey,
            deliveryId: payload.deliveryId,
            attempts: Math.max(1, job.attemptsMade),
            lastStatusCode: null, // no HTTP exchange completed on the stalled attempts
            lastError: error.message,
            ...(this.configService.get('webhook.failurePayloadRetentionHours', 0) > 0 && job.data.replayData
                ? { payload: job.data.replayData }
                : {}),
        });
        if (recorded !== false)
            (0, webhook_delivery_metrics_1.incrementWebhookDeliveryFailures)();
        if (recorded !== null)
            await this.outbox.close(webhookId, payload.idempotencyKey, 'dispatched');
    }
};
exports.WebhookProcessor = WebhookProcessor;
__decorate([
    (0, bullmq_1.OnWorkerEvent)('failed'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Error]),
    __metadata("design:returntype", Promise)
], WebhookProcessor.prototype, "onWorkerFailed", null);
exports.WebhookProcessor = WebhookProcessor = __decorate([
    (0, bullmq_1.Processor)(queue_names_1.QUEUE_NAMES.WEBHOOK, { connection: (0, redis_connection_1.workerConnectionOptions)(), concurrency: (0, redis_connection_1.webhookWorkerConcurrency)() }),
    __param(0, (0, typeorm_1.InjectRepository)(webhook_entity_1.Webhook, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(webhook_delivery_failure_entity_1.WebhookDeliveryFailure, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        hooks_1.HookManager,
        config_1.ConfigService,
        webhook_outbox_service_1.WebhookOutboxService])
], WebhookProcessor);
