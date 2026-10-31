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
exports.PendingMessageReaperService = void 0;
exports.resolvePendingMessageReaperOptions = resolvePendingMessageReaperOptions;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const message_entity_1 = require("./entities/message.entity");
const hooks_1 = require("../../core/hooks");
const logger_service_1 = require("../../common/services/logger.service");
const configuration_1 = require("../../config/configuration");
function resolvePendingMessageReaperOptions(env = process.env) {
    const batch = Number(env.MESSAGE_REAPER_BATCH_SIZE);
    return {
        intervalMs: (0, configuration_1.resolveNonNegativeIntEnv)(env.MESSAGE_REAPER_INTERVAL_MS, 10 * 60_000),
        graceMs: (0, configuration_1.resolveNonNegativeIntEnv)(env.MESSAGE_REAPER_GRACE_MS, 60 * 60_000),
        batchSize: Number.isInteger(batch) && batch >= 1 ? batch : 50,
    };
}
/**
 * Closes the crash window of the outbound persist-before-send flow. Every sender saves the row
 * PENDING before handing it to the engine and transitions it to SENT/FAILED right after; a process
 * crash between those two writes strands the row PENDING forever — it sits in the messages table,
 * and in any search provider's index fed by `message:persisted`, as a message that never resolves.
 *
 * The reaper sweeps small batches of stale outgoing PENDING rows (older than the grace window),
 * marks them FAILED with a `reapedAt` metadata marker (distinguishable from a genuine send failure
 * without a new column), and re-emits `message:persisted` for each — the same emission MessageService
 * performs for every persisted outbound state — so a provider's copy reconciles to the terminal
 * state instead of staying stuck at the initial PENDING write.
 *
 * Same timer lifecycle as IngressReconcilerService: a raw unref'd setInterval started on module init
 * (first sweep after one interval) and cleared on destroy. Destroy also stops a pass in flight and
 * waits for it. Young PENDING rows (a send still in flight) and non-outgoing rows are never touched.
 */
let PendingMessageReaperService = class PendingMessageReaperService {
    messages;
    hookManager;
    logger = (0, logger_service_1.createLogger)('PendingMessageReaperService');
    timer;
    // The pass in flight, settled when it ends; doubles as the overlap guard.
    inFlight;
    stopping = false;
    constructor(messages, hookManager) {
        this.messages = messages;
        this.hookManager = hookManager;
    }
    onModuleInit() {
        const opts = resolvePendingMessageReaperOptions();
        if (opts.intervalMs <= 0) {
            this.logger.log('Pending message reaper disabled (MESSAGE_REAPER_INTERVAL_MS=0)');
            return;
        }
        this.timer = setInterval(() => {
            this.sweep(opts).catch(err => this.logger.error('Pending message reaper sweep failed', err instanceof Error ? err.stack : String(err)));
        }, opts.intervalMs);
        this.timer.unref?.();
    }
    /**
     * Clearing the interval only stops the NEXT pass. A pass already running would go on writing
     * FAILED rows while plugins unregister their hooks and the DataSource closes, so its re-emitted
     * `message:persisted` reaches no handler and the provider's copy stays PENDING for good (the
     * reaper never revisits a FAILED row). Stop it at the next row and wait for the row in hand.
     */
    async onModuleDestroy() {
        this.stopping = true;
        if (this.timer)
            clearInterval(this.timer);
        await this.inFlight;
    }
    /**
     * One bounded pass over the stale outgoing-PENDING backlog. Overlap-guarded: a slow sweep never
     * stacks a second pass on top of itself. Each reap write is guarded on the row still being
     * PENDING, so a send that resolves between the find and the write keeps its own outcome.
     */
    async sweep(opts, now = new Date()) {
        const stats = { scanned: 0, reaped: 0, failed: 0 };
        if (this.inFlight || this.stopping)
            return stats;
        let settle;
        this.inFlight = new Promise(resolve => (settle = resolve));
        try {
            const cutoff = new Date(now.getTime() - opts.graceMs);
            const rows = await this.messages.find({
                where: {
                    direction: message_entity_1.MessageDirection.OUTGOING,
                    status: message_entity_1.MessageStatus.PENDING,
                    createdAt: (0, typeorm_2.LessThan)(cutoff),
                },
                order: { createdAt: 'ASC' },
                take: opts.batchSize,
            });
            for (const row of rows) {
                if (this.stopping)
                    break;
                stats.scanned++;
                try {
                    if (await this.reapRow(row, now)) {
                        stats.reaped++;
                    }
                }
                catch (err) {
                    // A bookkeeping failure (repo update) must not abort the batch; the row stays PENDING and
                    // is retried next sweep.
                    this.logger.error('Reaping a stuck pending message failed', err instanceof Error ? err.message : String(err), { messageId: row.id, sessionId: row.sessionId, action: 'pending_message_reap_failed' });
                    stats.failed++;
                }
            }
            if (stats.reaped > 0) {
                this.logger.log(`Reaped ${stats.reaped} outbound message(s) stuck PENDING past the grace window`, {
                    action: 'pending_messages_reaped',
                });
            }
            return stats;
        }
        finally {
            this.inFlight = undefined;
            settle();
        }
    }
    async reapRow(row, now) {
        // A reaped row is terminal: it is never retried and its media is never rendered, so drop the
        // base64 payload exactly as MessageService.saveFailedMessage does for a genuine send failure —
        // keeping a multi-MB payload in a terminal row only bloats the messages table. The reapedAt
        // marker tells the reaper's FAILED apart from a real send failure.
        const media = row.metadata?.media;
        if (media) {
            delete media.data;
        }
        row.metadata = { ...(row.metadata ?? {}), reapedAt: now.toISOString() };
        row.status = message_entity_1.MessageStatus.FAILED;
        // The guard lives IN the UPDATE: a send that resolved between this sweep's find() and this
        // write has already persisted its own SENT + waMessageId, and a blind save would clobber that
        // terminal outcome back to FAILED/null. Zero affected rows = the live path won the race —
        // leave the row alone and skip the emission below.
        const reaped = await this.messages.update({ id: row.id, status: message_entity_1.MessageStatus.PENDING }, {
            status: row.status,
            metadata: row.metadata,
        });
        if (!reaped.affected) {
            return false;
        }
        // Reconcile provider copies of the earlier PENDING emission: fire-and-forget with a shallow
        // snapshot, the exact shape of MessageService.emitPersisted — a plugin handler must never
        // break the sweep.
        void this.hookManager
            .execute('message:persisted', { sessionId: row.sessionId, message: { ...row } }, { sessionId: row.sessionId, source: 'PendingMessageReaperService' })
            .catch(() => undefined);
        return true;
    }
};
exports.PendingMessageReaperService = PendingMessageReaperService;
exports.PendingMessageReaperService = PendingMessageReaperService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(message_entity_1.Message, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        hooks_1.HookManager])
], PendingMessageReaperService);
