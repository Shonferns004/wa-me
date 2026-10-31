"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WILDCARD_EXCLUDED_EVENTS = void 0;
exports.subscriptionCoversEvent = subscriptionCoversEvent;
/**
 * Events a '*' subscription (webhook or socket) does NOT receive; they are delivered only when named
 * explicitly. A `message.receipt` fires once per recipient (a message to a 1,000-member group yields
 * about 2,000), so folding it into '*' would multiply the traffic of every existing catch-all subscriber.
 */
exports.WILDCARD_EXCLUDED_EVENTS = ['message.receipt'];
/** Whether a subscription to `events` covers `event`, honouring the '*' exclusions above. */
function subscriptionCoversEvent(events, event) {
    return events.includes(event) || (events.includes('*') && !exports.WILDCARD_EXCLUDED_EVENTS.includes(event));
}
