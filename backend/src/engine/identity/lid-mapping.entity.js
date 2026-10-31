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
exports.LidMapping = void 0;
const typeorm_1 = require("typeorm");
/**
 * Persisted `lid -> phone` resolution table on the `data` connection. One global, cross-session row per
 * lid (the maintainer wants the mapping shared, not per-session), so a lid resolved in one session/run is
 * usable everywhere and survives restarts - replacing the per-session, in-memory `lidToPn` map.
 *
 * A phone is last-write-wins: a stored mapping is "best known, not forever" (WhatsApp recycles numbers),
 * so it's a cache WhatsApp can correct. `phone` is nullable to record a negative result (a lid we looked
 * up and could not resolve) so active lookups stay one-network-call-per-unknown-lid. A negative replaces a
 * phone only when the session that wrote it (or none, or one since deleted or logged out) answers it, since
 * another account may not see the number. `sessionId` is the row's owner, the session that last wrote it: a
 * negative, or a report of a phone. A repeated report checks the current shared row and preserves its
 * owner and timestamp when the phone is unchanged, so after s1, s2, s1 report one phone the owner is s2. A deleted or logged-out session owns nothing. Intentionally NOT a foreign key, since the row
 * outlives any one session.
 */
let LidMapping = class LidMapping {
    /** The lid number (bare, device-stripped - the user-part of `<lid>@lid`). */
    lid;
    /** E.164 phone digits, or null when the lid is known-but-unresolved (a cached negative result). */
    phone;
    /** The row's owner: the session that last wrote it (see above). Not a foreign key. */
    sessionId;
    /** True after an engine mapping report; cache-only lookups remain display data. */
    isReported;
    updatedAt;
};
exports.LidMapping = LidMapping;
__decorate([
    (0, typeorm_1.PrimaryColumn)(),
    __metadata("design:type", String)
], LidMapping.prototype, "lid", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], LidMapping.prototype, "phone", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], LidMapping.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: false }),
    __metadata("design:type", Boolean)
], LidMapping.prototype, "isReported", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], LidMapping.prototype, "updatedAt", void 0);
exports.LidMapping = LidMapping = __decorate([
    (0, typeorm_1.Entity)('lid_mappings'),
    (0, typeorm_1.Index)(['phone']) // reverse lookup: phone -> lids, for the message from-filter
], LidMapping);
