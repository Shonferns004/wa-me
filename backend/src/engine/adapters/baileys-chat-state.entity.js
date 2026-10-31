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
exports.ChatState = void 0;
const typeorm_1 = require("typeorm");
/**
 * Persisted per-session chat app-state (mute / archive / pin) on the `data` connection. Baileys cannot
 * re-deliver these on a reconnect: history sync is skipped once paired and `resyncAppState` only ships
 * mutations newer than the persisted version, so an already-applied mute is never re-emitted, and the
 * library keeps no queryable copy (only LTHash MACs). Measured live: after a reconnect, 0 of the synced
 * chats carried `muteEndTime`. So the value is persisted here and rehydrated on boot; live `chats.update`
 * events (including an unmute, which arrives as `muteEndTime = null`) keep it current.
 *
 * One row per (session, chat). `sessionId` is `Session.id`, the key used elsewhere in the engine
 * surface, provenance rather than a foreign key, so the row can outlive a single run. `muteEndTime` is stored as
 * canonical epoch MILLISECONDS (or null when unmuted); the numeric transformer keeps it a JS number
 * rather than the string a bigint column otherwise reads back as.
 */
let ChatState = class ChatState {
    /** `Session.id` of the session that owns this chat state. */
    sessionId;
    /**
     * Chat id in the raw Baileys dialect, one row per conversation: `<phone>@s.whatsapp.net` for a person
     * (also when WhatsApp synced the state under their lid, once the lid resolves), `<lid>@lid` while it
     * does not, and a group's own id. A row filed under a lid twin is folded onto the phone JID on the
     * chat's next change.
     */
    chatId;
    /** Epoch MILLISECONDS the mute ends, -1 for a mute with no end ("Always"), or null when not muted. */
    muteEndTime;
    archived;
    pinned;
    /**
     * The state fields this row has observed, comma-separated (`muteEndTime`, `archived`, `pinned`); the
     * others hold their default only because the row was created by a patch that did not carry them.
     * Null on a row written before this column existed, read as having observed its set fields. Lets two
     * rows of one chat merge field by field without mistaking an explicit unpin, unarchive or unmute for
     * "not seen".
     */
    observed;
    /**
     * Epoch MILLISECONDS WhatsApp deleted the chat (on the phone, or through the API), else null. WhatsApp
     * keeps nothing of a deleted chat while the gateway keeps its stored messages, so the row stays with
     * its state reset and this set: a message from before it neither keys a chat write nor brings the chat
     * back. A later message re-creates the chat on WhatsApp, and the row goes.
     */
    deletedAt;
    updatedAt;
};
exports.ChatState = ChatState;
__decorate([
    (0, typeorm_1.PrimaryColumn)(),
    __metadata("design:type", String)
], ChatState.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.PrimaryColumn)(),
    __metadata("design:type", String)
], ChatState.prototype, "chatId", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'bigint',
        nullable: true,
        transformer: { to: (v) => v, from: (v) => (v == null ? null : Number(v)) },
    }),
    __metadata("design:type", Object)
], ChatState.prototype, "muteEndTime", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: false }),
    __metadata("design:type", Boolean)
], ChatState.prototype, "archived", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: false }),
    __metadata("design:type", Boolean)
], ChatState.prototype, "pinned", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', nullable: true }),
    __metadata("design:type", Object)
], ChatState.prototype, "observed", void 0);
__decorate([
    (0, typeorm_1.Column)({
        type: 'bigint',
        nullable: true,
        transformer: { to: (v) => v, from: (v) => (v == null ? null : Number(v)) },
    }),
    __metadata("design:type", Object)
], ChatState.prototype, "deletedAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], ChatState.prototype, "updatedAt", void 0);
exports.ChatState = ChatState = __decorate([
    (0, typeorm_1.Entity)('chat_states')
], ChatState);
