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
exports.WebhookDeliveryFailure = void 0;
const typeorm_1 = require("typeorm");
const nul_free_transformer_1 = require("../../../common/transformers/nul-free.transformer");
const column_types_1 = require("../../../common/utils/column-types");
/**
 * A durable record of a webhook delivery that exhausted all of its retries. The queued path (BullMQ)
 * otherwise only leaves a `failed` job that the queue evicts after a day, and the direct fallback path
 * swallowed the final error entirely — so a receiver outage longer than the retry window silently lost
 * events with no operator-visible trail. Each lost delivery is appended here once (see
 * `recordWebhookDeliveryFailure`, which skips a delivery it has already recorded so a replayed one is
 * not reported several times) and surfaced via the ADMIN `GET /webhooks/delivery-failures` endpoint.
 *
 * Lives on the `data` connection (auto-loaded by the webhook entity glob).
 */
let WebhookDeliveryFailure = class WebhookDeliveryFailure {
    id;
    webhookId;
    sessionId;
    event;
    url;
    /** The idempotency key the receiver would have deduped on (lets an operator correlate the lost event). */
    idempotencyKey;
    deliveryId;
    /** Total attempts made before giving up. */
    attempts;
    /** Last HTTP status, when the failure was a non-2xx response (null for a network/timeout/SSRF error). */
    lastStatusCode;
    lastError;
    /**
     * The event data the delivery was built from (pre-`webhook:before`, after inline-media shedding),
     * kept so `POST /webhooks/delivery-failures/redrive` can replay the lost event. Written only for a
     * terminal row (attempts > 0) and only while WEBHOOK_FAILURE_PAYLOAD_RETENTION_HOURS > 0; the
     * retention sweep nulls it once that window passes, leaving the row itself for the audit trail.
     * NULL on every row recorded with the knob off, which keeps today's behaviour.
     *
     * `select: false`: the column can hold a whole message body, and the list endpoint serializes
     * these entities as they are read. Only the redrive path selects it explicitly.
     */
    payload;
    /** When the delivery was finally abandoned. */
    createdAt;
};
exports.WebhookDeliveryFailure = WebhookDeliveryFailure;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "webhookId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "event", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "url", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "idempotencyKey", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "deliveryId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int' }),
    __metadata("design:type", Number)
], WebhookDeliveryFailure.prototype, "attempts", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Object)
], WebhookDeliveryFailure.prototype, "lastStatusCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', transformer: nul_free_transformer_1.NulFreeTransformer }),
    __metadata("design:type", String)
], WebhookDeliveryFailure.prototype, "lastError", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.jsonColumnType)(), nullable: true, select: false }),
    __metadata("design:type", Object)
], WebhookDeliveryFailure.prototype, "payload", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], WebhookDeliveryFailure.prototype, "createdAt", void 0);
exports.WebhookDeliveryFailure = WebhookDeliveryFailure = __decorate([
    (0, typeorm_1.Entity)('webhook_delivery_failures'),
    (0, typeorm_1.Index)('IDX_webhook_delivery_failures_sessionId', ['sessionId'])
    // Backs the before-insert duplicate lookup that keeps one row per lost delivery rather than one per
    // reconciler replay. See AddWebhookDeliveryFailureLookupIndex1786300000000.
    ,
    (0, typeorm_1.Index)('IDX_webhook_delivery_failures_delivery', ['webhookId', 'idempotencyKey']),
    (0, typeorm_1.Index)('UQ_webhook_delivery_failures_terminal', ['webhookId', 'idempotencyKey'], {
        unique: true,
        where: '"attempts" > 0',
    })
], WebhookDeliveryFailure);
