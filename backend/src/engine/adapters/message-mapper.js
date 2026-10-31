"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.POLL_TEXT_MAX_LENGTH = exports.POLL_MAX_OPTIONS = void 0;
exports.boundPollText = boundPollText;
exports.boundPollOptions = boundPollOptions;
exports.mapWwebjsMessageType = mapWwebjsMessageType;
exports.buildIncomingMessageBase = buildIncomingMessageBase;
exports.buildEditedMessage = buildEditedMessage;
exports.mapContactFields = mapContactFields;
const whatsapp_web_js_types_1 = require("../types/whatsapp-web-js.types");
const wa_id_1 = require("../identity/wa-id");
/**
 * Bounds on an inbound poll, applied by both engines. WhatsApp itself allows 12 options of 100
 * characters under a 255-character question; these sit well above that, so nothing a client can send
 * is cut, while a malformed poll cannot bloat a stored row, a webhook payload or a socket frame. A poll
 * over a bound is truncated, not dropped.
 */
exports.POLL_MAX_OPTIONS = 32;
exports.POLL_TEXT_MAX_LENGTH = 1024;
/** A poll question or option text, cut to {@link POLL_TEXT_MAX_LENGTH}. */
function boundPollText(text) {
    return text.slice(0, exports.POLL_TEXT_MAX_LENGTH);
}
/** A poll's options, cut to {@link POLL_MAX_OPTIONS} entries of at most {@link POLL_TEXT_MAX_LENGTH}. */
function boundPollOptions(options) {
    return options.slice(0, exports.POLL_MAX_OPTIONS).map(boundPollText);
}
/**
 * Map a whatsapp-web.js `MessageTypes` token to the engine-neutral {@link MessageType}, so no
 * consumer outside the adapter sees wwebjs-specific type strings. Notably `chat` -> `text` (aligning
 * incoming with the neutral types outgoing sends already use) and `ptt` -> `voice`. Anything not
 * mapped becomes `unknown`.
 */
function mapWwebjsMessageType(raw) {
    switch (raw) {
        // Besides plain `chat`, a tapped button, list row or template button: WA Web carries the chosen
        // option's text in the body, and Baileys reports the same replies as `text` (#562). `hsm` and
        // `interactive` prompts are left out: their body can be empty, and an empty text is worse than
        // `unknown`.
        case 'chat':
        case 'buttons_response':
        case 'list_response':
        case 'template_button_reply':
            return 'text';
        case 'image':
            return 'image';
        case 'video':
            return 'video';
        case 'audio':
            return 'audio';
        case 'ptt':
            return 'voice';
        case 'document':
            return 'document';
        case 'sticker':
            return 'sticker';
        case 'location':
            return 'location';
        case 'vcard':
        case 'multi_vcard':
            return 'contact';
        case 'call_log':
            return 'call';
        case 'poll_creation':
            return 'poll';
        case 'revoked':
            return 'revoked';
        case 'order':
            return 'order';
        case 'product':
            return 'product';
        default:
            return 'unknown';
    }
}
/**
 * Build the synchronous base of an IncomingMessage from a raw wwebjs message.
 * Async enrichment (media, quoted message, saved-contact name) is layered on by
 * the adapter; this covers the fields available without an await.
 */
function buildIncomingMessageBase(msg) {
    // For an outgoing (fromMe) message `from` is the account's own JID and `to` is the conversation;
    // for an incoming message it's the reverse. So the chat is `to` when fromMe, else `from`.
    const chatId = msg.fromMe ? msg.to : msg.from;
    const incoming = {
        // Read `$1` before giving up, as the send/ack/status paths do (#762/#765/#773). This runs on the
        // LIVE inbound path (`onMessage`/`onMessageCreate`), so on a renamed build without the build-time
        // backport every arriving message otherwise carries `id: undefined`. The empty sentinel means
        // "received, id unreadable" and is normalized to NULL where it is persisted — never to `''`, which
        // the non-partial (sessionId, waMessageId) unique index would collide the second such message on.
        id: (0, whatsapp_web_js_types_1.readWid)(msg.id) ?? '',
        from: msg.from,
        to: msg.to,
        chatId,
        body: msg.body,
        type: mapWwebjsMessageType(msg.type),
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        isGroup: chatId.endsWith('@g.us'),
        kind: (0, wa_id_1.chatKind)(chatId),
        // Flag status/story broadcasts here (the engine-specific `status@broadcast` pseudo-JID stays in
        // the adapter) so engine-neutral code can skip them without matching the literal.
        isStatusBroadcast: msg.to === 'status@broadcast' || chatId === 'status@broadcast',
    };
    // In a group, `from` is the group JID, so `author` is the only way to know the real sender.
    if (msg.author) {
        incoming.author = msg.author;
    }
    // @mentioned WIDs, when present — used for command targeting (e.g. `/tr grant @user`).
    if (msg.mentionedIds && msg.mentionedIds.length > 0) {
        incoming.mentionedIds = msg.mentionedIds;
    }
    // Flag senders identified by a WhatsApp privacy id (`@lid`) so engine-neutral code can opt to
    // resolve a phone number without matching the engine-specific JID scheme itself (#263).
    const senderJid = msg.author ?? msg.from;
    if (senderJid.endsWith('@lid')) {
        incoming.isLidSender = true;
    }
    // Push name is available synchronously on the raw payload — no contact lookup needed.
    const pushName = msg._data?.notifyName;
    if (pushName) {
        incoming.contact = { pushName };
    }
    // Ephemeral/disappearing-messages timer, when the chat has one set.
    if (msg._data?.ephemeralDuration && msg._data.ephemeralDuration > 0) {
        incoming.ephemeralDuration = msg._data.ephemeralDuration;
    }
    // Commerce ids, keyed off the mapped type so a stray `title` on some other message shape cannot
    // fabricate a product. Without the id neither entry is actionable, so both are then left unset.
    if (incoming.type === 'order' && msg.orderId) {
        incoming.order = { orderId: msg.orderId, ...(msg.token ? { token: msg.token } : {}) };
    }
    else if (incoming.type === 'product' && msg.productId) {
        incoming.product = {
            productId: msg.productId,
            ...(msg.title ? { title: msg.title } : {}),
            ...(msg.description ? { description: msg.description } : {}),
            ...(msg.businessOwnerJid ? { businessOwnerJid: msg.businessOwnerJid } : {}),
        };
    }
    if (incoming.type === 'poll') {
        // The question is the body of a poll, so it is bounded with the poll.
        incoming.body = boundPollText(incoming.body);
        if (Array.isArray(msg.pollOptions)) {
            const options = msg.pollOptions
                .map(option => (typeof option === 'string' ? option : option?.name))
                .filter((option) => typeof option === 'string');
            if (options.length) {
                incoming.poll = {
                    name: boundPollText(msg.pollName ?? msg.body),
                    options: boundPollOptions(options),
                    allowMultipleAnswers: msg.allowMultipleAnswers === true,
                };
            }
        }
    }
    return incoming;
}
/**
 * Project an engine-neutral message base into the public edit-event contract. Keeping this projection
 * shared prevents the two adapters from drifting on identity, direction, group, type, or filter fields.
 */
function buildEditedMessage(message, hasMedia) {
    return {
        messageId: message.id,
        chatId: message.chatId,
        body: message.body,
        senderId: message.author ?? message.from,
        from: message.from,
        to: message.to,
        fromMe: message.fromMe,
        isGroup: message.isGroup,
        type: message.type,
        hasMedia,
        ...(message.author ? { author: message.author } : {}),
        ...(message.mentionedIds ? { mentionedIds: message.mentionedIds } : {}),
        timestamp: message.timestamp,
    };
}
/**
 * Map the synchronous fields of a wwebjs `Contact` to a {@link MessageContact}, copying only the values
 * that are set. No network calls, which on a per-message path would risk rate-limiting.
 *
 * With `full` false (the default) it returns just `name`/`pushName`, the long-standing payload. With
 * `full` true (operator opt-in via `WEBHOOK_CONTACT_DETAILS`) it returns the complete field set.
 */
function mapContactFields(contact, full = false) {
    const out = {};
    if (contact.name)
        out.name = contact.name;
    if (contact.pushname)
        out.pushName = contact.pushname;
    if (!full)
        return out;
    const id = contact.id?._serialized;
    if (id)
        out.id = id;
    if (contact.number)
        out.number = contact.number;
    if (contact.shortName)
        out.shortName = contact.shortName;
    if (contact.type)
        out.type = contact.type;
    if (contact.isMyContact !== undefined)
        out.isMyContact = contact.isMyContact;
    if (contact.isWAContact !== undefined)
        out.isWAContact = contact.isWAContact;
    if (contact.isBusiness !== undefined)
        out.isBusiness = contact.isBusiness;
    if (contact.isEnterprise !== undefined)
        out.isEnterprise = contact.isEnterprise;
    if (contact.verifiedName)
        out.verifiedName = contact.verifiedName;
    if (contact.verifiedLevel !== undefined)
        out.verifiedLevel = contact.verifiedLevel;
    if (contact.isBlocked !== undefined)
        out.isBlocked = contact.isBlocked;
    if (contact.labels && contact.labels.length > 0)
        out.labels = contact.labels;
    return out;
}
