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
exports.WebhookService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const config_1 = require("@nestjs/config");
const webhook_entity_1 = require("./entities/webhook.entity");
const webhook_delivery_failure_entity_1 = require("./entities/webhook-delivery-failure.entity");
const session_entity_1 = require("../session/entities/session.entity");
const logger_service_1 = require("../../common/services/logger.service");
const session_scope_1 = require("../../common/security/session-scope");
const paginate_1 = require("../../common/utils/paginate");
const idempotency_util_1 = require("./utils/idempotency.util");
const deliver_once_1 = require("./utils/deliver-once");
const ssrf_guard_1 = require("../../common/security/ssrf-guard");
const webhook_delivery_service_1 = require("./webhook-delivery.service");
/**
 * Upper bound on how many webhooks one session can register. One inbound event fans out to EVERY
 * registered webhook of the session, so an unbounded count multiplies per-event payload copies
 * (clones, outbound sockets, queued jobs). Default 16; override with WEBHOOK_MAX_PER_SESSION
 * (0 disables). Only NEW registrations above the cap are refused — existing ones are grandfathered.
 */
const DEFAULT_WEBHOOK_MAX_PER_SESSION = 16;
/**
 * Webhook registration and operational queries: CRUD, the test probe, and the delivery-failure
 * listing/retention. Event delivery itself (fan-out, queueing, retries, dead-lettering) lives on
 * WebhookDeliveryService; dispatch() here is the stable facade every event producer calls.
 */
let WebhookService = class WebhookService {
    webhookRepository;
    failureRepository;
    sessionRepository;
    configService;
    delivery;
    logger = (0, logger_service_1.createLogger)('WebhookService');
    cleanupTimer;
    payloadCleanupTimer;
    constructor(webhookRepository, failureRepository, sessionRepository, configService, delivery) {
        this.webhookRepository = webhookRepository;
        this.failureRepository = failureRepository;
        this.sessionRepository = sessionRepository;
        this.configService = configService;
        this.delivery = delivery;
    }
    /**
     * Periodically prune webhook_delivery_failures older than WEBHOOK_FAILURE_RETENTION_DAYS
     * (default 90; set <= 0 to disable). Runs once at startup, then daily. The table records every
     * failed or unsent delivery (a later successful delivery removes its row), so without this it grows
     * without bound under a receiver outage. (Mirrors AuditService's audit-log retention.)
     */
    onModuleInit() {
        this.schedulePayloadPrune();
        const parsed = Number.parseInt(process.env.WEBHOOK_FAILURE_RETENTION_DAYS ?? '', 10);
        const retentionDays = Number.isInteger(parsed) ? Math.max(0, parsed) : 90;
        if (retentionDays <= 0) {
            this.logger.log('Webhook delivery-failure retention disabled (WEBHOOK_FAILURE_RETENTION_DAYS <= 0)');
            return;
        }
        const runPrune = () => {
            this.pruneDeliveryFailures(retentionDays)
                .then(n => {
                if (n > 0)
                    this.logger.log(`Pruned ${n} webhook delivery-failure(s) older than ${retentionDays} day(s)`);
            })
                .catch(err => this.logger.error('Webhook delivery-failure cleanup failed', err instanceof Error ? err.stack : String(err)));
        };
        runPrune(); // prune once at startup
        this.cleanupTimer = setInterval(runPrune, 24 * 60 * 60 * 1000);
        this.cleanupTimer.unref?.();
    }
    onModuleDestroy() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
        if (this.payloadCleanupTimer) {
            clearInterval(this.payloadCleanupTimer);
        }
    }
    /**
     * Delete delivery-failure rows older than the retention window. Returns the number removed.
     */
    async pruneDeliveryFailures(olderThanDays) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);
        const result = await this.failureRepository.delete({ createdAt: (0, typeorm_2.LessThan)(cutoff) });
        return result.affected || 0;
    }
    /**
     * Clear the replay payload of every failure row recorded more than `olderThanHours` ago; the row
     * itself stays for WEBHOOK_FAILURE_RETENTION_DAYS. 0 clears every stored payload. Returns the
     * number of rows cleared.
     */
    async pruneDeliveryFailurePayloads(olderThanHours) {
        const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
        const result = await this.failureRepository.update({ payload: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()), createdAt: (0, typeorm_2.LessThan)(cutoff) }, { payload: null });
        return result.affected || 0;
    }
    /**
     * WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS bounds how long a failure row holds a whole event body.
     * With the knob on, expired payloads are cleared at startup and then hourly. With it off (0, the
     * default) nothing new is stored, and one startup pass clears what an earlier setting left behind,
     * so turning the feature off also stops keeping the bodies it already stored.
     */
    schedulePayloadPrune() {
        const hours = this.configService.get('webhook.failurePayloadRetentionHours', 0);
        const runPrune = () => {
            this.pruneDeliveryFailurePayloads(hours)
                .then(n => {
                if (n > 0)
                    this.logger.log(`Cleared the replay payload of ${n} webhook delivery-failure(s)`);
            })
                .catch(err => this.logger.error('Webhook delivery-failure payload cleanup failed', err instanceof Error ? err.stack : String(err)));
        };
        runPrune();
        if (hours > 0) {
            this.payloadCleanupTimer = setInterval(runPrune, 60 * 60 * 1000);
            this.payloadCleanupTimer.unref?.();
        }
    }
    /**
     * Reject an internal/unsafe webhook URL at registration, so a bad URL fails
     * synchronously with a 400 instead of silently failing at delivery time. Honors the same
     * SSRF flag + SSRF_ALLOWED_HOSTS escape-hatch as delivery. Maps the guard error to 400.
     */
    async validateWebhookUrl(url) {
        // Credentials embedded in the URL (https://user:pass@host/hook) would be persisted with the row
        // and echoed into delivery logs and dead-letter rows, and are never legitimate for a webhook
        // target — reject outright rather than strip-and-accept. Runs regardless of the SSRF flag.
        let parsed = null;
        try {
            parsed = new URL(url);
        }
        catch {
            // Unparseable: @IsUrl on the DTO (and the SSRF guard when enabled) owns that rejection.
        }
        if (parsed && (parsed.username !== '' || parsed.password !== '')) {
            throw new common_1.BadRequestException('Webhook URL must not contain credentials (userinfo)');
        }
        if (!(0, ssrf_guard_1.isSsrfProtectionEnabled)())
            return;
        try {
            await (0, ssrf_guard_1.assertSafeFetchUrl)(url);
        }
        catch (error) {
            if (error instanceof ssrf_guard_1.SsrfBlockedError) {
                // The raw message names the resolved internal IP (a recon oracle): log it server-side, return generic.
                this.logger.warn(`Webhook URL rejected by SSRF guard: ${error.message}`);
                throw new common_1.BadRequestException(ssrf_guard_1.SSRF_BLOCKED_CLIENT_MESSAGE);
            }
            throw error;
        }
    }
    async create(sessionId, dto) {
        // The webhooks.sessionId FK makes a missing session surface as a driver error (500) at save time;
        // check first so the caller gets a truthful 404 for a session that does not exist.
        const sessionExists = await this.sessionRepository.exists({ where: { id: sessionId } });
        if (!sessionExists) {
            throw new common_1.NotFoundException(`Session with id '${sessionId}' not found`);
        }
        await this.validateWebhookUrl(dto.url);
        // Per-session fan-out cap. Soft by design: a concurrent create can race the count check — the
        // cap bounds amplification, it is not a hard invariant. Webhooks already above the cap are left
        // alone; only NEW registrations are refused.
        const maxPerSession = this.configService.get('webhook.maxPerSession', DEFAULT_WEBHOOK_MAX_PER_SESSION);
        if (maxPerSession > 0) {
            const existing = await this.webhookRepository.count({ where: { sessionId } });
            if (existing >= maxPerSession) {
                throw new common_1.BadRequestException(`Webhook limit reached for this session (${existing}/${maxPerSession}); delete one before registering another`);
            }
        }
        const webhook = this.webhookRepository.create({
            sessionId,
            url: dto.url,
            events: dto.events || ['message.received'],
            secret: dto.secret || null,
            headers: dto.headers || {},
            filters: dto.filters ?? null,
            retryCount: dto.retryCount ?? 3,
        });
        // No transaction of its own: the session can be deleted while the URL is checked, and on SQLite's single shared
        // connection the rollback of the foreign key failure would discard what other callers wrote while it was open.
        const saved = await this.webhookRepository.save(webhook, { transaction: false });
        this.delivery.invalidateOptInSubscriptions(sessionId);
        return saved;
    }
    async findBySession(sessionId) {
        return this.webhookRepository.find({
            where: { sessionId },
            order: { createdAt: 'DESC' },
        });
    }
    async findAll(allowedSessions, opts = {}) {
        // A session-restricted key only sees its own sessions' webhooks; an unrestricted key
        // (null/empty allowlist, e.g. ADMIN) sees all — mirroring the ApiKeyGuard allowedSessions model.
        const { limit, offset } = (0, paginate_1.resolveListWindow)(opts.limit, opts.offset);
        // `id` tiebreaks the second-resolution `createdAt` so a paged walk has a total order.
        const options = {
            order: { createdAt: 'DESC', id: 'DESC' },
            take: limit,
            skip: offset,
        };
        if (allowedSessions && allowedSessions.length > 0) {
            options.where = { sessionId: (0, typeorm_2.In)(allowedSessions) };
        }
        return this.webhookRepository.find(options);
    }
    /**
     * Recently-failed webhook deliveries (most recent first), so an operator can see what was lost during
     * a receiver outage. ADMIN-only operational data; an optional sessionId narrows it. Bounded by the
     * shared pagination window. The calling key's allowedSessions is authoritative — the sessionId query
     * param may only narrow within it — because this endpoint takes sessionId as a query param, which the
     * ApiKeyGuard fence (route params only) does not scope; otherwise a session-restricted key could read
     * every session's failed-delivery URLs and errors.
     */
    async listDeliveryFailures(opts = {}, allowedSessions) {
        const { limit, offset } = (0, paginate_1.resolveListWindow)(opts.limit, opts.offset);
        const sessionScope = (0, session_scope_1.resolveSessionScope)(allowedSessions, opts.sessionId);
        if (sessionScope !== null && sessionScope.length === 0)
            return []; // requested session outside the key's scope
        const rows = await this.failureRepository.find({
            where: sessionScope ? { sessionId: (0, typeorm_2.In)(sessionScope) } : {},
            // A receiver outage writes a burst of failures inside one second; `id` keeps the page order total.
            order: { createdAt: 'DESC', id: 'DESC' },
            take: limit,
            skip: offset,
        });
        // `payload` is select: false, so the page above never carries an event body. Which rows hold one
        // is a second, id-only read; with payload retention off no row does and it matches nothing.
        const replayable = new Set();
        const hours = this.configService.get('webhook.failurePayloadRetentionHours', 0);
        if (rows.length > 0 && hours > 0) {
            const withPayload = await this.failureRepository.find({
                select: { id: true },
                where: {
                    id: (0, typeorm_2.In)(rows.map(r => r.id)),
                    payload: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()),
                    attempts: (0, typeorm_2.MoreThan)(0),
                    idempotencyKey: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()),
                    createdAt: (0, typeorm_2.MoreThan)(new Date(Date.now() - hours * 60 * 60 * 1000)),
                },
            });
            for (const r of withPayload)
                replayable.add(r.id);
        }
        // The redrive replays a row only to the webhook it was recorded for, in the row's own session. A disabled or
        // unsubscribed webhook can be switched back, so its rows stay replayable; a deleted one never comes back.
        const held = rows.filter(r => replayable.has(r.id));
        if (held.length > 0) {
            const owners = await this.webhookRepository.find({
                select: { id: true, sessionId: true },
                where: { id: (0, typeorm_2.In)([...new Set(held.map(r => r.webhookId))]) },
            });
            const sessionOf = new Map(owners.map(w => [w.id, w.sessionId]));
            for (const r of held)
                if (sessionOf.get(r.webhookId) !== r.sessionId)
                    replayable.delete(r.id);
        }
        return rows.map(r => Object.assign(r, { replayable: replayable.has(r.id) }));
    }
    async findOne(sessionId, id) {
        // Scope by the URL's sessionId so one session cannot read/act on another's webhook by id.
        // A wrong-session id resolves to not-found (no cross-session existence oracle).
        const webhook = await this.webhookRepository.findOne({ where: { id, sessionId } });
        if (!webhook) {
            throw new common_1.NotFoundException(`Webhook with id '${id}' not found`);
        }
        return webhook;
    }
    async update(sessionId, id, dto) {
        const webhook = await this.findOne(sessionId, id);
        const patch = {};
        // An unchanged URL is not re-validated: every edit re-sends it, so a webhook whose host stopped
        // resolving or became SSRF-blocked could not otherwise be deactivated or re-filtered. Delivery
        // still checks the URL on every send.
        if (dto.url !== undefined && dto.url !== webhook.url) {
            await this.validateWebhookUrl(dto.url);
            patch.url = dto.url;
        }
        if (dto.events !== undefined)
            patch.events = dto.events;
        // Normalize empty string to null (parity with create) — an empty secret means "no HMAC",
        // not a stored blank that silently disables signing while looking configured.
        if (dto.secret !== undefined)
            patch.secret = dto.secret || null;
        if (dto.headers !== undefined)
            patch.headers = dto.headers;
        if (dto.filters !== undefined)
            patch.filters = dto.filters;
        if (dto.active !== undefined)
            patch.active = dto.active;
        if (dto.retryCount !== undefined)
            patch.retryCount = dto.retryCount;
        if (Object.keys(patch).length === 0)
            return webhook;
        // A conditional UPDATE of the carried fields, not save() of the entity read above: save() would
        // re-insert a row a concurrent DELETE removed during the URL check, and write back stale values
        // of every column this request did not touch.
        const result = await this.webhookRepository.update({ id, sessionId }, patch);
        this.delivery.invalidateOptInSubscriptions(sessionId);
        if (!result.affected)
            throw new common_1.NotFoundException(`Webhook with id '${id}' not found`);
        return this.findOne(sessionId, id);
    }
    async delete(sessionId, id) {
        const webhook = await this.findOne(sessionId, id);
        await this.webhookRepository.remove(webhook);
        this.delivery.invalidateOptInSubscriptions(sessionId);
    }
    async test(sessionId, webhookId) {
        const webhook = await this.findOne(sessionId, webhookId);
        // Every test is a new event: a key derived from the webhook alone repeats on every call, so a
        // receiver that dedups on it acknowledges the second test without running its handler.
        const deliveryId = (0, idempotency_util_1.generateDeliveryId)();
        const testPayload = {
            event: 'test',
            timestamp: new Date().toISOString(),
            sessionId,
            idempotencyKey: `test_${deliveryId}_${webhook.id}`,
            deliveryId,
            data: {
                message: 'This is a test webhook from OpenWA',
                webhookId: webhook.id,
                url: webhook.url,
            },
        };
        const body = JSON.stringify(testPayload);
        // The same header builder as a real delivery, so the probe tests what the receiver will get.
        const headers = (0, deliver_once_1.buildDeliveryHeaders)(webhook, 'test', testPayload.idempotencyKey, deliveryId, body);
        try {
            return await (0, ssrf_guard_1.withSafeFetch)(webhook.url, {
                method: 'POST',
                headers,
                body,
                // Use the configured WEBHOOK_TIMEOUT (single source of truth across queued/test/direct paths).
                signal: AbortSignal.timeout(this.configService.get('webhook.timeout', 10000)),
            }, response => ({ success: response.ok, statusCode: response.status }), { guard: (0, ssrf_guard_1.isSsrfProtectionEnabled)() });
        }
        catch (error) {
            return {
                success: false,
                error: (0, ssrf_guard_1.redactSsrfError)(error, this.logger, 'webhook test'),
            };
        }
    }
    /**
     * Delivery facade: same entry point event producers have always called; the engine lives on
     * WebhookDeliveryService. Not async on purpose: a frame suspended on the engine would keep the
     * unshed event alive until every delivery settles.
     */
    dispatch(sessionId, event, data) {
        return this.delivery.dispatch(sessionId, event, data);
    }
};
exports.WebhookService = WebhookService;
exports.WebhookService = WebhookService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(webhook_entity_1.Webhook, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(webhook_delivery_failure_entity_1.WebhookDeliveryFailure, 'data')),
    __param(2, (0, typeorm_1.InjectRepository)(session_entity_1.Session, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        config_1.ConfigService,
        webhook_delivery_service_1.WebhookDeliveryService])
], WebhookService);
