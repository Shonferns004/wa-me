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
exports.RedriveService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const integration_delivery_failure_entity_1 = require("./entities/integration-delivery-failure.entity");
const ingress_event_entity_1 = require("./entities/ingress-event.entity");
const ingress_enqueue_service_1 = require("./ingress-enqueue.service");
const ordering_lock_1 = require("./ordering-lock");
const integration_constants_1 = require("./integration.constants");
const logger_service_1 = require("../../common/services/logger.service");
const plugin_activation_1 = require("../../core/plugins/plugin-activation");
const REDRIVE_BATCH_SIZE = 100;
let RedriveService = class RedriveService {
    repo;
    events;
    ingressEnqueue;
    logger = (0, logger_service_1.createLogger)('IntegrationRedrive');
    lock = new ordering_lock_1.KeyedAsyncLock();
    // Aborted on destroy: a batch in progress takes no further row.
    stop = new AbortController();
    inFlight = new Set();
    constructor(repo, events, ingressEnqueue) {
        this.repo = repo;
        this.events = events;
        this.ingressEnqueue = ingressEnqueue;
    }
    /**
     * A redrive runs inside an admitted HTTP request, which shutdown lets finish, and nothing else waits
     * for it: left alone it would go on replaying while the plugins are disabled and the database closes,
     * raising the attempts of rows no live plugin ever saw. Stop at the next row and wait for the replay
     * in hand, as the webhook redrive and the ingress reconciler do. Rows not reached stay open and are
     * counted in `remaining`.
     */
    async onModuleDestroy() {
        this.stop.abort();
        if (this.inFlight.size === 0)
            return;
        let timer;
        const settled = await Promise.race([
            Promise.allSettled([...this.inFlight]).then(() => true),
            new Promise(resolve => (timer = setTimeout(resolve, integration_constants_1.INGRESS_DISPATCH_TIMEOUT_MS, false))),
        ]);
        clearTimeout(timer);
        if (!settled) {
            this.logger.warn('Ingress redrive still running at shutdown; continuing without it', {
                waitMs: integration_constants_1.INGRESS_DISPATCH_TIMEOUT_MS,
                action: 'ingress_redrive_shutdown_timeout',
            });
        }
    }
    /**
     * `sessionScope` is the instance's CURRENT binding (null or '*' for all sessions). Only rows written under
     * that binding are replayed or counted: dispatch refuses a delivery whose instance was bound to another
     * session since, so a row of an earlier binding would be retired here and dead-lettered again by its job.
     */
    redriveInstance(pluginId, instanceId, sessionScope) {
        const run = this.lock.run(`redrive:${pluginId}:${instanceId}`, () => this.redriveBatch(pluginId, instanceId, sessionScope));
        this.inFlight.add(run);
        const forget = () => void this.inFlight.delete(run);
        run.then(forget, forget);
        return run;
    }
    async redriveBatch(pluginId, instanceId, sessionScope) {
        const base = { pluginId, instanceId, direction: 'inbound', redriven: false };
        // A job of the all-sessions scope carries no session or '*', whichever way it was stored.
        const where = (0, plugin_activation_1.isAllSessionsScope)(sessionScope)
            ? [
                { ...base, sessionId: (0, typeorm_2.IsNull)() },
                { ...base, sessionId: '*' },
            ]
            : { ...base, sessionId: sessionScope };
        // Failed replays increment attempts and move behind never-retried rows, preventing one permanent
        // failure from livelocking the bounded window while keeping it redrivable.
        const order = { attempts: 'ASC', createdAt: 'ASC' };
        let rows;
        try {
            rows = await this.repo.find({ where, order, take: REDRIVE_BATCH_SIZE });
        }
        catch (err) {
            // A stored payload that does not parse (an imported or hand-edited dead letter) fails the read of
            // the whole window, and it heads the window for good since it is never replayed, so every redrive
            // of the instance would fail with it. Read the window again row by row and skip the unreadable one.
            this.logger.warn('Reading the dead letters of an instance failed; reading them row by row', {
                pluginId,
                instanceId,
                error: err instanceof Error ? err.message : String(err),
                action: 'ingress_redrive_window_unreadable',
            });
            const ids = await this.repo.find({ select: { id: true }, where, order, take: REDRIVE_BATCH_SIZE });
            rows = [];
            for (const { id } of ids) {
                try {
                    const row = await this.repo.findOneBy({ id });
                    if (row)
                        rows.push(row);
                }
                catch (rowError) {
                    this.logger.error('A dead letter could not be read and is skipped', rowError instanceof Error ? rowError.message : String(rowError), { id, action: 'ingress_redrive_row_unreadable' });
                    // Counted as a failed replay, by id and so without reading the payload: left at attempts 0 it
                    // heads every window for good, and a batch of them would starve the rows behind it.
                    await this.repo.increment({ id }, 'attempts', 1).catch(() => undefined);
                }
            }
        }
        let redriven = 0;
        for (const row of rows) {
            if (this.stop.signal.aborted)
                break;
            const stored = (row.payload ?? {});
            // Re-mint a jobId so BullMQ accepts the replay even if the original jobId lingers.
            const jobId = `redrive:${row.id}`;
            // Given the stop signal, enqueue() throws instead of dispatching inline once it has aborted: the
            // row is left open and unchanged, since the plugin may already be torn down.
            const result = await this.ingressEnqueue
                .enqueue({
                pluginId,
                instanceId,
                route: stored.route ?? '',
                method: stored.method ?? 'POST',
                deliveryId: row.deliveryId ?? row.id,
                sessionId: row.sessionId ?? undefined,
                providerConversationId: stored.providerConversationId,
                payload: stored.ingress,
            }, jobId, this.stop.signal)
                .catch(err => {
                if (this.stop.signal.aborted)
                    return undefined;
                throw err;
            });
            if (!result)
                break;
            const { outcome, error } = result;
            // Only retire the DLQ row once the replay was actually accepted (queued) or delivered. A swallowed
            // inline-dispatch failure ('failed') leaves the row redriven=false so it stays redrivable, instead
            // of silently marking it handled and permanently losing the event.
            if (outcome !== 'failed') {
                // Retire the matching ingress_events row FIRST (mirrors the reconciler's own ordering): a
                // live-path inline failure leaves that row 'pending' next to this DLQ row, so without the mark
                // the reconciler would sweep and replay the same delivery — a double delivery to the plugin.
                // Conditional on 'pending' so a row the reconciler already closed is left alone; a legacy DLQ
                // row (deliveryId null) predates persist-before-ack and has no event row to retire.
                if (row.deliveryId) {
                    await this.events.update({ pluginId, instanceId, providerDeliveryId: row.deliveryId, dispatchState: 'pending' }, { dispatchState: 'dispatched', lastDispatchAt: new Date(), payload: null });
                }
                await this.repo.update({ id: row.id }, { redriven: true });
                redriven++;
            }
            else {
                await this.repo.update({ id: row.id }, { attempts: Math.max(0, row.attempts ?? 0) + 1, lastError: error ?? 'redrive dispatch failed' });
            }
        }
        const remaining = await this.repo.count({ where });
        return { redriven, remaining, batchSize: REDRIVE_BATCH_SIZE };
    }
};
exports.RedriveService = RedriveService;
exports.RedriveService = RedriveService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(integration_delivery_failure_entity_1.IntegrationDeliveryFailure, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(ingress_event_entity_1.IngressEvent, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        ingress_enqueue_service_1.IngressEnqueueService])
], RedriveService);
