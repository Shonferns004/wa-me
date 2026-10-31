"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OMITTED_MEDIA = exports.MEDIA_MESSAGE_TYPES = exports.REVOKED_ROW_PATCH = void 0;
exports.buildMessageMetadata = buildMessageMetadata;
exports.storableWaMessageId = storableWaMessageId;
/** Clear content and archive pointers while retaining the revoked message's identity. */
exports.REVOKED_ROW_PATCH = {
    body: '',
    type: 'revoked',
    metadata: null,
    mediaPath: null,
    mediaMimetype: null,
};
/**
 * Message types whose rows must show a media placeholder even when the payload carried none.
 *
 * The history sync maps messages media-free to keep its footprint down, so a media-typed message can
 * still reach persistence with no media field at all. Without the marker such a row renders
 * as an empty bubble — the DB copy wins over the engine-history placeholder in the dashboard
 * merge — and the by-type stats filter would skip it. (Neither engine's live path needs synthesis:
 * both emit the omitted marker whenever they have one to build.)
 */
exports.MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'sticker', 'document']);
/** The synthesized stand-in for a media payload the engine did not deliver. */
exports.OMITTED_MEDIA = { mimetype: '', omitted: true };
/**
 * Builds the `metadata` JSON column for a persisted message row.
 *
 * The three persist paths (live inbound `onMessage`, own-send echo `onMessageCreate`, and the
 * pre-connection history backfill) each assembled this inline, with one deliberate difference:
 * inbound trusts the engine's media field as-is, while the two paths that can arrive without one
 * synthesize a placeholder. Keeping both rules in one function makes that difference explicit
 * instead of something to re-derive at each site.
 *
 * @param synthesizeOmittedMedia When true, a media-typed message with no media payload gets the
 *   omitted marker. False for live inbound, where absent media genuinely means "no media".
 * @returns The metadata object, or undefined when there is nothing to store (the column is nullable
 *   and an empty object would be noise).
 */
function buildMessageMetadata(message, synthesizeOmittedMedia = false) {
    const metadata = {};
    if (message.media) {
        metadata.media = message.media;
    }
    else if (synthesizeOmittedMedia && exports.MEDIA_MESSAGE_TYPES.has(message.type)) {
        metadata.media = { ...exports.OMITTED_MEDIA };
    }
    if (message.quotedMessage) {
        metadata.quotedMessage = message.quotedMessage;
    }
    if (message.poll)
        metadata.poll = message.poll;
    if (message.call) {
        metadata.call = message.call;
    }
    // Business prompt choices (Baileys). Kept so the dashboard can re-render clickable buttons after reload.
    if (message.buttons?.length) {
        metadata.buttons = message.buttons;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
}
/**
 * The `waMessageId` to store for a message.
 *
 * An engine that received a message but could not read its id back reports the empty sentinel, and
 * NULL is what the non-partial `(sessionId, waMessageId)` unique index exempts — storing `''` would
 * collide the second such message and lose the row. Every persist path funnels through here so that
 * chokepoint cannot be forgotten at a new one.
 */
function storableWaMessageId(id) {
    return id || undefined;
}
