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
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookOutboxEvent = void 0;
const typeorm_1 = require("typeorm");
const column_types_1 = require("../../../common/utils/column-types");
const date_transformer_1 = require("../../../common/transformers/date.transformer");
/**
 * Durable record of an outbound webhook delivery, written before the attempt.
 *
 * Fan-out is fire-and-forget from the projector (`void dispatch(...)`), so until this row existed a
 * hard crash between persisting a message and completing its POST lost the delivery with nothing
 * left behind in either mode. The in-memory `inFlightDeliveries` map already tracked exactly this
 * set; the row is its durable twin.
 *
 * UNIQUE(webhookId, idempotencyKey): the key is already salted per webhook at dispatch, so the pair
 * names one delivery attempt-set exactly, and a replay reuses the STORED key rather than deriving a
 * new one, which is what keeps a redelivery deduplicable at the receiver.
 */
let WebhookOutboxEvent = class WebhookOutboxEvent {
    id;
    webhookId;
    sessionId;
    event;
    idempotencyKey;
    deliveryId;
    // Pending and queued rows keep their payload until delivery or durable failure handoff.
    payload;
    state;
    attempts;
    lastAttemptAt;
    createdAt;
};
exports.WebhookOutboxEvent = WebhookOutboxEvent;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], WebhookOutboxEvent.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookOutboxEvent.prototype, "webhookId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookOutboxEvent.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookOutboxEvent.prototype, "event", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookOutboxEvent.prototype, "idempotencyKey", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookOutboxEvent.prototype, "deliveryId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.jsonColumnType)(), nullable: true }),
    __metadata("design:type", Object)
], WebhookOutboxEvent.prototype, "payload", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], WebhookOutboxEvent.prototype, "state", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], WebhookOutboxEvent.prototype, "attempts", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.dateColumnType)(), nullable: true, transformer: date_transformer_1.DateTransformer }),
    __metadata("design:type", Object)
], WebhookOutboxEvent.prototype, "lastAttemptAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], WebhookOutboxEvent.prototype, "createdAt", void 0);
exports.WebhookOutboxEvent = WebhookOutboxEvent = __decorate([
    (0, typeorm_1.Entity)('webhook_outbox_events'),
    (0, typeorm_1.Index)('UQ_webhook_outbox_events_webhook_key', ['webhookId', 'idempotencyKey'], { unique: true }),
    (0, typeorm_1.Index)('IDX_webhook_outbox_events_state_createdAt', ['state', 'createdAt'])
    // A session delete removes its outbox rows by sessionId, in batches.
    ,
    (0, typeorm_1.Index)('IDX_webhook_outbox_events_sessionId', ['sessionId'])
], WebhookOutboxEvent);
