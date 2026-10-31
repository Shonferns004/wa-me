"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStatusBroadcaster = void 0;
/**
 * The session-status fan-out extracted from SessionEngineLifecycle: persist the status, then
 * mirror it to WS clients and subscribed webhooks, de-duped. Plain class (NOT a NestJS provider —
 * the lifecycle's constructor signature is frozen by specs), built inside the lifecycle's
 * constructor. The de-dup Map is OWNED here; the lifecycle exposes a `lastDispatchedStatus`
 * getter alias returning it by reference (the liveCalls precedent) so the spec's `.set()` pokes
 * land on this exact instance, and keeps `updateStatus` as a public delegate so its 9 call sites
 * stay byte-identical. The method body below moved verbatim, which is why it reads
 * `this.sessionRepository` / `this.eventsGateway` / `this.webhookService` / `this.logger` against
 * the same-named fields assigned here.
 */
class SessionStatusBroadcaster {
    // Last session.status value broadcast per session. Some engines signal one transition via BOTH
    // onStateChanged and a dedicated callback (onQRCode/onDisconnected), so this guards both the WS emit
    // and the webhook POST against firing the same status twice. Cleared on delete(), and before a
    // lapsed-row or released-row correction is announced (see SessionEngineLifecycle.announceStatus).
    lastDispatchedStatus = new Map();
    sessionRepository;
    eventsGateway;
    webhookService;
    logger;
    constructor(deps) {
        this.sessionRepository = deps.sessionRepository;
        this.eventsGateway = deps.eventsGateway;
        this.webhookService = deps.webhookService;
        this.logger = deps.logger;
    }
    /**
     * `canAnnounce`, when given, is asked once the write has settled: a caller whose engine can retire
     * while the write is in flight keeps a late reply from announcing a status that is no longer current.
     */
    async updateStatus(id, status, canAnnounce) {
        await this.sessionRepository.update(id, { status });
        this.logger.debug(`Session status updated to ${status}`, {
            sessionId: id,
            status,
            action: 'status_update',
        });
        if (canAnnounce?.() === false)
            return;
        this.announce(id, status);
    }
    /**
     * The fan-out half of updateStatus, for a caller that has ALREADY written the row itself.
     *
     * A write that can land after the session changed hands has to go under a predicate, never by id,
     * because a peer can claim and start the row at any moment; writing by id afterwards to get the
     * fan-out would undo the predicate. Four writes need that split: the correction of a row whose
     * owning node is gone (still that node's, still lapsed, still claiming to run) and a failed start's
     * released row (unclaimed, still claiming to run), both through SessionEngineLifecycle.announceStatus,
     * and the retired launch and the init-timeout eviction (this node's row or an unowned one), which
     * call this directly. Everything else must keep using updateStatus.
     */
    announce(id, status) {
        // Mirror the status change to WS clients AND subscribed webhooks — both de-duped. Some engines signal
        // one transition via both onStateChanged AND a dedicated callback (onQRCode/onDisconnected), which
        // would otherwise emit/POST the same status twice; only act when it actually changed from the last one.
        if (this.lastDispatchedStatus.get(id) !== status) {
            this.lastDispatchedStatus.set(id, status);
            this.eventsGateway.emitSessionStatus(id, status);
            void this.webhookService.dispatch(id, 'session.status', { sessionId: id, status });
        }
    }
    /**
     * Drop the de-dup entry for a session — called from delete()'s committed-delete cleanup, and
     * before a lapsed-row or released-row correction announces, since that write is a transition this
     * process never saw.
     */
    clear(id) {
        this.lastDispatchedStatus.delete(id);
    }
}
exports.SessionStatusBroadcaster = SessionStatusBroadcaster;
