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
exports.Message = exports.MessageStatus = exports.MessageDirection = exports.bigintToNumberTransformer = void 0;
const typeorm_1 = require("typeorm");
const column_types_1 = require("../../../common/utils/column-types");
const nul_free_transformer_1 = require("../../../common/transformers/nul-free.transformer");
/**
 * A `bigint` column reads back as a string on PostgreSQL (pg avoids >2^53 precision loss) but as a
 * number on SQLite. WhatsApp epoch-seconds are far below 2^53, so coerce reads to a number for a
 * consistent REST/SDK/MCP contract (entity, DTO, the typed SDKs, and dashboard declare a numeric type).
 * Writes pass through unchanged; null stays null.
 */
exports.bigintToNumberTransformer = {
    to: (value) => value,
    from: (value) => {
        if (value == null)
            return null;
        const n = Number(value);
        // Defensive: a bigint column can only return null or a numeric value, so NaN is unreachable —
        // but coerce a hypothetical non-numeric read to null rather than leak NaN into the contract.
        return Number.isNaN(n) ? null : n;
    },
};
var MessageDirection;
(function (MessageDirection) {
    MessageDirection["INCOMING"] = "incoming";
    MessageDirection["OUTGOING"] = "outgoing";
})(MessageDirection || (exports.MessageDirection = MessageDirection = {}));
var MessageStatus;
(function (MessageStatus) {
    MessageStatus["PENDING"] = "pending";
    MessageStatus["SENT"] = "sent";
    MessageStatus["DELIVERED"] = "delivered";
    MessageStatus["READ"] = "read";
    MessageStatus["FAILED"] = "failed";
})(MessageStatus || (exports.MessageStatus = MessageStatus = {}));
let Message = class Message {
    id;
    // No standalone @Index here: sessionId-only lookups are already served by the composite indexes
    // that lead with sessionId: (sessionId, createdAt), (sessionId, chatId, createdAt) and the unique
    // (sessionId, waMessageId).
    sessionId;
    waMessageId;
    chatId;
    /** The sender's contact name (pushName) as the engine reported it: in a group that is the member, not
     *  the group. Null on legacy rows and on rows that carried no contact. */
    chatName;
    /**
     * Stable sender identity for a group, status or broadcast-list message: the JID who actually
     * posted (`from` is the group, `status@broadcast` or list id; on Baileys a list message the account
     * received is filed under the sender, so `from` is the sender too). Lets the chat view tell two
     * same-named participants apart. Null on 1:1 messages, outgoing echoes, and legacy rows.
     */
    author;
    from;
    to;
    body;
    type;
    direction;
    timestamp;
    metadata;
    /**
     * Storage key of this message's archived media, or null when nothing was archived — which is the
     * case for every row written while `CHAT_MEDIA_ARCHIVE_ENABLED` is off (the default), for non-media
     * messages, and for media above the archive cap. Independent of the inline base64 copy in
     * `metadata.media`, which stays inline by default and is replaced after verification in archive mode.
     */
    // Partial index for the chat-media orphan sweep's per-chunk `mediaPath IN (...)` lookup. NULL for
    // every un-archived row (archiving is opt-in), so the WHERE clause keeps the index to rows that
    // can ever match. The explicit name matches the migration that creates it on synchronize-disabled
    // deployments, so both schema paths converge on one index.
    // The column name is QUOTED in the predicate on purpose: PostgreSQL folds a bare identifier to
    // lower case, so `mediaPath IS NOT NULL` makes synchronize fail on `column "mediapath" does not
    // exist`. The migration below already quotes it, so this is also what keeps the two in step.
    mediaPath;
    /** Mimetype of the archived media, so the read endpoint can serve a Content-Type without
     *  depending on the inline copy. Null whenever `mediaPath` is. */
    mediaMimetype;
    status;
    // Standalone index for the createdAt-only range predicates of the stats aggregates — the
    // composite above leads with sessionId, so it can't serve them (SQLite needs ANALYZE stats for
    // a skip-scan; Postgres has none). The explicit name matches the migration that creates it on
    // synchronize-disabled deployments, so both schema paths converge on one index.
    createdAt;
};
exports.Message = Message;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], Message.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Message.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Message.prototype, "waMessageId", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Message.prototype, "chatId", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, transformer: nul_free_transformer_1.NulFreeTransformer }),
    __metadata("design:type", String)
], Message.prototype, "chatName", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Message.prototype, "author", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Message.prototype, "from", void 0);
__decorate([
    (0, typeorm_1.Column)(),
    __metadata("design:type", String)
], Message.prototype, "to", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true, transformer: nul_free_transformer_1.NulFreeTransformer }),
    __metadata("design:type", String)
], Message.prototype, "body", void 0);
__decorate([
    (0, typeorm_1.Column)({ default: 'text' }),
    __metadata("design:type", String)
], Message.prototype, "type", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'varchar',
        default: MessageDirection.OUTGOING,
    }),
    __metadata("design:type", String)
], Message.prototype, "direction", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'bigint', nullable: true, transformer: exports.bigintToNumberTransformer }),
    __metadata("design:type", Number)
], Message.prototype, "timestamp", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.jsonColumnType)(), nullable: true }),
    __metadata("design:type", Object)
], Message.prototype, "metadata", void 0);
__decorate([
    (0, typeorm_1.Index)('IDX_messages_mediaPath', { where: '"mediaPath" IS NOT NULL' }),
    (0, typeorm_1.Column)({ nullable: true }),
    __metadata("design:type", String)
], Message.prototype, "mediaPath", void 0);
__decorate([
    (0, typeorm_1.Column)({ nullable: true, transformer: nul_free_transformer_1.NulFreeTransformer }),
    __metadata("design:type", String)
], Message.prototype, "mediaMimetype", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'varchar',
        default: MessageStatus.SENT,
    }),
    (0, typeorm_1.Index)(),
    __metadata("design:type", String)
], Message.prototype, "status", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    (0, typeorm_1.Index)('IDX_messages_createdAt'),
    __metadata("design:type", Date)
], Message.prototype, "createdAt", void 0);
exports.Message = Message = __decorate([
    (0, typeorm_1.Entity)('messages'),
    (0, typeorm_1.Index)(['sessionId', 'createdAt']),
    (0, typeorm_1.Index)(['chatId'])
    // One chat's thread, paged newest-first, and its total; the send-pacing history probes filter on the
    // same (sessionId, chatId, createdAt) prefix. The standalone chatId index stays for the search and
    // stats reads that filter on chatId without a session. The explicit name matches the migration that
    // creates it on synchronize-disabled deployments, so both schema paths converge on one index.
    ,
    (0, typeorm_1.Index)('IDX_messages_sessionId_chatId_createdAt', ['sessionId', 'chatId', 'createdAt'])
    // Explicit id tiebreaking keeps a message-time walk stable across SQLite and PostgreSQL.
    ,
    (0, typeorm_1.Index)('IDX_messages_session_timestamp_id', ['sessionId', 'timestamp', 'id']),
    (0, typeorm_1.Index)('IDX_messages_session_chat_timestamp_id', ['sessionId', 'chatId', 'timestamp', 'id']),
    (0, typeorm_1.Index)('IDX_messages_session_direction_timestamp_id', ['sessionId', 'direction', 'timestamp', 'id'])
    // Composite index for the ack-driven status UPDATE (scoped by sessionId + waMessageId).
    // Without it every ack does a full table scan of a hot table.
    ,
    (0, typeorm_1.Index)('UQ_messages_sessionId_waMessageId', ['sessionId', 'waMessageId'], { unique: true })
], Message);
