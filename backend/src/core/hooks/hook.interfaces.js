"use strict";
/**
 * Hook System Interfaces
 * Central event bus for plugin integration
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KNOWN_HOOK_EVENTS = void 0;
exports.isKnownHookEvent = isKnownHookEvent;
// Runtime allowlist of every HookEvent. The Record is exhaustively typed, so adding a HookEvent above
// without listing it here is a COMPILE error — keeping the runtime set in lockstep with the type.
// Used to reject fabricated event names at the sandbox IPC boundary (HookEvent is type-only; the wire
// payload is an arbitrary string), bounding host-registry growth to this finite set.
const HOOK_EVENT_REGISTRY = {
    'session:created': true,
    'session:starting': true,
    'session:ready': true,
    'session:qr': true,
    'session:disconnected': true,
    'session:error': true,
    'session:deleted': true,
    'message:received': true,
    'message:sending': true,
    'message:sent': true,
    'message:failed': true,
    'message:ack': true,
    'message:persisted': true,
    'message:deleted': true,
    'webhook:before': true,
    'webhook:queued': true,
    'webhook:delivered': true,
    'webhook:after': true,
    'webhook:error': true,
    'ingress:error': true,
};
exports.KNOWN_HOOK_EVENTS = new Set(Object.keys(HOOK_EVENT_REGISTRY));
/** Type guard: is `event` one of the known HookEvent values? Narrows an untrusted string to HookEvent. */
function isKnownHookEvent(event) {
    return exports.KNOWN_HOOK_EVENTS.has(event);
}
