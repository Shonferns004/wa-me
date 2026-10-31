"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deliveryStatusToMessageStatus = deliveryStatusToMessageStatus;
exports.deliveryStatusToAck = deliveryStatusToAck;
exports.ackStatusTransitionFrom = ackStatusTransitionFrom;
const message_entity_1 = require("./entities/message.entity");
/**
 * Maps a neutral engine DeliveryStatus to the stored MessageStatus it implies, or null when the
 * status carries no upgrade beyond the stored `SENT` state. This is how the stored message reflects
 * *real* delivery state (#220): a send that never advances past `sent` stays `SENT`, visibly
 * "not delivered". Engine-specific ack codes are mapped to DeliveryStatus inside the adapter.
 */
function deliveryStatusToMessageStatus(status) {
    switch (status) {
        case 'failed':
            return message_entity_1.MessageStatus.FAILED;
        case 'read':
            return message_entity_1.MessageStatus.READ;
        case 'delivered':
            return message_entity_1.MessageStatus.DELIVERED;
        default:
            return null; // pending / sent — already at/below SENT, no upgrade
    }
}
/**
 * @deprecated Legacy whatsapp-web.js-style ack integer, derived from the neutral DeliveryStatus
 * solely for backward compatibility of the `message.ack`/`message.failed` webhook payload's `ack`
 * field. New consumers should read the neutral `status` field instead. (-1 error, 0 pending,
 * 1 sent, 2 delivered, 3 read.)
 */
function deliveryStatusToAck(status) {
    switch (status) {
        case 'failed':
            return -1;
        case 'read':
            return 3;
        case 'delivered':
            return 2;
        case 'sent':
            return 1;
        default:
            return 0; // pending
    }
}
/**
 * The stored statuses a delivery transition may advance FROM. Used as a conditional UPDATE guard so
 * delivery state only moves forward — preventing an out-of-order/late ack from downgrading a higher
 * status (e.g. a DELIVERED ack arriving after READ), even though the writes are fire-and-forget.
 * A late FAILED must not clobber a message already confirmed delivered/read, and vice versa.
 */
function ackStatusTransitionFrom(target) {
    switch (target) {
        case message_entity_1.MessageStatus.DELIVERED:
            return [message_entity_1.MessageStatus.PENDING, message_entity_1.MessageStatus.SENT];
        case message_entity_1.MessageStatus.READ:
            return [message_entity_1.MessageStatus.PENDING, message_entity_1.MessageStatus.SENT, message_entity_1.MessageStatus.DELIVERED];
        case message_entity_1.MessageStatus.FAILED:
            return [message_entity_1.MessageStatus.PENDING, message_entity_1.MessageStatus.SENT];
        default:
            return [];
    }
}
