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
exports.IngressProcessor = void 0;
const common_1 = require("@nestjs/common");
const bullmq_1 = require("@nestjs/bullmq");
const bullmq_2 = require("bullmq");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const queue_names_1 = require("../queue-names");
const redis_connection_1 = require("../redis-connection");
const close_worker_1 = require("./close-worker");
const integration_delivery_failure_entity_1 = require("../../integration/entities/integration-delivery-failure.entity");
const ingress_event_entity_1 = require("../../integration/entities/ingress-event.entity");
const plugin_loader_service_1 = require("../../../core/plugins/plugin-loader.service");
const hooks_1 = require("../../../core/hooks");
const logger_service_1 = require("../../../common/services/logger.service");
const shutdown_service_1 = require("../../../common/services/shutdown.service");
const ordering_lock_1 = require("../../integration/ordering-lock");
const ingress_enqueue_service_1 = require("../../integration/ingress-enqueue.service");
// BullMQ's failedReason for a job that stalled more than maxStalledCount (see WebhookProcessor).
const STALL_EXHAUSTION_MESSAGE = 'job stalled more than allowable limit';
// How long a delivery whose dead-letter row could not be written waits before it runs again.
const REQUEUE_DELAY_MS = 60_000;
// The id suffix deadLetterOrRequeue gives a re-queued delivery (see requeuedJobIds).
const REQUEUED_JOB_ID = /-requeued-[12]$/;
// The KeyedAsyncLock wrapping dispatch below guarantees no two dispatches for the SAME conversation
// run concurrently (mutual exclusion + in-order START for events as they reach the worker), so the
// worker no longer needs concurrency 1: raising it parallelizes unrelated conversations. The lock is
// taken inside the job, though, so a job waiting on a busy key still holds a worker slot. A burst on
// one key larger than the concurrency fills every slot with waiters, and other keys queue behind it
// until it drains. The key is per instance when the route declares no conversationId pointer, so
// routes should declare one, and the concurrency should exceed the largest expected per-key burst.
//
// Strict end-to-end order is NOT preserved across a BullMQ retry: a retried job re-enters lock.run()
// after its backoff and chains at the conversation's CURRENT tail, so it can overtake a
// same-conversation successor that dispatched
// during the backoff window. This is a deliberate tradeoff — BullMQ retries release the worker slot
// during backoff (better throughput under transient failure), where retrying inside the lock would
// hold it — and is acceptable because ingress order is best-effort regardless: the provider delivers
// over unordered HTTP. Order-strict plugins must not assume retry-involved events arrive in sequence.
let IngressProcessor = class IngressProcessor extends bullmq_1.WorkerHost {
    loader;
    failures;
    hooks;
    ingressQueue;
    events;
    logger = (0, logger_service_1.createLogger)('IngressProcessor');
    lock = new ordering_lock_1.KeyedAsyncLock();
    constructor(loader, failures, hooks, ingressQueue, events, shutdown) {
        super();
        this.loader = loader;
        this.failures = failures;
        this.hooks = hooks;
        this.ingressQueue = ingressQueue;
        this.events = events;
        // A plugin's ingress handler sends through the session engines, and SessionModule tears them down
        // before QueueModule is destroyed, so a job taken in between fails and spends an attempt. Stop taking
        // jobs once shutdown begins: the jobs already running keep the drain window to finish while the
        // engines are up, onModuleDestroy below waits for them, and the rest stay in Redis for another node
        // or the next start. A close that skips ShutdownService (a signal Nest handles) closes there only.
        shutdown?.onShutdown(() => {
            const worker = (0, close_worker_1.startedWorker)(this);
            void worker?.close().catch(() => undefined);
        });
    }
    /**
     * BullModule closes the worker only in onApplicationShutdown, after every destroy hook, so it would
     * keep taking jobs while PluginLoaderService (a global module, destroyed last) disables the plugins:
     * each one would fail against a terminated sandbox, spending an attempt or landing in the DLQ.
     * Closing here, before the global modules, lets the jobs already running finish against live plugins
     * and leaves the rest in Redis for the next start. Running jobs that share an ordering key dispatch
     * one after another, so a full worker of them can outlast any wait; this one takes the whole cap.
     * A job still running at the cap is cut mid-dispatch and re-run after the next start; BullMQ allows one
     * stall per job, so a second one fails it.
     */
    async onModuleDestroy() {
        await (0, close_worker_1.closeWorkerIfStarted)(this, close_worker_1.MAX_WORKER_CLOSE_WAIT_MS);
    }
    async process(job, token) {
        const d = job.data;
        if (this.loader.isRestorePending(d.pluginId)) {
            // The plugin's worker does not exist until the boot restore reaches it, and a restore can outlast the
            // whole retry budget. Before the try below on purpose: this is not an attempt, so it must never be
            // logged as a failure or file a dead-letter row. moveToDelayed does not spend one of the job's attempts.
            // Every held job is delayed to the next multiple of the retry delay (at least a second: a job delayed to
            // "now" is promoted straight back and would spin), so they all wake together and BullMQ promotes them in the
            // order they were delayed. A fixed delay from "now" would give two deliveries of one conversation, a fraction of
            // a period apart, polls a fraction of a period apart, and a restore ending between them lets the later through
            // first. The delay carries no jitter for the same reason. Jobs of one wake that the worker reaches after
            // the restore ends still pass those it held again before, and BullMQ's delayed score has 4096 insertion
            // ranks per millisecond: past them the jobs of one wake come back ordered by id.
            const delay = Math.max(1000, (0, ingress_enqueue_service_1.resolveIngressJobOptions)().backoff.delay);
            await job.moveToDelayed((Math.floor(Date.now() / delay) + 1) * delay, token);
            throw new bullmq_2.DelayedError();
        }
        try {
            await this.lock.run((0, ordering_lock_1.orderingKeyFor)(d), () => this.loader.dispatchWebhookForInstance(d));
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
            this.logger.error('Ingress dispatch failed', errorMessage, {
                pluginId: d.pluginId,
                instanceId: d.instanceId,
                route: d.route,
                deliveryId: d.deliveryId,
                attempt: job.attemptsMade + 1,
                isFinalAttempt,
                action: 'ingress_dispatch_failed',
            });
            if (isFinalAttempt)
                await this.deadLetterOrRequeue(job, job.attemptsMade + 1, errorMessage);
            // BullMQ reads an error with exactly this text as a rate limit, moves the job back to wait without
            // counting the attempt and runs it again: here a hot loop that never reaches the final attempt, or on
            // it writes a dead letter on every run. A handler may relay such text from elsewhere.
            if (errorMessage === bullmq_2.RATE_LIMIT_ERROR) {
                throw new Error(`Ingress dispatch failed: ${errorMessage}`, { cause: err });
            }
            // Re-throw to trigger BullMQ's exponential backoff / retry.
            throw err;
        }
        if (REQUEUED_JOB_ID.test(String(job.id)))
            await this.settleRequeued(d);
    }
    /**
     * A re-queued copy runs while the original job stays 'failed' under the original id. The reconciler
     * takes a live or completed copy for the job, but one it misses (pruned once completed) reads as
     * dead-lettered: for an event still 'pending' it writes a DLQ row and marks the event 'failed'.
     * Record the delivery on both so neither is left redrivable for an event the plugin already
     * received. Never rejects: the dispatch succeeded, and a retry would deliver it again.
     */
    async settleRequeued(d) {
        try {
            await this.events.update({ pluginId: d.pluginId, instanceId: d.instanceId, providerDeliveryId: d.deliveryId }, { dispatchState: 'dispatched', payload: null });
            await this.failures.update({
                direction: 'inbound',
                pluginId: d.pluginId,
                instanceId: d.instanceId,
                deliveryId: d.deliveryId,
                redriven: false,
            }, { redriven: true });
        }
        catch (err) {
            this.logger.error('Could not record a re-queued ingress delivery', err instanceof Error ? err.message : String(err), {
                pluginId: d.pluginId,
                instanceId: d.instanceId,
                deliveryId: d.deliveryId,
                action: 'ingress_requeue_settle_failed',
            });
        }
    }
    /**
     * A job failed by stall exhaustion never enters process(): the worker fails it internally and only
     * emits 'failed'. The ingress_events row already retired its payload when the enqueue returned
     * 'queued', so without this the failed BullMQ job (pruned by removeOnFail) is the only copy and no
     * DLQ row exists to redrive. Any other failure was already recorded by process() on the final
     * attempt, so only the stall sentinel is handled here. `job` is undefined once removeOnFail pruned it.
     */
    async onWorkerFailed(job, error) {
        // The sentinel text alone is not proof: a failed attempt whose error reads the same is retried and is not
        // this. BullMQ marks a job it fails for stalling by storing the reason as its deferred failure.
        if (!job || job.deferredFailure !== STALL_EXHAUSTION_MESSAGE || error.message !== STALL_EXHAUSTION_MESSAGE)
            return;
        const d = job.data;
        this.logger.error('Ingress job failed after stalling beyond the recovery limit', error.message, {
            pluginId: d.pluginId,
            instanceId: d.instanceId,
            route: d.route,
            deliveryId: d.deliveryId,
            attemptsMade: job.attemptsMade,
            action: 'ingress_stall_exhausted',
        });
        // Never rejects: an event listener's rejection would surface as an unhandled rejection.
        await this.deadLetterOrRequeue(job, job.attemptsMade, error.message);
    }
    /**
     * Dead-letter a job that has spent its attempts. That row is the only durable copy left, so when the
     * data database refuses it too (an outage longer than the retry window fails dispatch and the write
     * alike), the delivery goes back on the queue, which still works, and runs again once the database
     * is back. A fresh job id, because the failed job keeps the original one until removeOnFail prunes it
     * and BullMQ would resolve an add under that id to the existing job. A copy that fails the same way
     * takes the other of the two copy ids, removing the failed copy before it that still holds it, so the
     * reconciler can find the live one by id. Never rejects.
     */
    async deadLetterOrRequeue(job, attempts, errorMessage) {
        const d = job.data;
        try {
            await this.deadLetter(d, attempts, errorMessage, REQUEUED_JOB_ID.test(String(job.id)));
        }
        catch (err) {
            const meta = { jobId: job.id, pluginId: d.pluginId, instanceId: d.instanceId, deliveryId: d.deliveryId };
            const reason = err instanceof Error ? err.message : String(err);
            try {
                const [first, second] = (0, ingress_enqueue_service_1.requeuedJobIds)(String(job.id).replace(REQUEUED_JOB_ID, ''));
                const jobId = String(job.id) === first ? second : first;
                // The producer queue holds its calls until its first connect, which the worker's own connection does not
                // wait for; bounded, so the recovery gives up instead of waiting on a Redis that never answered it.
                await (0, redis_connection_1.producerReady)(this.ingressQueue);
                await this.ingressQueue.remove(jobId);
                await this.ingressQueue.add(job.name, d, {
                    jobId,
                    attempts: job.opts.attempts,
                    backoff: job.opts.backoff,
                    delay: REQUEUE_DELAY_MS,
                });
                this.logger.error('Could not dead-letter a failed ingress job; re-queued it', reason, {
                    ...meta,
                    action: 'ingress_dlq_failed_requeued',
                });
            }
            catch (queueErr) {
                // Only the failed BullMQ job is left; the job id lets an operator retry it before it is pruned.
                this.logger.error('Could not dead-letter or re-queue a failed ingress job', reason, {
                    ...meta,
                    requeueError: queueErr instanceof Error ? queueErr.message : String(queueErr),
                    action: 'ingress_dlq_failed',
                });
            }
        }
    }
    async deadLetter(d, attempts, errorMessage, requeued) {
        await this.hooks.execute('ingress:error', { ...d, error: errorMessage }, { sessionId: d.sessionId, source: 'IngressProcessor' });
        // The reconciler writes this row itself when it finds the original job failed with none, so a
        // re-queued copy that fails again must not add a second redrivable one. Only a re-queued copy: a
        // redrive job can fail while the row it replays is still open, and that row is retired regardless.
        if (requeued &&
            (await this.failures.count({
                where: {
                    direction: 'inbound',
                    pluginId: d.pluginId,
                    instanceId: d.instanceId,
                    deliveryId: d.deliveryId,
                    redriven: false,
                },
            })) > 0) {
            return;
        }
        await this.failures.save({
            direction: 'inbound',
            pluginId: d.pluginId,
            instanceId: d.instanceId,
            sessionId: d.sessionId ?? null,
            deliveryId: d.deliveryId,
            attempts,
            lastError: errorMessage,
            // Persist the FULL ingress payload (route + headers/rawBody) so P1 redrive is
            // self-contained and never has to re-read ingress_events.
            payload: {
                route: d.route,
                method: d.method,
                providerConversationId: d.providerConversationId,
                ingress: d.payload,
            },
            redriven: false,
        });
    }
};
exports.IngressProcessor = IngressProcessor;
__decorate([
    (0, bullmq_1.OnWorkerEvent)('failed'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Error]),
    __metadata("design:returntype", Promise)
], IngressProcessor.prototype, "onWorkerFailed", null);
exports.IngressProcessor = IngressProcessor = __decorate([
    (0, bullmq_1.Processor)(queue_names_1.QUEUE_NAMES.INGRESS, { connection: (0, redis_connection_1.workerConnectionOptions)(), concurrency: (0, redis_connection_1.ingressWorkerConcurrency)() }),
    __param(1, (0, typeorm_1.InjectRepository)(integration_delivery_failure_entity_1.IntegrationDeliveryFailure, 'data')),
    __param(3, (0, bullmq_1.InjectQueue)(queue_names_1.QUEUE_NAMES.INGRESS)),
    __param(4, (0, typeorm_1.InjectRepository)(ingress_event_entity_1.IngressEvent, 'data')),
    __param(5, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [plugin_loader_service_1.PluginLoaderService,
        typeorm_2.Repository,
        hooks_1.HookManager, Object, typeorm_2.Repository,
        shutdown_service_1.ShutdownService])
], IngressProcessor);
