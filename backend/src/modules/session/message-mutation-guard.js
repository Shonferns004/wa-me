"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.phoneKey = phoneKey;
exports.provablyDifferent = provablyDifferent;
exports.mutationTargetsForeignRow = mutationTargetsForeignRow;
exports.mutationTargetsForeignRowPersisted = mutationTargetsForeignRowPersisted;
exports.receiptTargetsForeignRow = receiptTargetsForeignRow;
exports.receiptTargetsForeignRowPersisted = receiptTargetsForeignRowPersisted;
const message_entity_1 = require("../message/entities/message.entity");
const wa_id_1 = require("../../engine/identity/wa-id");
/**
 * What two spellings of one phone number share: its digits, without a '+', spaces or dashes, and without
 * the mobile marker digit that a Brazilian (`55` + area + `9`), Mexican (`521`) or Argentine (`549`) number
 * is written with in one spelling and without in the other. A send stores the chat id as its caller wrote
 * it, so the stored form and the one the engine reports can differ in either direction.
 */
function phoneKey(local) {
    return local
        .replace(/\D/g, '')
        .replace(/^55(\d{2})9(\d{8})$/, '55$1$2')
        .replace(/^521(\d{10})$/, '52$1')
        .replace(/^549(\d+)$/, '54$1');
}
/**
 * The entity an id names, whatever its dialect: a phone (`@c.us`, `@s.whatsapp.net`, hosted, a `:device`
 * form or a bare number, which is how the send routes may have stored it), a lid, a group or a list.
 * Null for an id this cannot place, which proves nothing.
 */
function entityOf(jid) {
    const parsed = (0, wa_id_1.parseWaId)(jid);
    if (parsed.kind === 'user')
        return { kind: 'user', id: phoneKey(parsed.userPart) };
    if (parsed.kind !== 'unknown')
        return { kind: parsed.kind, id: parsed.userPart };
    return !jid.includes('@') && /^\+?\d[\d -]*$/.test(jid.trim()) ? { kind: 'user', id: phoneKey(jid) } : null;
}
const isPerson = (kind) => kind === 'user' || kind === 'lid';
/**
 * A message the account sent to a broadcast list, or posted as a status, is filed under the list or the
 * status chat, while each recipient or viewer reacts from their own one-to-one chat: no chat can ever
 * match it. The engine adapters exempt exactly this case for a reaction, and so does the guard.
 */
function isOwnBroadcast(row) {
    const kind = entityOf(row.chatId)?.kind;
    return row.direction === message_entity_1.MessageDirection.OUTGOING && (kind === 'broadcast' || kind === 'status');
}
/**
 * A message received through a contact's broadcast list was filed under the list id by earlier versions
 * (its row says `<id>@broadcast`, incoming), though the dashboard and the engines show it in the one-to-one
 * chat with its sender. A change to it names the sender's chat, which is the chat of that message as well,
 * for as long as the row keeps the list id.
 */
function receivedThroughList(row, chatId, resolveLid) {
    return (row.direction === message_entity_1.MessageDirection.INCOMING &&
        entityOf(row.chatId)?.kind === 'broadcast' &&
        !provablyDifferent(row.author, chatId, resolveLid));
}
/**
 * Whether two ids provably name different chats or people, compared by the entity they name rather than
 * by dialect or spelling. A LID and phone match only through a reported directory pairing.
 */
function provablyDifferent(a, b, resolveLid) {
    if (!a || !b || a === b)
        return false;
    const left = entityOf(a);
    const right = entityOf(b);
    if (!left || !right)
        return false;
    if (left.kind === right.kind)
        return left.id !== right.id;
    if (!isPerson(left.kind) || !isPerson(right.kind))
        return true;
    const lid = left.kind === 'lid' ? a : b;
    const phone = left.kind === 'user' ? left.id : right.id;
    const mapped = resolveLid?.(lid);
    return !mapped || phoneKey(mapped) !== phone;
}
/**
 * Why a change must not touch the stored row it names, or null when it may.
 *
 * Baileys applies no validation to an edit, a revoke or a reaction: it hands over whatever a participant
 * sent, naming any message id the sender knows. The engine adapter checks it against its own message
 * store, which holds the newest few thousand messages and never a history-synced one, so for an older
 * message only this row can tell. WhatsApp clients ignore a change made by somebody other than the
 * author, so applying it would make the gateway's record say what no client shows.
 *
 *  - `chat`: a message id belongs to one chat. A reaction to a message the account sent to a broadcast
 *    list or posted as a status is the exception: its recipients react from their own chats. So is any
 *    change to a received list message that an earlier version filed under the list, from its sender's chat.
 *  - `direction`: an edit, and a revoke in a one-to-one chat, come from the author only, so a change
 *    made by the counterparty cannot name a message the account sent, nor the reverse. Group revokes are
 *    exempt, since an admin may delete anyone's message.
 *  - `author`: a group edit comes from the participant who wrote the message.
 */
function mutationTargetsForeignRow(row, source, resolveLid) {
    const listed = (source.kind === 'reaction' && isOwnBroadcast(row)) || receivedThroughList(row, source.chatId, resolveLid);
    if (!listed && provablyDifferent(row.chatId, source.chatId, resolveLid))
        return 'chat';
    const group = source.chatId.endsWith('@g.us') || row.chatId.endsWith('@g.us');
    const authorOnly = source.kind === 'edit' || (source.kind === 'revoke' && !group);
    if (authorOnly && source.fromMe !== undefined) {
        const expected = source.fromMe ? message_entity_1.MessageDirection.OUTGOING : message_entity_1.MessageDirection.INCOMING;
        if (row.direction && row.direction !== expected)
            return 'direction';
    }
    if (source.kind === 'edit' &&
        group &&
        source.fromMe === false &&
        provablyDifferent(row.author, source.author, resolveLid)) {
        return 'author';
    }
    return null;
}
/** Resolve only cross-dialect comparisons through reported directory data; distinct LIDs stay distinct. */
async function mutationTargetsForeignRowPersisted(row, source, resolveLid) {
    if (!resolveLid)
        return mutationTargetsForeignRow(row, source);
    const phones = new Map();
    await Promise.all([...new Set([row.chatId, row.author, source.chatId, source.author])].map(async (jid) => {
        if (jid && (0, wa_id_1.parseWaId)(jid).kind === 'lid')
            phones.set(jid, await resolveLid(jid).catch(() => null));
    }));
    return mutationTargetsForeignRow(row, source, jid => phones.get(jid) ?? null);
}
/**
 * Whether a delivery or read receipt naming `chatId` provably belongs to another chat than the stored row of the
 * message it names. Baileys relays a peer's receipt under the peer's own chat with every id the stanza lists, and
 * checks none of them against that chat, so a receipt from one chat could otherwise move another chat's message.
 *
 * A receipt for a message the account sent to a broadcast list comes from each recipient's own chat, and one for a
 * list message an earlier version filed under the list from its sender's chat: neither is foreign. A lid and a
 * phone with no reported pairing prove nothing either. A receipt only ever moves delivery state forward, and
 * refusing it would leave the account's messages to a lid-addressed contact at sent.
 */
function receiptTargetsForeignRow(row, chatId, resolveLid) {
    if (isOwnBroadcast(row) || receivedThroughList(row, chatId, resolveLid))
        return false;
    const stored = entityOf(row.chatId);
    const named = entityOf(chatId);
    if (stored && named && stored.kind !== named.kind && isPerson(stored.kind) && isPerson(named.kind)) {
        if (!resolveLid?.(stored.kind === 'lid' ? row.chatId : chatId))
            return false;
    }
    return provablyDifferent(row.chatId, chatId, resolveLid);
}
/** {@link receiptTargetsForeignRow} with the lids it compares resolved through reported directory data. */
async function receiptTargetsForeignRowPersisted(row, chatId, resolveLid) {
    if (!resolveLid)
        return receiptTargetsForeignRow(row, chatId);
    const phones = new Map();
    await Promise.all([...new Set([row.chatId, row.author, chatId])].map(async (jid) => {
        if (jid && (0, wa_id_1.parseWaId)(jid).kind === 'lid')
            phones.set(jid, await resolveLid(jid).catch(() => null));
    }));
    return receiptTargetsForeignRow(row, chatId, jid => phones.get(jid) ?? null);
}
