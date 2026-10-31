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
exports.WebhookRedriveService = exports.MAX_WEBHOOK_REDRIVE_LIMIT = exports.DEFAULT_WEBHOOK_REDRIVE_LIMIT = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const webhook_entity_1 = require("./entities/webhook.entity");
const webhook_delivery_failure_entity_1 = require("./entities/webhook-delivery-failure.entity");
const webhook_delivery_service_1 = require("./webhook-delivery.service");
const deliver_once_1 = require("./utils/deliver-once");
const configuration_1 = require("../../config/configuration");
const session_scope_1 = require("../../common/security/session-scope");
const logger_service_1 = require("../../common/services/logger.service");
const wildcard_events_1 = require("../../common/utils/wildcard-events");
/** Rows replayed per call when the caller names no limit, and the most one call will take. */
exports.DEFAULT_WEBHOOK_REDRIVE_LIMIT = 100;
exports.MAX_WEBHOOK_REDRIVE_LIMIT = 500;
/**
 * Replays run this many at a time. Each direct replay is one POST bounded by WEBHOOK_TIMEOUT, so a
 * full batch against a receiver that times out finishes in about limit / 4 timeouts rather than
 * limit of them, without opening a socket per row.
 */
const REDRIVE_CONCURRENCY = 4;
/**
 * Operator redrive of lost outbound webhook deliveries: the outbound twin of the integration
 * RedriveService. A terminal row of webhook_delivery_failures keeps the pre-hook event data while
 * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0; this replays those rows through
 * WebhookDeliveryService.redeliver with the STORED idempotency key, so a receiver that already
 * processed the event (the POST timed out after it was handled) dedups the replay instead of
 * acting twice. `webhook:before` hooks run again, as on a reconciler replay.
 *
 * A replay that succeeds removes its own row (the delivery path clears every failure row of the
 * key). One that fails again keeps the row: the recorder files one row per lost delivery, so the
 * replay only raises its attempt count.
 */
let WebhookRedriveService = class WebhookRedriveService {
    webhookRepository;
    failureRepository;
    delivery;
    configService;
    logger = (0, logger_service_1.createLogger)('WebhookRedrive');
    /**
     * One redrive at a time on this node, so two overlapping calls (a double click, a retrying script)
     * do not replay the same rows side by side. Across nodes a duplicate replay carries the same
     * idempotency key, which the receiver dedups on.
     */
    running = Promise.resolve();
    // Aborted on destroy: a batch in progress takes no further row.
    stop = new AbortController();
    constructor(webhookRepository, failureRepository, delivery, configService) {
        this.webhookRepository = webhookRepository;
        this.failureRepository = failureRepository;
        this.delivery = delivery;
        this.configService = configService;
    }
    /**
     * A redrive runs inside an admitted HTTP request, which shutdown lets finish, and its replays hold
     * no dispatch slot, so the delivery drain neither waits for nor stops them. Left alone it would go
     * on POSTing after PluginLoaderService has unregistered the `webhook:before` hooks, sending the
     * stored pre-hook data. Stop at the next row and wait for the replays in hand: this module is
     * destroyed before the global plugin module, so those still run with their hooks. Rows not reached
     * stay for a later call and are counted in `remaining`. The wait is at most WEBHOOK_SHUTDOWN_DRAIN_MS,
     * like the delivery drain and the reconciler beside it: a replay in hand is one POST plus hooks and
     * database writes that carry no cap of their own.
     */
    async onModuleDestroy() {
        this.stop.abort();
        // Above MAX_TIMER_MS a Node timer fires after 1 ms; the delivery drain honours such a value in full.
        const waitMs = Math.min(this.configService.get('webhook.shutdownDrainMs', webhook_delivery_service_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS), configuration_1.MAX_TIMER_MS);
        let timer;
        const settled = await Promise.race([
            this.running.then(() => true),
            new Promise(resolve => (timer = setTimeout(resolve, waitMs, false))),
        ]);
        clearTimeout(timer);
        if (!settled) {
            this.logger.warn('Webhook redrive still running at shutdown; continuing without it', {
                waitMs,
                action: 'webhook_redrive_shutdown_timeout',
            });
        }
    }
    redrive(request, allowedSessions) {
        const run = this.running.then(() => this.redriveBatch(request, allowedSessions));
        // The chain must survive a failed batch, or every later call would inherit its rejection.
        this.running = run.catch(() => undefined);
        return run;
    }
    async redriveBatch(request, allowedSessions) {
        const result = {
            redriven: 0,
            delivered: 0,
            enqueued: 0,
            failed: 0,
            skipped: 0,
            remaining: 0,
        };
        // The calling key's allowedSessions is authoritative; the body's sessionId may only narrow it.
        const sessionScope = (0, session_scope_1.resolveSessionScope)(allowedSessions, request.sessionId);
        if (sessionScope !== null && sessionScope.length === 0)
            return result;
        const retentionHours = this.configService.get('webhook.failurePayloadRetentionHours', 0);
        if (retentionHours <= 0 || request.ids?.length === 0)
            return result;
        const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000);
        // Join eligible subscriptions before taking a batch. A single membership predicate also avoids
        // an OR expression and repeated ids parameters for every active webhook across all sessions.
        const subscriptions = this.failureRepository.manager.connection.options.type === 'postgres'
            ? "json_array_elements_text(CASE WHEN json_typeof(webhook.events::json) = 'array' THEN webhook.events::json ELSE '[]'::json END) AS subscribed(event)"
            : "json_each(CASE WHEN json_type(webhook.events) = 'array' THEN webhook.events ELSE '[]' END) AS subscribed";
        const subscribedEvent = this.failureRepository.manager.connection.options.type === 'postgres' ? 'subscribed.event' : 'subscribed.value';
        const query = this.failureRepository
            .createQueryBuilder('failure')
            .innerJoin(webhook_entity_1.Webhook, 'webhook', 'CAST(webhook.id AS text) = failure.webhookId AND CAST(webhook.sessionId AS text) = failure.sessionId')
            .where({
            attempts: (0, typeorm_2.MoreThan)(0),
            payload: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()),
            idempotencyKey: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()),
            createdAt: (0, typeorm_2.MoreThan)(cutoff),
            ...(request.ids ? { id: (0, typeorm_2.In)(request.ids) } : {}),
            ...(sessionScope ? { sessionId: (0, typeorm_2.In)(sessionScope) } : {}),
            ...(request.webhookId ? { webhookId: request.webhookId } : {}),
        })
            .andWhere('webhook.active = :active', { active: true })
            // The same rule as subscriptionCoversEvent: '*' covers every event except the opt-in ones, which a
            // webhook must name. Selecting them for a '*'-only webhook would put rows at the head of every batch
            // that the replay then skips without raising their attempts, so they would never leave it.
            .andWhere(`EXISTS (SELECT 1 FROM ${subscriptions} WHERE ${subscribedEvent} = failure.event` +
            ` OR (${subscribedEvent} = '*' AND failure.event NOT IN (:...wildcardExcluded)))`, { wildcardExcluded: [...wildcard_events_1.WILDCARD_EXCLUDED_EVENTS] });
        const limit = Math.min(Math.max(1, request.limit ?? exports.DEFAULT_WEBHOOK_REDRIVE_LIMIT), exports.MAX_WEBHOOK_REDRIVE_LIMIT);
        // A call still queued when shutdown starts reads no rows (or their payloads); it only counts them.
        const rows = this.stop.signal.aborted
            ? []
            : await query
                .clone()
                // The payload is not selected here: a batch holds up to MAX_WEBHOOK_REDRIVE_LIMIT rows but runs
                // REDRIVE_CONCURRENCY replays at a time, so each body is read as its own replay starts.
                // Failed replays move behind rows with fewer attempts, so a bad receiver cannot pin a batch.
                .orderBy('failure.attempts', 'ASC')
                .addOrderBy('failure.createdAt', 'ASC')
                .addOrderBy('failure.id', 'ASC')
                .take(limit)
                .getMany();
        if (rows.length > 0) {
            const webhookIds = [...new Set(rows.map(r => r.webhookId))];
            const webhooks = new Map((await this.webhookRepository.find({ where: { id: (0, typeorm_2.In)(webhookIds) } })).map(w => [w.id, w]));
            const queue = [...rows];
            const worker = async () => {
                for (let row = queue.shift(); row && !this.stop.signal.aborted; row = queue.shift()) {
                    await this.redriveRow(row, webhooks.get(row.webhookId) ?? null, result);
                }
            };
            await Promise.all(Array.from({ length: Math.min(REDRIVE_CONCURRENCY, rows.length) }, worker));
        }
        result.redriven = result.delivered + result.enqueued;
        result.remaining = await query.clone().getCount();
        return result;
    }
    async redriveRow(row, webhook, result) {
        // The row's own session must still own the webhook: a row is never replayed into another session.
        if (!webhook || webhook.sessionId !== row.sessionId || !(0, deliver_once_1.isDeliverableWebhook)(webhook, row.event)) {
            result.skipped++;
            return;
        }
        try {
            const payload = await this.readPayload(row.id);
            if (payload === null) {
                // The row was removed, or lost its copy, between the batch and this replay.
                result.skipped++;
                return;
            }
            const outcome = await this.delivery.redeliver(webhook, row.sessionId, row.event, row.idempotencyKey, payload, {
                singleAttempt: true,
            });
            if (outcome === 'delivered')
                result.delivered++;
            else if (outcome === 'enqueued')
                result.enqueued++;
            else if (outcome === 'cancelled') {
                result.skipped++;
                await this.bumpAttempts(row);
            }
            else {
                result.failed++;
                // A failure the delivery path records raises this row's attempts itself. One it refuses before
                // sending (a body over the payload cap after the hooks) leaves the row as it was, so the attempt is
                // counted here; otherwise that row would head every batch.
                if (outcome !== 'failed' || (await this.attemptsUnchanged(row)))
                    await this.bumpAttempts(row);
            }
        }
        catch (error) {
            result.failed++;
            this.logger.error('Webhook redrive failed', error instanceof Error ? error.message : String(error), {
                webhookId: row.webhookId,
                failureId: row.id,
                action: 'webhook_redrive_error',
            });
            await this.bumpAttempts(row);
        }
    }
    /** The stored event data of one row, or null when the row or its copy is gone. `payload` is select: false. */
    async readPayload(id) {
        const row = await this.failureRepository
            .createQueryBuilder('failure')
            .select('failure.id')
            .addSelect('failure.payload')
            .where('failure.id = :id', { id })
            .getOne();
        return row?.payload ?? null;
    }
    /** Whether the row still carries the attempt count the batch read, that is, nothing recorded the failure. */
    async attemptsUnchanged(row) {
        const current = await this.failureRepository.findOne({
            where: { id: row.id },
            select: { id: true, attempts: true },
        });
        return current !== null && current.attempts === row.attempts;
    }
    /** Count a replay on its retained row so failed or cancelled rows cannot pin the next batch. */
    async bumpAttempts(row) {
        try {
            await this.failureRepository.increment({ id: row.id }, 'attempts', 1);
        }
        catch (error) {
            this.logger.warn('Could not record a failed webhook redrive on its row', {
                failureId: row.id,
                error: error instanceof Error ? error.message : String(error),
                action: 'webhook_redrive_bookkeeping_failed',
            });
        }
    }
};
exports.WebhookRedriveService = WebhookRedriveService;
exports.WebhookRedriveService = WebhookRedriveService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(webhook_entity_1.Webhook, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(webhook_delivery_failure_entity_1.WebhookDeliveryFailure, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        webhook_delivery_service_1.WebhookDeliveryService,
        config_1.ConfigService])
], WebhookRedriveService);
