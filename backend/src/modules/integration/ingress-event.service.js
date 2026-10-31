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
exports.IngressEventService = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const ingress_event_entity_1 = require("./entities/ingress-event.entity");
const db_errors_1 = require("../../common/utils/db-errors");
let IngressEventService = class IngressEventService {
    repo;
    constructor(repo) {
        this.repo = repo;
    }
    // Persist-before-ack + dedup. true = newly recorded (enqueue it); false = duplicate (drop, already handled).
    // New rows are stamped 'pending' EXPLICITLY (no DB default on dispatchState) so rows that predate the
    // dispatch columns on a synchronize-bootstrapped DB stay NULL = "not watched" and an upgrade can never
    // mass-replay the historical dedup log.
    async recordOrSkip(input) {
        try {
            await this.repo.insert({ id: (0, node_crypto_1.randomUUID)(), ...input, dispatchState: 'pending' });
            return true;
        }
        catch (err) {
            if ((0, db_errors_1.isUniqueViolation)(err))
                return false;
            throw err;
        }
    }
    /**
     * Record the enqueue outcome on the persisted event. 'queued'/'dispatched' mean the event reached
     * the dispatch tier → 'dispatched' (a later in-tier failure dead-letters via the processor/DLQ, not
     * this row) — and the full payload is retired to NULL: the dispatch tier now owns it (the BullMQ job
     * data, or the DLQ row on failure), so the dedup row slims down to its hash + metadata. 'failed'
     * (the swallowed inline-dispatch failure) bumps the attempt counter and leaves the row 'pending'
     * WITH its payload so the reconciler can still replay from it — the live path's own retry signal.
     */
    async markDispatchOutcome(key, outcome) {
        if (outcome === 'failed') {
            await this.repo.increment(key, 'dispatchAttempts', 1);
            await this.repo.update(key, { lastDispatchAt: new Date() });
            return;
        }
        await this.repo.update(key, { dispatchState: 'dispatched', lastDispatchAt: new Date(), payload: null });
    }
};
exports.IngressEventService = IngressEventService;
exports.IngressEventService = IngressEventService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(ingress_event_entity_1.IngressEvent, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], IngressEventService);
