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
exports.IngressEnqueueService = void 0;
exports.resolveIngressJobOptions = resolveIngressJobOptions;
exports.sanitizeIngressJobId = sanitizeIngressJobId;
exports.requeuedJobIds = requeuedJobIds;
exports.buildIngressDeadLetterRow = buildIngressDeadLetterRow;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const bullmq_1 = require("@nestjs/bullmq");
const bullmq_2 = require("bullmq");
const crypto_1 = require("crypto");
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const queue_names_1 = require("../queue/queue-names");
const redis_connection_1 = require("../queue/redis-connection");
const logger_service_1 = require("../../common/services/logger.service");
const configuration_1 = require("../../config/configuration");
/**
 * Retry policy for inbound ingress jobs. Previously the enqueue passed only a jobId, so BullMQ ran a
 * SINGLE attempt — a transient plugin-sandbox 5xx went straight to the DLQ with no retry (asymmetric
 * with the webhook queue). A few exponential-backoff attempts absorb transient failures; the
 * final-attempt DLQ write in ingress.processor is gated on `job.opts.attempts`, so it still fires
 * exactly once, only after these are exhausted. Env-overridable (INGRESS_MAX_ATTEMPTS /
 * INGRESS_RETRY_DELAY_MS); an invalid value falls back to the default.
 */
function resolveIngressJobOptions() {
    return {
        attempts: (0, configuration_1.resolveNonNegativeIntEnv)(process.env.INGRESS_MAX_ATTEMPTS, 0) || 3,
        backoff: { type: 'exponential', delay: (0, configuration_1.resolveNonNegativeIntEnv)(process.env.INGRESS_RETRY_DELAY_MS, 5000) },
    };
}
/**
 * BullMQ refuses several jobId shapes outright, at two validation sites: Job.validateOptions rejects
 * an exact integer string ("Custom Id cannot be integers") and a colon id that does not split into
 * exactly 3 parts ("Custom Id cannot contain :"); Queue.addJob additionally rejects '0' and any
 * '0:'-prefixed id ("JobId cannot be '0' or start with '0:'"). Providers send numeric dedup headers
 * (`svix-Id: 12345`), and the redrive path mints `redrive:<uuid>`, so these refusals happen in
 * practice, and because enqueue()'s catch-all treats ANY add() throw as "Redis unreachable", the job
 * silently degraded to inline dispatch with no retry, no backoff, and a blocked redrive loop. Every id
 * therefore maps to a deterministic sha256 prefix, which BullMQ always accepts: its exactly-once dedup
 * only needs the id STABLE per delivery, not recognizable, and the reconciler replays through this
 * same function so its dedup against an earlier enqueue is preserved.
 *
 * The hash input is namespaced with the plugin/instance pair, for EVERY id rather than only the
 * refused shapes. BullMQ dedups jobIds across the WHOLE shared ingress queue, while the database dedup
 * is (pluginId, instanceId, providerDeliveryId), and two instances can share a provider id: numeric
 * per-account sequences, or one Standard Webhooks message fanned out to two endpoints with the same
 * `webhook-id`. Without the namespace, the second instance's delivery would collide with the first's
 * job id and BullMQ would silently discard it (resolved as the existing job, no DLQ row); with it, the
 * queue-level dedup matches the database-level scope. A non-string id (a duplicated header can surface
 * as string[]) is coerced rather than trusted to reach BullMQ's own checks.
 */
function sanitizeIngressJobId(jobId, namespace = '') {
    const raw = typeof jobId === 'string' ? jobId : String(jobId);
    return `ing-${(0, crypto_1.createHash)('sha256').update(`${namespace}\u0000${raw}`).digest('hex').slice(0, 40)}`;
}
function queueJobId(data, jobId) {
    return sanitizeIngressJobId(jobId, `${data.pluginId}\u0000${data.instanceId}`);
}
/**
 * The two ids IngressProcessor re-queues a delivery under when its dead-letter row cannot be written.
 * A copy that fails the same way re-queues under the other one, so the ids stay fixed and a live copy
 * can be looked up by id instead of being mistaken for a dead-lettered delivery.
 */
function requeuedJobIds(baseJobId) {
    return [`${baseJobId}-requeued-1`, `${baseJobId}-requeued-2`];
}
// A job in one of these states still owns the delivery, or already delivered it.
const isLiveOrCompleted = (state) => state !== 'failed' && state !== 'unknown';
/**
 * Build the dead-letter row for an ingress delivery whose inline-dispatch fallback failed. The shape
 * mirrors the row IngressProcessor writes on a final-attempt failure (direction / pluginId / instanceId
 * / sessionId / deliveryId / attempts / lastError / payload / redriven), so RedriveService reads either
 * back identically. `attempts` is 1 — the inline path makes a single dispatch attempt (no BullMQ retries).
 */
function buildIngressDeadLetterRow(data, error) {
    return {
        direction: 'inbound',
        pluginId: data.pluginId,
        instanceId: data.instanceId,
        sessionId: data.sessionId ?? null,
        deliveryId: data.deliveryId,
        attempts: 1,
        lastError: error ?? 'inline ingress dispatch failed',
        payload: {
            route: data.route,
            method: data.method,
            providerConversationId: data.providerConversationId,
            ingress: data.payload,
        },
        redriven: false,
    };
}
/**
 * Shared queue-or-inline enqueue for inbound ingress jobs. Extracted out of IngressService's DI
 * factory (integration.module.ts) so RedriveService can reuse the exact same behavior when replaying
 * DLQ rows: same queue.add args, same inline dispatch-after-persist fallback, same error swallow.
 * The ingress queue stays @Optional so a queue-off boot (QUEUE_ENABLED unset/false) needs no
 * QueueModule — and no Redis — at all; a missing injection then means inline dispatch, mirroring
 * WebhookService's direct fallback. Under QUEUE_ENABLED=true, IntegrationModule imports QueueModule
 * so the queue provider MUST resolve; onApplicationBootstrap below fails the boot if it did not, so
 * a broken queue wiring crashes at startup instead of silently running inline forever (the queued
 * dispatch contract — fast-ack, retries, ordered processing — would otherwise be dead with no signal).
 */
let IngressEnqueueService = class IngressEnqueueService {
    loader;
    config;
    ingressQueue;
    logger = (0, logger_service_1.createLogger)('IngressEnqueueService');
    constructor(loader, config, ingressQueue) {
        this.loader = loader;
        this.config = config;
        this.ingressQueue = ingressQueue;
    }
    onApplicationBootstrap() {
        // Reads the same module-eval signal as the conditional QueueModule imports (integration.module.ts /
        // webhook.module.ts), not the runtime config, so the check guards exactly the wiring that should
        // have happened at import time.
        if (process.env.QUEUE_ENABLED === 'true' && !this.ingressQueue) {
            throw new Error(`QUEUE_ENABLED=true but the '${queue_names_1.QUEUE_NAMES.INGRESS}' BullMQ queue did not resolve — ` +
                'IntegrationModule must import QueueModule (see the QUEUE_ENABLED conditional in integration.module.ts). ' +
                'Refusing to boot: ingress deliveries would silently dispatch inline, defeating the queued-dispatch contract.');
        }
    }
    /**
     * Whether a delivery of this plugin must wait to be dispatched: it would run inline, because the queue is off,
     * in a plugin the boot restore has not reached, which has no worker to run it in. With the queue on, the job
     * is enqueued instead, and IngressProcessor holds it until the plugin is up.
     */
    defersInlineDispatch(pluginId) {
        const queued = this.config.get('queue.enabled', false) && !!this.ingressQueue;
        return !queued && this.loader.isRestorePending(pluginId);
    }
    /**
     * State of the job an earlier enqueue() of this delivery left in the queue, or undefined when the
     * queue is off, holds no such job, or cannot answer. add() resolves for a duplicate jobId whatever
     * state the existing job is in, so a caller replaying under the original jobId must look first: a
     * retained failed job (removeOnFail keeps it for a day) would silently swallow the replay. When that
     * job failed or is gone, a live or completed re-queued copy (see requeuedJobIds) answers for it: the
     * copy owns the delivery, so neither a replay nor a dead-letter row may stand in for it.
     */
    async existingJobState(data, jobId) {
        if (!this.config.get('queue.enabled', false) || !this.ingressQueue)
            return undefined;
        try {
            await (0, redis_connection_1.producerReady)(this.ingressQueue);
            const id = queueJobId(data, jobId);
            const state = await this.ingressQueue.getJobState(id);
            if (isLiveOrCompleted(state))
                return state;
            for (const copyId of requeuedJobIds(id)) {
                const copyState = await this.ingressQueue.getJobState(copyId);
                if (isLiveOrCompleted(copyState))
                    return copyState;
            }
            return state === 'unknown' ? undefined : state;
        }
        catch (err) {
            // Redis unreachable or not yet connected: enqueue() then takes its own inline fallback, as it would
            // without the probe.
            this.logger.warn('Ingress job state lookup failed', {
                pluginId: data.pluginId,
                instanceId: data.instanceId,
                deliveryId: data.deliveryId,
                error: err instanceof Error ? err.message : String(err),
                action: 'ingress_job_state_lookup_failed',
            });
            return undefined;
        }
    }
    /**
     * `signal` lets a caller that stops at shutdown (the reconciler) refuse the inline fallback once it
     * has aborted: a queue add that fails after the stop rethrows the abort reason instead of
     * dispatching, since the plugin may already be torn down. That is the only way enqueue() throws.
     */
    async enqueue(data, jobId, signal) {
        const queueEnabled = this.config.get('queue.enabled', false);
        const useQueue = queueEnabled && !!this.ingressQueue;
        if (useQueue && this.ingressQueue) {
            try {
                // jobId = deliveryId gives BullMQ exactly-once enqueue semantics; the retry policy adds bounded
                // exponential-backoff attempts so a transient failure retries before landing in the DLQ. The id
                // is sanitized because BullMQ refuses several id shapes at add() (see sanitizeIngressJobId),
                // which would otherwise read as a Redis failure here and fall through to inline dispatch.
                await (0, redis_connection_1.producerReady)(this.ingressQueue);
                await this.ingressQueue.add('ingress', data, {
                    jobId: queueJobId(data, jobId),
                    ...resolveIngressJobOptions(),
                });
                return { outcome: 'queued' };
            }
            catch (err) {
                // Redis unreachable (enableOfflineQueue:false makes add() reject) — fall through to inline
                // dispatch (before the first connect, producerReady rejects instead). Without this, the
                // already-persisted event would be lost forever: the throw would 500 the ingress request, the
                // provider retries, dedup returns "duplicate", and no job was ever enqueued (no DLQ row either).
                // Mirrors WebhookService's queue-add fallback.
                signal?.throwIfAborted();
                this.logger.error('Ingress queue add failed; dispatching inline', err instanceof Error ? err.message : String(err), {
                    pluginId: data.pluginId,
                    instanceId: data.instanceId,
                    route: data.route,
                    deliveryId: data.deliveryId,
                    action: 'ingress_queue_add_failed',
                });
            }
        }
        // Queue disabled OR queue.add() failed: dispatch inline AFTER the ingress_events row was persisted
        // (persist-before-dispatch still holds), mirroring the webhook direct-delivery fallback.
        try {
            await this.loader.dispatchWebhookForInstance(data);
            return { outcome: 'dispatched' };
        }
        catch (err) {
            // A duplicate delivery is already acked before this point, so a failure here is a real dispatch error.
            // Log and swallow so the provider still gets its 202 (at-least-once, like the webhook fallback).
            // enqueue() intentionally does NOT write a dead-letter row here — it is shared with RedriveService
            // (a failed replay must not spawn a second DLQ row). The 'failed' outcome + error is returned so the
            // caller decides durability: the live-ingress wiring persists a DLQ row (buildIngressDeadLetterRow).
            const error = err instanceof Error ? err.message : String(err);
            this.logger.error('Inline ingress dispatch failed', error, {
                pluginId: data.pluginId,
                instanceId: data.instanceId,
                route: data.route,
                deliveryId: data.deliveryId,
                action: 'ingress_inline_dispatch_failed',
            });
            return { outcome: 'failed', error };
        }
    }
};
exports.IngressEnqueueService = IngressEnqueueService;
exports.IngressEnqueueService = IngressEnqueueService = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Optional)()),
    __param(2, (0, bullmq_1.InjectQueue)(queue_names_1.QUEUE_NAMES.INGRESS)),
    __metadata("design:paramtypes", [plugin_loader_service_1.PluginLoaderService,
        config_1.ConfigService, Object])
], IngressEnqueueService);
