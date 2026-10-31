import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useWebSocket } from './useWebSocket';
import { nextReconnectState } from '../utils/reconnectState';
import { createSessionFeedState, noteSessionFeedError, subscribeSessionFeed } from '../utils/sessionFeedSubscription';
/**
 * Owns the ONE `useWebSocket` call for the Sessions page plus the live session-feed subscription
 * (wildcard first, per-session fallback for scoped keys): `feedStateRef`, the transient
 * `feedErrorFrame`, and the four effects that keep the subscription correct across connect/reconnect
 * and roster changes. `useWebSocket` opens its own socket per call — a second call site anywhere else
 * on this page would double every handshake, subscribe storm, and `session.status` toast.
 *
 * `onQRCode`/`onSessionStatus` are owned by the caller (the page), not this hook: reacting to a status
 * push touches `sessions`/`selectedSession` state that lives in the page body (see the `useSessionList`
 * rejection), so this hook only wires the callbacks through — it never mutates the session list itself.
 */
export function useSessionFeed({ sessions, sessionsRef, onQRCode, onSessionStatus, onSessionRestriction, onReconnect, }) {
    // Live session-feed subscription state: wildcard first, per-session fallback for scoped keys.
    const feedStateRef = useRef(createSessionFeedState());
    // Most recent server error frame; folded into feedStateRef by the effect below (kept as state
    // so the fallback runs after `subscribe` exists — the handler can't reference it directly).
    const [feedErrorFrame, setFeedErrorFrame] = useState(null);
    const handleServerError = useCallback((frame) => {
        setFeedErrorFrame(frame);
    }, []);
    // The events object must be referentially stable: useWebSocket re-registers its socket handler
    // on every identity change, so an inline literal would tear down and re-attach per render.
    const wsEvents = useMemo(() => ({
        onQRCode,
        onSessionStatus,
        onSessionRestriction,
        onServerError: handleServerError,
    }), [onQRCode, onSessionStatus, onSessionRestriction, handleServerError]);
    const { isConnected, connectionFailed, reconnect, subscribe, rejoins } = useWebSocket(wsEvents);
    // Fold a server error frame into the feed state: a session-scoped key may not join the '*'
    // room — silently fall back to one subscription per listed session (the list endpoint is
    // already scope-filtered server-side), otherwise no status/QR push ever arrives and the QR
    // modal sits on "generating" forever.
    useEffect(() => {
        if (!feedErrorFrame)
            return;
        if (noteSessionFeedError(feedStateRef.current, feedErrorFrame.code)) {
            subscribeSessionFeed({ subscribe }, feedStateRef.current, sessionsRef.current.map(s => s.id));
        }
    }, [feedErrorFrame, subscribe, sessionsRef]);
    // Join the live session feed (wildcard attempt, or per-session rooms after a scope fallback).
    useEffect(() => {
        if (isConnected) {
            subscribeSessionFeed({ subscribe }, feedStateRef.current, sessionsRef.current.map(s => s.id));
        }
    }, [isConnected, subscribe, sessionsRef]);
    // Rooms are per-socket on the backend: a reconnect lands on a fresh socket with no
    // subscriptions, so the per-session dedup set must be forgotten or the join effect
    // above would skip every already-listed id and no feed frame would arrive again.
    useEffect(() => {
        if (!isConnected)
            feedStateRef.current.subscribedIds.clear();
    }, [isConnected]);
    // Re-subscribing is not enough: the pushes that fired during the gap are gone for good, and the
    // caller keeps its list in local state with no polling behind it, so a card would render its
    // pre-gap status until the operator reloaded the page. Tell the caller to re-read, on the RECONNECT
    // only and never on the first connect (nothing is cached yet, and the caller already fetched at
    // mount), unless the feed failed first: the banner's retry then recovers a feed that may never have
    // connected, and the mount read is as stale as any gap. Same pure transition the Chats page uses,
    // and idempotent: a re-run caused by a changed `onReconnect` identity sees the gap marker already
    // cleared and does not fetch twice.
    const hadConnected = useRef(false);
    const wasDisconnected = useRef(false);
    const rejoinsSeen = useRef(0);
    useEffect(() => {
        const decision = nextReconnectState({
            isConnected,
            hadConnected: hadConnected.current,
            wasDisconnected: wasDisconnected.current,
            connectionFailed,
        });
        hadConnected.current = decision.hadConnected;
        wasDisconnected.current = decision.wasDisconnected;
        const rejoined = rejoins !== rejoinsSeen.current;
        rejoinsSeen.current = rejoins;
        if (decision.invalidate || rejoined)
            onReconnect?.();
    }, [isConnected, connectionFailed, onReconnect, rejoins]);
    // In per-session mode, sessions loaded/created after the fallback still need their rooms.
    useEffect(() => {
        if (isConnected && feedStateRef.current.scope === 'per-session') {
            subscribeSessionFeed({ subscribe }, feedStateRef.current, sessions.map(s => s.id));
        }
    }, [isConnected, sessions, subscribe]);
    return { isConnected, connectionFailed, reconnect };
}
