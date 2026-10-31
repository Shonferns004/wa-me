"use strict";
/**
 * Smart webhook filters: an optional, additive pre-filter layer applied to webhook
 * triggers. A webhook with no filters behaves exactly as before. When filters are
 * present, every condition must match (logical AND) for the webhook to fire.
 *
 * The design is intentionally event-family aware so it can grow beyond messages:
 * fields are registered per family (`message`, later `session`/`group`). A condition
 * whose field is unknown for the fired event's family is skipped, so a webhook
 * subscribed to several families behaves sanely without per-event filter sets.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FILTER_FIELDS = exports.MAX_TEXT_VALUE_LENGTH = exports.MAX_VALUES_PER_CONDITION = exports.MAX_CONDITIONS = exports.CHAT_KINDS = exports.MESSAGE_TYPES = void 0;
exports.eventFamily = eventFamily;
exports.getFieldDefinition = getFieldDefinition;
exports.findFieldDefinition = findFieldDefinition;
const wa_id_1 = require("../../../engine/identity/wa-id");
/**
 * Every neutral message type a `type` filter condition may name. Derived exhaustively from the
 * engine-neutral {@link MessageType} union so a type added there cannot be silently rejected here:
 * `poll` was offered by the dashboard's own copy of this list while saving was refused as invalid.
 * The `Record<MessageType, ...>` shape makes an omitted or stale entry a compile error.
 */
const MESSAGE_TYPE_FLAGS = {
    text: true,
    image: true,
    video: true,
    audio: true,
    voice: true,
    document: true,
    sticker: true,
    location: true,
    contact: true,
    poll: true,
    call: true,
    revoked: true,
    order: true,
    product: true,
    masked: true,
    unknown: true,
};
exports.MESSAGE_TYPES = Object.keys(MESSAGE_TYPE_FLAGS);
/** Chat kinds a message-family filter can match on. `channel` is a newsletter; see chatKind(). */
exports.CHAT_KINDS = ['individual', 'group', 'channel', 'status', 'broadcast', 'unknown'];
// Guard rails. These bound both stored config size and per-event evaluation cost.
exports.MAX_CONDITIONS = 20;
exports.MAX_VALUES_PER_CONDITION = 100;
exports.MAX_TEXT_VALUE_LENGTH = 1000;
const ID_OPERATORS = ['is', 'isNot'];
const TEXT_OPERATORS = ['contains', 'equals'];
const ENUM_OPERATORS = ['is', 'isNot'];
const BOOLEAN_OPERATORS = ['is'];
const str = (v) => (typeof v === 'string' ? v : undefined);
/**
 * Field registry keyed by event family. v1 ships `message`; `session`/`group`
 * slot in later by adding entries here, with no change to the evaluator.
 */
exports.FILTER_FIELDS = {
    message: [
        {
            field: 'sender',
            kind: 'id',
            operators: ID_OPERATORS,
            // In groups `from` is the group JID; `author` is the real participant.
            resolve: data => str(data.author) ?? str(data.from),
        },
        {
            field: 'recipient',
            kind: 'id',
            operators: ID_OPERATORS,
            resolve: data => str(data.to),
        },
        {
            // Conversation JID (DM or group). Carried by the message events proper: `IncomingMessage`
            // declares `chatId` required, and the edited, reaction and revoked events set it explicitly.
            // `message.ack` and `message.failed` carry it too when the engine's update names the chat
            // (both engines do on the live path), so a chatId condition scopes those two to that chat.
            // A payload whose chat is unknown falls under the generic absent-field rule: an `is`
            // condition suppresses it and an `isNot` condition passes it (docs/06 states the rule for
            // `sender` the same way).
            // Deliberately without a fall back to `from`, which is the sender on a DM and this session on
            // an outbound message, so it would silently scope the filter to the wrong conversation.
            field: 'chatId',
            kind: 'id',
            operators: ID_OPERATORS,
            resolve: data => str(data.chatId),
        },
        {
            field: 'body',
            kind: 'text',
            operators: TEXT_OPERATORS,
            resolve: data => str(data.body) ?? '',
        },
        {
            field: 'type',
            kind: 'enum',
            operators: ENUM_OPERATORS,
            enumValues: exports.MESSAGE_TYPES,
            resolve: data => str(data.type),
        },
        {
            field: 'isGroup',
            kind: 'boolean',
            operators: BOOLEAN_OPERATORS,
            resolve: data => data.isGroup === true,
        },
        {
            // The chat kind, so a filter can single out or exclude a channel (newsletter) where the
            // boolean isGroup cannot: individual, group, channel, status, broadcast and unknown all
            // collapse to isGroup=false. `kind` rides the received payload directly; the edited, reaction
            // and revoked events in this family carry only chatId, so derive it there.
            field: 'kind',
            kind: 'enum',
            operators: ENUM_OPERATORS,
            enumValues: exports.CHAT_KINDS,
            resolve: data => {
                const k = str(data.kind);
                if (k)
                    return k;
                const chatId = str(data.chatId);
                return chatId ? (0, wa_id_1.chatKind)(chatId) : undefined;
            },
        },
        {
            field: 'fromMe',
            kind: 'boolean',
            operators: BOOLEAN_OPERATORS,
            resolve: data => data.fromMe === true,
        },
        {
            field: 'hasMedia',
            kind: 'boolean',
            operators: BOOLEAN_OPERATORS,
            // Edit events carry an explicit marker rather than a media blob; preserve the blob-based
            // behaviour for received/sent messages while making the common message filter meaningful.
            resolve: data => data.hasMedia === true || data.media != null,
        },
        {
            field: 'mentions',
            kind: 'idArray',
            operators: ID_OPERATORS,
            resolve: data => (Array.isArray(data.mentionedIds) ? data.mentionedIds : []),
        },
    ],
};
/** `message.received` -> `message`. */
function eventFamily(event) {
    const dot = event.indexOf('.');
    return dot === -1 ? event : event.slice(0, dot);
}
function getFieldDefinition(family, field) {
    return exports.FILTER_FIELDS[family]?.find(f => f.field === field);
}
/** Find a field across all families (used by validation, which is family-agnostic). */
function findFieldDefinition(field) {
    for (const defs of Object.values(exports.FILTER_FIELDS)) {
        const found = defs.find(f => f.field === field);
        if (found)
            return found;
    }
    return undefined;
}
