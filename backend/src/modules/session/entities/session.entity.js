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
exports.Session = exports.SessionStatus = void 0;
const typeorm_1 = require("typeorm");
const date_transformer_1 = require("../../../common/transformers/date.transformer");
const nul_free_transformer_1 = require("../../../common/transformers/nul-free.transformer");
const column_types_1 = require("../../../common/utils/column-types");
var SessionStatus;
(function (SessionStatus) {
    SessionStatus["CREATED"] = "created";
    SessionStatus["INITIALIZING"] = "initializing";
    SessionStatus["QR_READY"] = "qr_ready";
    SessionStatus["AUTHENTICATING"] = "authenticating";
    SessionStatus["READY"] = "ready";
    SessionStatus["DISCONNECTED"] = "disconnected";
    SessionStatus["ACTION_REQUIRED"] = "action_required";
    SessionStatus["FAILED"] = "failed";
})(SessionStatus || (exports.SessionStatus = SessionStatus = {}));
let Session = class Session {
    id;
    name;
    status;
    phone;
    pushName;
    config;
    // Phase 3: Proxy per session
    proxyUrl;
    proxyType;
    connectedAt;
    lastActiveAt;
    /**
     * Which process currently hosts this session's engine, or NULL when nobody does.
     *
     * A session's engine lives in exactly one process. Recording the owner is what lets a booting
     * process tell "my own leftovers, which really are dead" from "another process's live session",
     * which it previously could not and so reset both.
     */
    nodeId;
    claimedAt;
    /**
     * Where the owning node answers HTTP, so a peer can forward a request it cannot serve (the
     * engine lives with the owner). Written at claim time from NODE_URL; null when the operator has
     * not configured routing — a peer then answers 409 instead of forwarding.
     */
    nodeUrl;
    /**
     * When the claim above stops being honoured. A process that dies without releasing leaves a row
     * pointing at an owner that is gone, so the claim expires rather than requiring a clean shutdown
     * to recover; a running owner keeps extending it.
     */
    leaseExpiresAt;
    /**
     * Operator intent, server-owned and not part of any session response (only the export-data
     * backup carries it): 'stopped' once POST /stop or POST /force-kill took the session down, and
     * 'deleting' while a DELETE runs (kept if it fails part-way), or 'deleting-stopped' when an
     * independent stop also stands during that delete. All are cleared by an explicit
     * POST /start. Boot auto-start and takeover skip a row holding any of them, so a deliberate stop
     * survives a restart. NULL (every row that predates the column) means eligible, as before.
     */
    desiredState;
    createdAt;
    updatedAt;
    /**
     * Transient (non-persisted) human-readable reason for the most recent terminal
     * engine failure. Populated at read time from the in-memory error map so the
     * dashboard can explain a FAILED status; intentionally not a column because it
     * is runtime state that resets when the engine re-initializes.
     */
    lastError;
    /**
     * Transient (non-persisted) restriction WhatsApp currently has in force on this session's account,
     * or null when there is none. Populated at read time from SessionRestrictionStore, which explains
     * why it is runtime state rather than a column.
     */
    restriction;
};
exports.Session = Session;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], Session.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100, unique: true }),
    __metadata("design:type", String)
], Session.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'varchar',
        length: 50,
        default: SessionStatus.CREATED,
    }),
    __metadata("design:type", String)
], Session.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], Session.prototype, "phone", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100, nullable: true, transformer: nul_free_transformer_1.NulFreeTransformer }),
    __metadata("design:type", Object)
], Session.prototype, "pushName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.jsonColumnType)(), default: '{}' }),
    __metadata("design:type", Object)
], Session.prototype, "config", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 255, nullable: true }),
    __metadata("design:type", Object)
], Session.prototype, "proxyUrl", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10, nullable: true }),
    __metadata("design:type", Object)
], Session.prototype, "proxyType", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.dateColumnType)(), nullable: true, transformer: date_transformer_1.DateTransformer }),
    __metadata("design:type", Object)
], Session.prototype, "connectedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.dateColumnType)(), nullable: true, transformer: date_transformer_1.DateTransformer }),
    __metadata("design:type", Object)
], Session.prototype, "lastActiveAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 190, nullable: true }),
    __metadata("design:type", Object)
], Session.prototype, "nodeId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.dateColumnType)(), nullable: true, transformer: date_transformer_1.DateTransformer }),
    __metadata("design:type", Object)
], Session.prototype, "claimedAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 2048, nullable: true }),
    __metadata("design:type", Object)
], Session.prototype, "nodeUrl", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.dateColumnType)(), nullable: true, transformer: date_transformer_1.DateTransformer }),
    __metadata("design:type", Object)
], Session.prototype, "leaseExpiresAt", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 20, nullable: true }),
    __metadata("design:type", Object)
], Session.prototype, "desiredState", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], Session.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], Session.prototype, "updatedAt", void 0);
exports.Session = Session = __decorate([
    (0, typeorm_1.Entity)('sessions')
], Session);
