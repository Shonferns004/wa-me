"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildIncomingStatus = buildIncomingStatus;
/**
 * Collapse the rich MessageType to the status union.
 *
 * `voice` is listed explicitly because both engines map a PTT message to it, and without that an
 * incoming voice status would be stored as `text` — the bucket everything non-image/video fell into.
 */
function statusType(t) {
    return t === 'image' || t === 'video' || t === 'voice' ? t : 'text';
}
/**
 * Build a neutral IncomingStatus from an inbound status-broadcast message, or null if `msg` is not a
 * usable status: not a status broadcast, missing an id, or the resolved poster is empty/the
 * `status@broadcast` pseudo-JID itself. For a status broadcast the adapter puts the actual poster in
 * `author` (`from` is the shared `status@broadcast` channel), falling back to `from` for engines that
 * don't set `author`.
 */
function buildIncomingStatus(msg) {
    if (!msg.isStatusBroadcast || !msg.id)
        return null;
    const contactJid = msg.author ?? msg.from;
    if (!contactJid || contactJid === 'status@broadcast')
        return null;
    return {
        waStatusId: msg.id,
        contactJid,
        contactName: msg.contact?.name,
        contactPushName: msg.contact?.pushName,
        type: statusType(msg.type),
        caption: msg.body || undefined,
        backgroundColor: msg.backgroundColor,
        font: msg.font,
        media: msg.media
            ? {
                mimetype: msg.media.mimetype,
                data: msg.media.data,
                omitted: msg.media.omitted,
                sizeBytes: msg.media.sizeBytes,
            }
            : undefined,
        postedAt: msg.timestamp * 1000,
    };
}
