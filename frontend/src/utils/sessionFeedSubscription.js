// Live session-feed (session.status / session.qr) subscription with scoped-key fallback.
//
// The dashboard first tries the '*' wildcard room — one round trip covering every session.
// A session-scoped API key is NOT allowed to join '*' (the gateway answers with a
// FORBIDDEN_SESSION error frame instead of an ack), so the client silently falls back to
// one subscription per visible session. The sessions list endpoint is already scope-filtered
// server-side, so every listed session is joinable.
export const SESSION_FEED_EVENTS = ['session.status', 'session.qr', 'session.restriction'];
export function createSessionFeedState() {
    return { scope: 'wildcard', subscribedIds: new Set() };
}
export function subscribeSessionFeed(sink, state, sessionIds) {
    if (state.scope === 'wildcard') {
        sink.subscribe('*', [...SESSION_FEED_EVENTS]);
        return;
    }
    for (const id of sessionIds) {
        if (state.subscribedIds.has(id))
            continue;
        state.subscribedIds.add(id);
        sink.subscribe(id, [...SESSION_FEED_EVENTS]);
    }
}
/**
 * Fold a server error frame into the feed state. Returns true exactly once — when the frame
 * rejects the wildcard subscription on scope grounds — telling the caller to re-run
 * subscribeSessionFeed (now per-session). Any other error, or a repeat, leaves state alone.
 */
export function noteSessionFeedError(state, code) {
    if (state.scope !== 'wildcard' || code !== 'FORBIDDEN_SESSION')
        return false;
    state.scope = 'per-session';
    return true;
}
