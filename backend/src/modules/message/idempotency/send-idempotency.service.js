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
exports.SendIdempotencyService = exports.SEND_IDEMPOTENCY_STALE_PENDING_MS = exports.SEND_IDEMPOTENCY_TTL_MS = void 0;
exports.isValidIdempotencyKey = isValidIdempotencyKey;
exports.hashSendRequest = hashSendRequest;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const crypto_1 = require("crypto");
const typeorm_2 = require("typeorm");
const send_idempotency_key_entity_1 = require("../entities/send-idempotency-key.entity");
const db_errors_1 = require("../../../common/utils/db-errors");
const logger_service_1 = require("../../../common/services/logger.service");
/** How long a key stays bound to its first send. Matches the window most HTTP clients retry within. */
exports.SEND_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A 'pending' row older than this is reported as outcome-unknown rather than in-progress: the request
 * that claimed it has almost certainly died with its node. Both answers are 409 and neither sends, so
 * the threshold only changes the code a client sees. Generous, because send pacing can hold a send.
 */
exports.SEND_IDEMPOTENCY_STALE_PENDING_MS = 10 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** RFC-draft key syntax, kept strict so a key is safe to log and store verbatim: 1-255 visible ASCII. */
const KEY_PATTERN = /^[\x21-\x7E]{1,255}$/;
function isValidIdempotencyKey(key) {
    return KEY_PATTERN.test(key);
}
/**
 * Canonical JSON: object keys sorted at every depth, so `{a,b}` and `{b,a}` hash the same. Arrays keep
 * their order, which is meaningful (poll options, contact lists).
 */
function canonicalJson(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(',')}]`;
    const entries = Object.keys(value)
        .sort()
        .filter(k => value[k] !== undefined)
        .map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`);
    return `{${entries.join(',')}}`;
}
/** Fingerprint of one send request: the route plus its canonical body. */
function hashSendRequest(route, body) {
    return (0, crypto_1.createHash)('sha256')
        .update(route)
        .update('\n')
        .update(canonicalJson(body ?? null))
        .digest('hex');
}
/**
 * Storage side of the opt-in `Idempotency-Key` header on the send routes (see
 * SendIdempotencyInterceptor). The claim is a plain INSERT against UNIQUE(sessionId, idempotencyKey),
 * so two concurrent requests with one key, on one node or several sharing the database, cannot both
 * run the send.
 */
let SendIdempotencyService = class SendIdempotencyService {
    keys;
    logger = (0, logger_service_1.createLogger)('SendIdempotency');
    pruneTimer = null;
    constructor(keys) {
        this.keys = keys;
    }
    onModuleInit() {
        this.pruneTimer = setInterval(() => void this.pruneExpired(), PRUNE_INTERVAL_MS);
        this.pruneTimer.unref?.();
    }
    onModuleDestroy() {
        if (this.pruneTimer)
            clearInterval(this.pruneTimer);
        this.pruneTimer = null;
    }
    async claim(input) {
        // Two rounds at most: the second only runs after this call removed an expired row, and a request
        // that wins the freed key in between is then simply the holder.
        for (let round = 0; round < 2; round++) {
            const now = new Date();
            try {
                // A bare INSERT, not save(): save() would wrap it in a transaction and, on Postgres, a failed
                // statement inside one poisons it; the unique violation is the expected answer here.
                const result = await this.keys.insert({
                    sessionId: input.sessionId,
                    idempotencyKey: input.key,
                    route: input.route,
                    requestHash: input.requestHash,
                    state: 'pending',
                    expiresAt: new Date(now.getTime() + exports.SEND_IDEMPOTENCY_TTL_MS),
                });
                return { kind: 'claimed', id: result.identifiers[0].id };
            }
            catch (error) {
                if (!(0, db_errors_1.isUniqueViolation)(error))
                    throw error;
            }
            const existing = await this.keys.findOne({
                where: { sessionId: input.sessionId, idempotencyKey: input.key },
            });
            // Released between our insert and this read: take another round at the insert.
            if (!existing)
                continue;
            if (existing.expiresAt.getTime() <= now.getTime()) {
                await this.keys.delete({ id: existing.id, expiresAt: (0, typeorm_2.LessThan)(now) });
                continue;
            }
            return this.classify(existing, input.requestHash, now);
        }
        return { kind: 'in_progress' };
    }
    classify(row, requestHash, now) {
        if (row.requestHash !== requestHash)
            return { kind: 'mismatch' };
        if (row.state === 'completed')
            return { kind: 'replay', body: row.responseBody };
        if (row.state === 'failed')
            return { kind: 'outcome_unknown' };
        // The claim time is read back from expiresAt, which this service wrote through its own
        // transformer, rather than from the driver-hydrated createdAt.
        const claimedAt = row.expiresAt.getTime() - exports.SEND_IDEMPOTENCY_TTL_MS;
        return now.getTime() - claimedAt > exports.SEND_IDEMPOTENCY_STALE_PENDING_MS
            ? { kind: 'outcome_unknown' }
            : { kind: 'in_progress' };
    }
    /** The send succeeded: store its answer for replay. */
    async complete(id, responseBody) {
        await this.keys.update({ id }, {
            state: 'completed',
            responseBody: responseBody ?? null,
        });
    }
    /** The send was refused before anything reached WhatsApp: free the key for a corrected retry. */
    async release(id) {
        await this.keys.delete({ id, state: 'pending' });
    }
    /** The send failed without saying whether the message went out: keep the key taken. */
    async markFailed(id) {
        await this.keys.update({ id }, { state: 'failed' });
    }
    /** Delete keys past their window. Runs hourly; a claim also clears an expired row it collides with. */
    async pruneExpired(now = new Date()) {
        try {
            const { affected } = await this.keys.delete({ expiresAt: (0, typeorm_2.LessThan)(now) });
            if (affected) {
                this.logger.debug(`Pruned ${affected} expired send idempotency key(s)`, {
                    action: 'send_idempotency_prune',
                });
            }
            return affected ?? 0;
        }
        catch (error) {
            this.logger.warn('Send idempotency key prune failed', {
                error: error instanceof Error ? error.message : String(error),
                action: 'send_idempotency_prune_failed',
            });
            return 0;
        }
    }
};
exports.SendIdempotencyService = SendIdempotencyService;
exports.SendIdempotencyService = SendIdempotencyService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(send_idempotency_key_entity_1.SendIdempotencyKey, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], SendIdempotencyService);
