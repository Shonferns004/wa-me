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
exports.IngressEvent = void 0;
const typeorm_1 = require("typeorm");
const column_types_1 = require("../../../common/utils/column-types");
const date_transformer_1 = require("../../../common/transformers/date.transformer");
// Persist-before-ack durable row + inbound dedup oracle. UNIQUE(pluginId, instanceId, providerDeliveryId):
// instanceId is only unique within a plugin, so pluginId must be part of the key or two plugins sharing an
// instanceId string would drop each other's deliveries as false duplicates.
//
// Storage shape: the FULL payload is carried only while the row is the sole durability handle — from
// recordOrSkip until the dispatch outcome is recorded ('dispatched') or the reconciler dead-letters it
// ('failed'). At that point the dispatch tier owns the payload (the BullMQ job, or the DLQ row on
// failure) and the row's payload is retired to NULL, leaving a slim dedup marker (~hundreds of bytes
// instead of up to 2× maxBodyBytes). payloadHash is kept permanently as the content fingerprint.
let IngressEvent = class IngressEvent {
    // Host-minted uuid (crypto.randomUUID()), NOT DB-generated — the id and the jobId (= deliveryId)
    // are decoupled on purpose. @PrimaryColumn, not @PrimaryGeneratedColumn.
    id;
    instanceId;
    pluginId;
    providerDeliveryId;
    route;
    // NULL once the dispatch outcome is recorded (see the storage-shape comment above). The reconciler
    // only replays 'pending' rows, which always still carry the payload. NULL on a 'pending' row is
    // unreadable history (e.g. imported without one); the reconciler's sweep query excludes it silently,
    // and it stays pending until INGRESS_DEDUP_RETENTION_DAYS prunes it.
    // `method` is the request's HTTP method, so a replay reaches the handler as the live attempt did. Rows
    // written before it was persisted lack it, and dispatch falls back to 'POST' for them.
    // `admission.verified` is what the host decided when it accepted the request (false on a route that
    // authenticates nothing); a replay or retry hands the handler that verdict, not the route's current scheme.
    // Rows written before it was persisted lack it, and dispatch reads the route as it stands.
    payload;
    // sha256 hex of the rawBody, written at recordOrSkip. Survives payload retirement so operators can
    // still correlate a dedup row with a provider delivery without storing the payload. NULL on rows
    // that predate the column (no backfill — their payloads are retired anyway).
    payloadHash;
    sessionId;
    // Nullable by design (see the IngressDispatchState comment above): NO DB default, because the
    // default 'pending' would also stamp pre-upgrade rows on the synchronize path and the reconciler
    // would replay the whole dedup log on deploy. New rows are 'pending' via recordOrSkip explicitly;
    // migration-managed DBs backfill existing rows to 'dispatched' instead.
    dispatchState;
    // Dispatch-attempt counter the reconciler caps its replay budget against; the live path bumps it
    // on a swallowed inline-dispatch failure so those retries count too.
    dispatchAttempts;
    lastDispatchAt;
    createdAt;
};
exports.IngressEvent = IngressEvent;
__decorate([
    (0, typeorm_1.PrimaryColumn)(),
    __metadata("design:type", String)
], IngressEvent.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], IngressEvent.prototype, "instanceId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], IngressEvent.prototype, "pluginId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], IngressEvent.prototype, "providerDeliveryId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], IngressEvent.prototype, "route", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.jsonColumnType)(), nullable: true }),
    __metadata("design:type", Object)
], IngressEvent.prototype, "payload", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IngressEvent.prototype, "payloadHash", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IngressEvent.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], IngressEvent.prototype, "dispatchState", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 0 }),
    __metadata("design:type", Number)
], IngressEvent.prototype, "dispatchAttempts", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.dateColumnType)(), nullable: true, transformer: date_transformer_1.DateTransformer }),
    __metadata("design:type", Object)
], IngressEvent.prototype, "lastDispatchAt", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], IngressEvent.prototype, "createdAt", void 0);
exports.IngressEvent = IngressEvent = __decorate([
    (0, typeorm_1.Entity)('ingress_events'),
    (0, typeorm_1.Index)('UQ_ingress_events_instance_delivery', ['pluginId', 'instanceId', 'providerDeliveryId'], { unique: true }),
    (0, typeorm_1.Index)('IDX_ingress_events_createdAt', ['createdAt']),
    (0, typeorm_1.Index)('IDX_ingress_events_dispatchState', ['dispatchState', 'createdAt'])
], IngressEvent);
