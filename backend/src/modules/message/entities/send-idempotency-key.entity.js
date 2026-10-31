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
exports.SendIdempotencyKey = void 0;
const typeorm_1 = require("typeorm");
const column_types_1 = require("../../../common/utils/column-types");
const date_transformer_1 = require("../../../common/transformers/date.transformer");
/**
 * One `Idempotency-Key` a client sent on a send route, kept for SEND_IDEMPOTENCY_TTL (24 h) so a
 * retry after a timeout or a dropped connection replays the first answer instead of sending the
 * message again. Opt-in per request: a send without the header never touches this table.
 *
 * UNIQUE(sessionId, idempotencyKey) is the claim: the insert that wins it runs the send, every other
 * request with the pair reads the row. It holds across nodes sharing one database, because the claim
 * is the insert itself rather than a read followed by a write.
 *
 * Lives on the `data` connection (auto-loaded by the message entity glob). Not exported by
 * `GET /infra/export-data`: a key outlives its purpose within a day.
 */
let SendIdempotencyKey = class SendIdempotencyKey {
    id;
    sessionId;
    /** The client's `Idempotency-Key` header value, verbatim (1-255 visible ASCII characters). */
    idempotencyKey;
    /** The send route the key was first used on (`send-text`, `reply`, ...). */
    route;
    /** SHA-256 of the route and the request body; a retry whose hash differs is refused with 422. */
    requestHash;
    state;
    /** The response body of a completed send, replayed verbatim. NULL while pending or after a failure. */
    responseBody;
    /** When the key may be reused for a new send; the hourly sweep deletes rows past it. */
    expiresAt;
    createdAt;
};
exports.SendIdempotencyKey = SendIdempotencyKey;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], SendIdempotencyKey.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SendIdempotencyKey.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SendIdempotencyKey.prototype, "idempotencyKey", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SendIdempotencyKey.prototype, "route", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], SendIdempotencyKey.prototype, "requestHash", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar' }),
    __metadata("design:type", String)
], SendIdempotencyKey.prototype, "state", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.jsonColumnType)(), nullable: true }),
    __metadata("design:type", Object)
], SendIdempotencyKey.prototype, "responseBody", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.dateColumnType)(), transformer: date_transformer_1.DateTransformer }),
    __metadata("design:type", Date)
], SendIdempotencyKey.prototype, "expiresAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], SendIdempotencyKey.prototype, "createdAt", void 0);
exports.SendIdempotencyKey = SendIdempotencyKey = __decorate([
    (0, typeorm_1.Entity)('send_idempotency_keys'),
    (0, typeorm_1.Index)('UQ_send_idempotency_keys_session_key', ['sessionId', 'idempotencyKey'], { unique: true }),
    (0, typeorm_1.Index)('IDX_send_idempotency_keys_expiresAt', ['expiresAt'])
], SendIdempotencyKey);
