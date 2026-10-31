"use strict";
// src/modules/events/dto/ws-messages.dto.ts
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUBSCRIBABLE_EVENTS = void 0;
exports.buildRoomName = buildRoomName;
/**
 * WebSocket message types for subscription protocol
 */
// Valid event types that can be subscribed to over the socket. Every entry here MUST have a
// matching EventsGateway.emit* producer — the drift guard in events.gateway.spec asserts this.
exports.SUBSCRIBABLE_EVENTS = [
    'message.received',
    'message.sent',
    'message.ack',
    'message.receipt',
    'message.revoked',
    'message.reaction',
    'message.edited',
    'session.status',
    'session.qr',
    'session.authenticated',
    'session.disconnected',
    'session.restriction',
    'group.join',
    'group.leave',
    'group.update',
    'group.join_request',
    'call.received',
    'status.received',
    'presence.update',
    'event.response',
    'poll.vote',
    'call.accepted',
    'call.rejected',
    'call.missed',
];
// Room name builder
function buildRoomName(sessionId, event) {
    return `session:${sessionId}:${event}`;
}
