"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionEngineEventWiring = exports.RECONNECT_LOOP_REASON = void 0;
const session_entity_1 = require("./entities/session.entity");
const reconnect_policy_1 = require("./reconnect-policy");
const session_reconnect_metrics_1 = require("../../common/metrics/session-reconnect-metrics");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const whatsapp_engine_interface_1 = require("../../engine/interfaces/whatsapp-engine.interface");
const wa_id_1 = require("../../engine/identity/wa-id");
/** The lastError an engine-internal reconnect episode records; onQRCode clears only this one. */
exports.RECONNECT_LOOP_REASON = 'Reconnecting after a dropped connection';
/**
 * The engine-callback wiring table extracted from SessionEngineLifecycle.initializeEngine: the 17
 * callbacks passed to engine.initialize(). Plain class (NOT a NestJS provider — the lifecycle's
 * constructor signature is frozen by specs), built inside the lifecycle's constructor. Stateless:
 * buildCallbacks closes over (id, engine, sessionName) and reaches the lifecycle exclusively
 * through `host`, so the emitted table is behaviorally identical to the inline original — the
 * per-callback liveness gating (onMessage/onMessageCreate/onMessageAck/onMessageRevoked/
 * onCredentialTeardownStarted are deliberately UNGATED) and every nested call's order preserved.
 * The callback bodies moved verbatim, which is why they read `this.logger` against the same-named
 * field assigned here; every other former `this.x` read goes through `host`. Specs capture the
 * table from `mockEngine.initialize.mock.calls[0][0]` and invoke callbacks directly.
 */
class SessionEngineEventWiring {
    logger;
    constructor(deps) {
        this.logger = deps.logger;
    }
    /**
     * `previousPhone` is the phone the session row carried when this engine started (null on a fresh
     * session), i.e. it had completed a link before. Its presence drives the relink warning below; its
     * value gates the onReady account-binding check that refuses a different number's rescan.
     * A QR from a previously-linked engine means the stored credentials are gone
     * or no longer accepted, and when that happened while the engine was down nothing else in the
     * log says so, hence the warning below. One-shot per engine start: a lifecycle reconnect builds a
     * new table from the row, which still carries the phone after a transient drop, and warns again.
     * After a terminal unlink the reconnect starts with no phone (the unlink cleared the binding and
     * logged its own warning), so it neither warns nor refuses the number that scans next.
     */
    buildCallbacks(id, engine, sessionName, host, previousPhone = null) {
        // The phone this session was bound to when this engine started (null on a fresh session). Its
        // presence is the relink signal used below; its value gates onReady's account-binding check.
        const previouslyLinked = Boolean(previousPhone);
        let relinkWarned = false;
        // When the current engine-internal reconnect streak started (epoch ms): stamped at attempt 1, or
        // at the first reconnect attempt after a READY, and cleared by onReady. An engine can carry its
        // attempt counter across a short-lived READY (Baileys does, so a link that drops right after
        // opening keeps backing off), and time spent READY is not downtime.
        // Closure state rather than a Map: it is scoped to this engine instance. A service-level
        // reconnect builds a new engine and a new callback table, so nothing has to be cleaned up.
        let reconnectingSince = 0;
        /**
         * Persist an engine-driven status, but only while this node still owns the session.
         *
         * Every caller has already passed the isLiveEngine fence; this closes the other axis. A node
         * whose lease lapsed keeps a live engine until the heartbeat's teardown completes, and a status
         * written in that window lands on a row a peer now owns. FAILED is the one that does not heal:
         * the boot reset and the takeover sweep both exclude it by design, so the session leaves every
         * automatic recovery path until an operator restarts it by hand.
         */
        const persistStatus = (status) => {
            if (!host.ownsSession(id)) {
                this.logger.warn('Skipped an engine status write for a session this node no longer owns', {
                    sessionId: id,
                    status,
                    action: 'status_write_skipped_not_owned',
                });
                return;
            }
            void host.updateStatus(id, status).catch(err => this.logger.warn('Failed to persist an engine status', {
                sessionId: id,
                status,
                error: err instanceof Error ? err.message : String(err),
            }));
        };
        return {
            onQRCode: (qr) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                this.logger.log('QR code generated', {
                    sessionId: id,
                    action: 'qr_generated',
                });
                // A whatsapp-web.js revocation that happened while the engine was down leaves no other trace:
                // the engine simply boots into the QR screen, with no LOGOUT, no auth failure and no audit
                // row. The paths where OpenWA itself discarded the credentials (a LOGOUT close, the
                // stuck-auth recovery) also end here, but each of those has already logged its own warning,
                // and starting a session under a different ENGINE_TYPE than it was linked with lands here too.
                if (previouslyLinked && !relinkWarned) {
                    relinkWarned = true;
                    this.logger.warn('Previously linked session is asking for a QR again: its stored credentials are missing or no ' +
                        'longer accepted. Unless an earlier warning for this session (LOGOUT, auth_cleared) or a changed ' +
                        'ENGINE_TYPE explains it, WhatsApp dropped the link while the engine was down (unlinked from the ' +
                        "phone, expired while offline, or the engine's stored auth state was lost). Check Linked devices " +
                        'on the phone before re-pairing.', { sessionId: id, action: 'relink_required' });
                }
                // A QR shows WhatsApp answered. Left in place, the recorded reconnect text would reappear in every
                // INITIALIZING gap between QR windows of a session waiting to be paired; if closes keep failing
                // after the QR, the next attempt from the fifth on writes it again. Any other reason stays.
                if (host.sessionErrors.get(id)?.startsWith(exports.RECONNECT_LOOP_REASON))
                    host.sessionErrors.clear(id);
                void host.webhookService.dispatch(id, 'session.qr', { sessionId: id, qr });
                // Push the QR to subscribed dashboard clients over the WebSocket (the `session.qr` event is
                // advertised + consumed there, so clients can render it live instead of polling GET /qr).
                host.eventsGateway.emitQRCode(id, qr);
                // Execute hook for QR event
                void host.hookManager.execute('session:qr', { sessionId: id }, {
                    sessionId: id,
                    source: 'Engine',
                });
                persistStatus(session_entity_1.SessionStatus.QR_READY);
            },
            onReady: (phone, pushName) => {
                reconnectingSince = 0;
                // Account-binding guard: a ready link whose number differs from the one this session is
                // already bound to is a different account scanning its QR (a takeover), not a re-link. Refuse
                // it rather than silently overwrite the binding. An empty incoming phone (wwjs can report one)
                // is not identifiable, so it is never treated as a mismatch.
                if (previousPhone && phone && (0, wa_id_1.userPart)(phone) !== (0, wa_id_1.userPart)(previousPhone)) {
                    void host.rejectRebind(id, engine, sessionName, previousPhone, phone);
                    return;
                }
                host.handleEngineReady(id, engine, phone, pushName);
            },
            // PostgreSQL only: holds each inbound message from arrival until its row is written.
            ...(host.messages.holdsInbound
                ? { admitInbound: arrival => host.messages.admitInbound(id, engine, arrival) }
                : {}),
            onMessage: (message, ticket) => host.messages.handleInboundMessage(id, engine, message, ticket),
            onHistoryMessages: messages => {
                if (!host.isLiveEngine(id, engine))
                    return;
                // Persist for the chat view only; no dispatch (these predate the live session).
                return host.messages
                    .persistHistoryMessages(id, engine, messages)
                    .catch(err => this.logger.error(`Failed to persist history messages for ${id}`, String(err)));
            },
            onMessageCreate: (message, ticket) => host.messages.handleOwnSendEcho(id, engine, message, ticket),
            onMessageAck: (messageId, status, chatId) => host.messages.handleMessageAck(id, engine, messageId, status, chatId),
            onMessageReceipt: (event) => host.messages.handleMessageReceipt(id, engine, event),
            onMessageRevoked: (message, actor) => host.messages.handleMessageRevoked(id, engine, message, actor),
            onMessageReaction: (event) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                if (!event.messageId) {
                    this.logger.warn('Ignoring message reaction without a target message id', {
                        sessionId: id,
                        action: 'message_reaction_ignored',
                    });
                    return;
                }
                this.logger.debug(`Message reaction received: ${event.messageId} -> ${event.reaction}`, {
                    sessionId: id,
                    messageId: event.messageId,
                    action: 'message_reaction_received',
                });
                host.messages.applyReactionQueued(id, event);
            },
            onMessageEdited: (message) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                if (!message.messageId) {
                    this.logger.warn('Ignoring message edit without a target message id', {
                        sessionId: id,
                        action: 'message_edit_ignored',
                    });
                    return;
                }
                this.logger.debug(`Message edited: ${message.messageId}`, {
                    sessionId: id,
                    messageId: message.messageId,
                    action: 'message_edited',
                });
                host.messages.applyMessageEditQueued(id, message);
            },
            onEventResponse: (event) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                this.logger.debug(`Event response: ${event.response} to ${event.eventMessageId}`, {
                    sessionId: id,
                    chatId: event.chatId,
                    eventMessageId: event.eventMessageId,
                    action: 'event_response',
                });
                const payload = { sessionId: id, ...event };
                host.eventsGateway.emitEventResponse(id, payload);
                void host.webhookService.dispatch(id, 'event.response', payload);
            },
            onPollVote: (event) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                if (!event.pollMessageId) {
                    this.logger.warn('Ignoring poll vote without a poll message id', {
                        sessionId: id,
                        action: 'poll_vote_ignored',
                    });
                    return;
                }
                this.logger.debug(`Poll vote: ${event.selectedOptions.length} option(s) on ${event.pollMessageId}`, {
                    sessionId: id,
                    chatId: event.chatId,
                    pollMessageId: event.pollMessageId,
                    action: 'poll_vote',
                });
                const payload = { sessionId: id, ...event };
                host.eventsGateway.emitPollVote(id, payload);
                void host.webhookService.dispatch(id, 'poll.vote', payload);
            },
            onGroupEvent: (event) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                this.logger.debug(`Group event: ${event.kind} in ${event.groupId}`, {
                    sessionId: id,
                    groupId: event.groupId,
                    kind: event.kind,
                    action: 'group_event',
                });
                host.leafEvents.dispatchGroupEvent(id, event);
            },
            onCall: (event) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                this.logger.log('Incoming call', {
                    sessionId: id,
                    callId: event.callId,
                    isVideo: event.isVideo,
                    isGroup: event.isGroup,
                    action: 'call_received',
                });
                const payload = { ...event };
                host.eventsGateway.emitCallReceived(id, payload);
                void host.webhookService.dispatch(id, 'call.received', payload);
                // Opt-in auto-reject runs AFTER the dispatch so a reject failure can never eat the event.
                void host.leafEvents.maybeAutoRejectCall(id, engine, event.callId);
            },
            onReconnecting: (attempt, nextDelayMs) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                // Count it whichever layer scheduled it: the counter's published meaning is "reconnect
                // attempts scheduled across all sessions", and an engine that retries internally was simply
                // never counted, so the series read 0 on Baileys however long a session looped.
                (0, session_reconnect_metrics_1.incrementSessionReconnectAttempts)();
                if (attempt === 1 || reconnectingSince === 0)
                    reconnectingSince = Date.now();
                // Below the loop threshold this is a blip, not an episode: the 515 restart WhatsApp asks for
                // right after a successful pairing is one attempt, and so is any drop that comes straight
                // back. Reporting those would put "reconnecting" on a session that is linking normally.
                if (attempt < reconnect_policy_1.RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS)
                    return;
                const downForSeconds = Math.round((Date.now() - reconnectingSince) / 1000);
                const downFor = downForSeconds >= 120 ? `${Math.round(downForSeconds / 60)}m` : `${downForSeconds}s`;
                // The engine holds the session at INITIALIZING for the whole episode, which is the same thing
                // it reports for a session waiting to be paired. Record why, so `lastError` says so on
                // GET /sessions/:id, the only durable operator surface this path reaches. Rewritten on every
                // attempt from here on, so the attempt and the downtime it shows never lag the episode.
                host.sessionErrors.set(id, `${exports.RECONNECT_LOOP_REASON} (attempt ${attempt}, down for ${downFor}).`);
                if (attempt % reconnect_policy_1.RECONNECT_LOOP_ALERT_INTERVAL_ATTEMPTS !== 0)
                    return;
                // Same cadence, same log shape and the same already-documented webhook the service-level
                // reconnect path emits, so an operator watching for a stuck session does not have to know
                // which layer happens to be doing the retrying.
                this.logger.warn(`Session is reconnect-looping: attempt ${attempt} scheduled`, {
                    sessionId: id,
                    attempts: attempt,
                    nextDelayMs,
                    downForSeconds,
                    action: 'reconnect_loop',
                });
                (0, session_reconnect_metrics_1.incrementSessionReconnectLoopAlerts)();
                void host.webhookService.dispatch(id, 'session.reconnect_loop', {
                    sessionId: id,
                    attempts: attempt,
                    nextDelayMs,
                });
            },
            onDisconnected: (reason) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                // Shared with the liveness watchdog (see handleEngineDisconnected). Pass the captured
                // engine so the handler can re-check identity across its DB await — this closure's `engine`
                // (and `session`) snapshots can be stale by the time a disconnect lands, so the handler
                // re-reads the row itself and fences every side effect on `engine` still being the live
                // owner. The captured engine is the exact generation token (no numeric counter).
                void host.handleEngineDisconnected(id, engine, reason);
            },
            onStateChanged: (engineState) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                if (engineState !== whatsapp_engine_interface_1.EngineStatus.READY)
                    host.endReadyStretch(id);
                const statusMap = {
                    [whatsapp_engine_interface_1.EngineStatus.DISCONNECTED]: session_entity_1.SessionStatus.DISCONNECTED,
                    [whatsapp_engine_interface_1.EngineStatus.INITIALIZING]: session_entity_1.SessionStatus.INITIALIZING,
                    [whatsapp_engine_interface_1.EngineStatus.QR_READY]: session_entity_1.SessionStatus.QR_READY,
                    [whatsapp_engine_interface_1.EngineStatus.AUTHENTICATING]: session_entity_1.SessionStatus.AUTHENTICATING,
                    [whatsapp_engine_interface_1.EngineStatus.READY]: session_entity_1.SessionStatus.READY,
                    [whatsapp_engine_interface_1.EngineStatus.ACTION_REQUIRED]: session_entity_1.SessionStatus.ACTION_REQUIRED,
                    [whatsapp_engine_interface_1.EngineStatus.FAILED]: session_entity_1.SessionStatus.FAILED,
                };
                const newStatus = statusMap[engineState];
                if (!newStatus)
                    return;
                // An operator-initiated teardown reports DISCONNECTED on entry, before the engine is
                // evicted: whatsapp-web.js sets the status and only then awaits browser.close(). Announced
                // here it would tell every consumer the session is down while GET /sessions still reports
                // the engine as loaded, and the verb's own write after the eviction is dropped as a
                // duplicate, so the settled view would never be announced at all. Skipped for the exact
                // instance being torn down; stop/logout/forceKill each write DISCONNECTED afterwards, and a
                // retired start or reconnect writes it only on a row that is still this node's or unowned.
                if (newStatus === session_entity_1.SessionStatus.DISCONNECTED && host.isOperatorTeardown(id, engine))
                    return;
                // A FAILED reported inside a service-level reconnect's init window is parked with onError.
                const persist = () => persistStatus(newStatus);
                if (newStatus === session_entity_1.SessionStatus.FAILED && host.parkReconnectInitFailure(id, persist))
                    return;
                persist();
            },
            onActionRequired: (reason) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                this.logger.warn(`Session requires operator action: ${reason}`, {
                    sessionId: id,
                    reason,
                    action: 'action_required',
                });
                // Record the reason so the last-error projection surfaces it while the session is
                // ACTION_REQUIRED, then updateStatus (via onStateChanged above) has already written the
                // status. Set here too to be defensive: the callback order is onStateChanged then
                // onActionRequired, but persisting the reason here means it is available regardless.
                host.sessionErrors.set(id, reason);
                void host.hookManager.execute('session:error', { reason }, { sessionId: id, source: 'Engine' });
            },
            onCallOutcome: (event) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                this.logger.log(`Call ${event.outcome}: ${event.callId}`, {
                    sessionId: id,
                    callId: event.callId,
                    outcome: event.outcome,
                    action: 'call_outcome',
                });
                const payload = { sessionId: id, ...event };
                // One event per outcome rather than a single call.ended carrying a field: a consumer that
                // only cares about missed calls should be able to subscribe to exactly that.
                if (event.outcome === 'accepted') {
                    host.eventsGateway.emitCallAccepted(id, payload);
                    void host.webhookService.dispatch(id, 'call.accepted', payload);
                }
                else if (event.outcome === 'rejected') {
                    host.eventsGateway.emitCallRejected(id, payload);
                    void host.webhookService.dispatch(id, 'call.rejected', payload);
                }
                else {
                    host.eventsGateway.emitCallMissed(id, payload);
                    void host.webhookService.dispatch(id, 'call.missed', payload);
                }
            },
            onPresenceUpdate: (event) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                // WhatsApp reports presence on every transition and freely repeats itself, so only an actual
                // change is published. Without this, one watched chat with an active typist produces a
                // continuous stream of identical events — enough to drown every other webhook a consumer
                // subscribes to. The store is the only thing that knows the previous state, so it decides.
                if (!host.presence.record(id, event))
                    return;
                const payload = { sessionId: id, ...event };
                host.eventsGateway.emitPresenceUpdate(id, payload);
                void host.webhookService.dispatch(id, 'presence.update', payload);
            },
            onAccountRestriction: (restriction) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                // A lift is only news if we were holding a restriction; an engine that reports "no
                // restriction" on every connect (the Baileys probe does exactly that) must stay quiet.
                if (!restriction) {
                    const lifted = host.sessionRestrictions.clear(id);
                    if (lifted)
                        host.reportRestrictionLifted(id, lifted);
                    return;
                }
                // Both engines repeat an unchanged restriction — whatsapp-web.js on every reconnect attempt,
                // Baileys on every connect probe — so only a change reaches an operator.
                if (!host.sessionRestrictions.set(id, restriction))
                    return;
                this.logger.warn(`WhatsApp restricted this session's account: ${restriction.kind}`, {
                    sessionId: id,
                    kind: restriction.kind,
                    code: restriction.code,
                    expiresAt: restriction.expiresAt,
                    action: 'account_restricted',
                });
                const payload = {
                    active: true,
                    kind: restriction.kind,
                    code: restriction.code,
                    expiresAt: restriction.expiresAt ? new Date(restriction.expiresAt).toISOString() : null,
                };
                void host.webhookService.dispatch(id, 'session.restriction', { sessionId: id, ...payload });
                host.eventsGateway.emitSessionRestriction(id, payload);
                // Audited, unlike the engine-level connect/disconnect transitions next door: this is rare,
                // it is not reconnect noise, and the store that serves it to the API is in memory — so this
                // row is the only durable record of when the account was restricted.
                void host.auditService?.logWarn(audit_log_entity_1.AuditAction.SESSION_RESTRICTED, {
                    sessionId: id,
                    metadata: {
                        kind: restriction.kind,
                        code: restriction.code,
                        expiresAt: restriction.expiresAt ? new Date(restriction.expiresAt).toISOString() : null,
                    },
                    errorMessage: `WhatsApp restricted this account: ${restriction.kind} (${restriction.code})`,
                });
            },
            onError: (reason) => {
                if (!host.isLiveEngine(id, engine))
                    return;
                this.logger.error(`Session engine failed: ${reason}`, undefined, {
                    sessionId: id,
                    reason,
                    action: 'engine_error',
                });
                // Remember the reason so findOne/findAll can surface it to the dashboard,
                // then persist the FAILED status. This is terminal — no reconnect is
                // scheduled (unlike onDisconnected), since re-scanning is required.
                host.sessionErrors.set(id, reason);
                const fail = () => {
                    // A prior onDisconnected may have scheduled a reconnect. This failure is terminal
                    // (re-scan required), so cancel it — otherwise the pending timer would resurrect a
                    // session the operator must manually restart.
                    host.cancelReconnect(id);
                    void host.hookManager.execute('session:error', { reason }, {
                        sessionId: id,
                        source: 'Engine',
                    });
                    persistStatus(session_entity_1.SessionStatus.FAILED);
                    // onError is terminal (no reconnect is scheduled — re-scan is required). Evict the dead engine
                    // and SIGKILL its process: leaving it in the map would hold a concurrency slot indefinitely and
                    // make the next start() reject the session as "already started" instead of re-initializing it.
                    host.evictAndForceDestroy(id, engine);
                };
                // During a service-level reconnect's init the lifecycle parks this instead: once init settles it
                // either applies it or, for a retryable failure, evicts the engine and re-arms the backoff.
                if (!host.parkReconnectInitFailure(id, fail, reason))
                    fail();
            },
            onCredentialTeardownStarted: (operation) => {
                // The adapter fired the moment it began the call that ends in an fs.rm of this session's
                // on-disk auth dir. Track it under the captured session NAME (the fence key — see
                // awaitPendingTeardown), and NOT guarded on this engine still being live: a logout that
                // captured this engine must register its destructive promise even as a concurrent
                // stop()/delete() evicts it, or the rm would race a start this fence should have held back.
                // `session.name` is the immutable snapshot captured at initializeEngine entry, so a row
                // delete/recreate under the same name cannot poison the key.
                host.trackPendingCredentialTeardown(sessionName, operation);
            },
            claimStuckAuthRecovery: () => host.claimStuckAuthRecovery(id, engine),
        };
    }
}
exports.SessionEngineEventWiring = SessionEngineEventWiring;
