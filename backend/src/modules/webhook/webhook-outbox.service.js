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
exports.WebhookOutboxService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const webhook_outbox_event_entity_1 = require("./entities/webhook-outbox-event.entity");
const logger_service_1 = require("../../common/services/logger.service");
const db_errors_1 = require("../../common/utils/db-errors");
const DEFAULT_OUTBOX_RETENTION_DAYS = 7;
/**
 * Row lifecycle for the outbound delivery record.
 *
 * Every write here is best-effort and swallowed: fan-out is fire-and-forget from the projector, so
 * a repository failure must not turn into an unhandled rejection or stop a delivery that would
 * otherwise succeed. Losing the record degrades to the behaviour that existed before it.
 */
let WebhookOutboxService = class WebhookOutboxService {
    outbox;
    logger = (0, logger_service_1.createLogger)('WebhookOutboxService');
    pruneTimer;
    constructor(outbox) {
        this.outbox = outbox;
    }
    /**
     * Prune settled rows daily, so the record of every delivery this gateway ever made does not
     * become the largest table in the database.
     *
     * Deliberately NOT tied to the delivery-failure retention switch: a settled row carries no
     * payload and no audit value (the failure table is the record that matters), so letting an
     * operator opt into unbounded growth here buys nothing. A non-positive value falls back to the
     * default with a warning, the same call the ingress dedup log makes.
     *
     * Only SETTLED rows are pruned. A 'pending' row is a delivery that can still be replayed, and
     * deleting one on age would discard the very thing this table exists to protect.
     */
    onModuleInit() {
        const parsed = Number.parseInt(process.env.WEBHOOK_OUTBOX_RETENTION_DAYS ?? '', 10);
        let days = Number.isInteger(parsed) ? parsed : DEFAULT_OUTBOX_RETENTION_DAYS;
        if (days <= 0) {
            this.logger.warn(`WEBHOOK_OUTBOX_RETENTION_DAYS=${String(process.env.WEBHOOK_OUTBOX_RETENTION_DAYS)} would let the ` +
                `outbound delivery record grow without bound; falling back to ${DEFAULT_OUTBOX_RETENTION_DAYS} days`);
            days = DEFAULT_OUTBOX_RETENTION_DAYS;
        }
        const run = () => {
            this.pruneSettled(days)
                .then(n => {
                if (n > 0)
                    this.logger.log(`Pruned ${n} settled outbound delivery record(s) older than ${days} day(s)`);
            })
                .catch(err => this.logger.error('Outbound delivery record prune failed', String(err)));
        };
        run();
        this.pruneTimer = setInterval(run, 24 * 60 * 60 * 1000);
        this.pruneTimer.unref?.();
    }
    onModuleDestroy() {
        if (this.pruneTimer)
            clearInterval(this.pruneTimer);
    }
    /** Delete settled rows older than the window. Returns the number removed. */
    async pruneSettled(olderThanDays) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - olderThanDays);
        const result = await this.outbox.delete({ state: (0, typeorm_2.Not)((0, typeorm_2.In)(['pending', 'queued'])), createdAt: (0, typeorm_2.LessThan)(cutoff) });
        return result.affected || 0;
    }
    /**
     * Record the delivery as pending, before anything durable owns it.
     *
     * A conflict on (webhookId, idempotencyKey) means this exact delivery is being replayed, so the
     * existing row is kept rather than duplicated: the stored key is what makes the retry
     * deduplicable at the receiver.
     */
    async open(row) {
        try {
            // A bare INSERT, not save(): save() wraps it in a transaction, and on SQLite's single shared
            // connection the rollback of the unique violation expected here would also discard any other
            // write made while it was open.
            await this.outbox.insert({
                webhookId: row.webhookId,
                sessionId: row.sessionId,
                event: row.event,
                idempotencyKey: row.idempotencyKey,
                deliveryId: row.deliveryId,
                payload: row.payload,
                state: 'pending',
                attempts: 0,
            });
        }
        catch (error) {
            // A conflict means this exact delivery is already recorded, which is what a replay looks
            // like: keep the existing row rather than duplicating it.
            if ((0, db_errors_1.isUniqueViolation)(error))
                return;
            this.logger.warn(`Could not record outbound delivery ${row.deliveryId}: ${String(error)}`);
        }
    }
    /** Retire replay data after successful delivery, cancellation or durable failure handoff. */
    async close(webhookId, idempotencyKey, state) {
        try {
            await this.outbox.update({ webhookId, idempotencyKey }, { state, payload: null, lastAttemptAt: new Date() });
        }
        catch (error) {
            this.logger.warn(`Could not close outbound delivery record: ${String(error)}`);
        }
    }
    /** Keep the queue's replay copy until the worker has settled the delivery. */
    async markQueued(webhookId, idempotencyKey, deliveryId) {
        try {
            await this.outbox.update({ webhookId, idempotencyKey, state: (0, typeorm_2.In)(['pending', 'queued']), payload: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()) }, { state: 'queued', deliveryId, lastAttemptAt: new Date() });
        }
        catch (error) {
            this.logger.warn(`Could not record queued outbound delivery: ${String(error)}`);
        }
    }
    /**
     * Unsettled rows older than the staleness window; queued jobs are checked before replay.
     *
     * A stored payload that does not parse (an imported or hand-edited row on SQLite, where it is text)
     * fails the read of every page it sits in, so no row behind it would ever be replayed. When the page
     * read fails it is read again row by row, an unreadable row is logged and skipped, and `onScanned`
     * receives the last id the page covered so a caller's cursor passes the unreadable rows too.
     */
    async findStale(olderThan, limit, afterId, onScanned) {
        const pending = { state: (0, typeorm_2.In)(['pending', 'queued']), payload: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()), createdAt: (0, typeorm_2.LessThan)(olderThan) };
        const where = afterId
            ? {
                ...pending,
                // Compare in SQL so PostgreSQL's sub-millisecond timestamps are never rounded through Date.
                createdAt: (0, typeorm_2.And)((0, typeorm_2.LessThan)(olderThan), (0, typeorm_2.Raw)(alias => `(${alias}, "id") > (SELECT "createdAt", "id" FROM "webhook_outbox_events" WHERE "id" = :afterId)`, { afterId })),
            }
            : pending;
        const order = { createdAt: 'ASC', id: 'ASC' };
        let rows;
        try {
            rows = await this.outbox.find({ where, order, take: limit });
        }
        catch (error) {
            this.logger.warn('Reading a page of stranded deliveries failed; reading it row by row', {
                error: error instanceof Error ? error.message : String(error),
                action: 'webhook_outbox_page_unreadable',
            });
            const ids = await this.outbox.find({ select: { id: true }, where, order, take: limit });
            rows = [];
            for (const { id } of ids) {
                try {
                    const row = await this.outbox.findOneBy({ id });
                    if (row)
                        rows.push(row);
                }
                catch (rowError) {
                    this.logger.error('A stranded delivery could not be read and is skipped', rowError instanceof Error ? rowError.message : String(rowError), { id, action: 'webhook_outbox_row_unreadable' });
                }
            }
            const last = ids.at(-1);
            if (last)
                onScanned?.(last.id);
        }
        // A pending row always carries its payload; the guard is for a row whose payload was retired by
        // a concurrent close between the query and this read.
        return rows
            .filter((r) => r.payload !== null)
            .map(r => ({
            id: r.id,
            webhookId: r.webhookId,
            sessionId: r.sessionId,
            event: r.event,
            idempotencyKey: r.idempotencyKey,
            payload: r.payload,
            attempts: r.attempts,
            deliveryId: r.deliveryId,
            state: r.state,
        }));
    }
    /**
     * Count one replay attempt against the row's budget.
     *
     * Returns false when the row is no longer pending: the sweep reads its batch once, so a delivery
     * that settled after that read must not be replayed from the stale copy. A failed write returns
     * true, keeping the replay best-effort like every other write here.
     */
    async countAttempt(id, attempts) {
        try {
            const result = await this.outbox.update({ id, state: (0, typeorm_2.In)(['pending', 'queued']) }, { attempts: attempts + 1, lastAttemptAt: new Date() });
            return (result.affected ?? 0) > 0;
        }
        catch (error) {
            this.logger.warn(`Could not count a replay attempt: ${String(error)}`);
            return true;
        }
    }
};
exports.WebhookOutboxService = WebhookOutboxService;
exports.WebhookOutboxService = WebhookOutboxService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(webhook_outbox_event_entity_1.WebhookOutboxEvent, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], WebhookOutboxService);
