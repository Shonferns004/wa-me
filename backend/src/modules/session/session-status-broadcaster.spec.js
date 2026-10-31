"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_entity_1 = require("./entities/session.entity");
const session_status_broadcaster_1 = require("./session-status-broadcaster");
/**
 * Direct coverage for the session-status fan-out: persist first, then mirror to WS and webhooks,
 * de-duped per status value (some engines signal one transition via BOTH onStateChanged and a
 * dedicated callback). Until now pinned only through the session-service suite's white-box pokes on
 * the lifecycle's lastDispatchedStatus alias.
 */
describe('SessionStatusBroadcaster', () => {
    const make = () => {
        const update = jest.fn().mockResolvedValue({ affected: 1 });
        const repository = { update };
        const emitSessionStatus = jest.fn();
        const dispatch = jest.fn().mockResolvedValue(undefined);
        const broadcaster = new session_status_broadcaster_1.SessionStatusBroadcaster({
            sessionRepository: repository,
            eventsGateway: { emitSessionStatus },
            webhookService: { dispatch },
            logger: console,
        });
        return { broadcaster, update, emitSessionStatus, dispatch };
    };
    it('persists the status BEFORE mirroring it (the row is the source of truth)', async () => {
        const { broadcaster, update, emitSessionStatus } = make();
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        expect(update).toHaveBeenCalledWith('s1', { status: session_entity_1.SessionStatus.READY });
        expect(emitSessionStatus).toHaveBeenCalledWith('s1', session_entity_1.SessionStatus.READY);
    });
    /**
     * The order is the point, and the assertions above cannot see it: both would still pass with the
     * mirror running first, or with the write started but never awaited. A client that reacts to the
     * `session.status` socket event by re-reading GET /sessions would then race the row and read the
     * PREVIOUS status. So this records what actually happened, and requires the write to have
     * SETTLED, not merely to have been called.
     */
    it('finishes the write before the mirror runs, not just starts it', async () => {
        const order = [];
        const update = jest.fn().mockImplementation(async () => {
            order.push('persist:start');
            await Promise.resolve();
            order.push('persist:settled');
            return { affected: 1 };
        });
        const emitSessionStatus = jest.fn().mockImplementation(() => order.push('ws'));
        const dispatch = jest.fn().mockImplementation(() => {
            order.push('webhook');
            return Promise.resolve();
        });
        const broadcaster = new session_status_broadcaster_1.SessionStatusBroadcaster({
            sessionRepository: { update },
            eventsGateway: { emitSessionStatus },
            webhookService: { dispatch },
            logger: console,
        });
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        expect(order).toEqual(['persist:start', 'persist:settled', 'ws', 'webhook']);
    });
    it('mirrors to WS and dispatches the session.status webhook on a transition', async () => {
        const { broadcaster, emitSessionStatus, dispatch } = make();
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.QR_READY);
        expect(emitSessionStatus).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledWith('s1', 'session.status', {
            sessionId: 's1',
            status: session_entity_1.SessionStatus.QR_READY,
        });
    });
    it('de-dups the SAME status signalled twice (onStateChanged + a dedicated callback)', async () => {
        const { broadcaster, emitSessionStatus, dispatch } = make();
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        expect(emitSessionStatus).toHaveBeenCalledTimes(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
    it('re-emits when the status actually CHANGES back and forth', async () => {
        const { broadcaster, emitSessionStatus } = make();
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.DISCONNECTED);
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        expect(emitSessionStatus).toHaveBeenCalledTimes(3);
    });
    it('persists EVERY call even when the mirror is de-duped (the row is not the mirror)', async () => {
        const { broadcaster, update } = make();
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        expect(update).toHaveBeenCalledTimes(2);
    });
    it('clear() drops the de-dup entry so the same status re-emits after a delete-cycle', async () => {
        const { broadcaster, emitSessionStatus } = make();
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        broadcaster.clear('s1');
        await broadcaster.updateStatus('s1', session_entity_1.SessionStatus.READY);
        expect(emitSessionStatus).toHaveBeenCalledTimes(2);
    });
    it.each([false, true])('checks announcement permission after the write settles: %s', async (allowed) => {
        const { broadcaster, update, emitSessionStatus, dispatch } = make();
        let resolve;
        update.mockImplementationOnce(() => new Promise(yes => (resolve = yes)));
        let current = true;
        const canAnnounce = jest.fn(() => current);
        broadcaster.lastDispatchedStatus.set('s1', session_entity_1.SessionStatus.DISCONNECTED);
        const pending = broadcaster.updateStatus('s1', session_entity_1.SessionStatus.INITIALIZING, canAnnounce);
        expect(canAnnounce).not.toHaveBeenCalled();
        current = allowed;
        resolve();
        await pending;
        expect(update).toHaveBeenCalledWith('s1', { status: session_entity_1.SessionStatus.INITIALIZING });
        expect(canAnnounce).toHaveBeenCalledTimes(1);
        expect(emitSessionStatus).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(dispatch).toHaveBeenCalledTimes(allowed ? 1 : 0);
        expect(broadcaster.lastDispatchedStatus.get('s1')).toBe(allowed ? session_entity_1.SessionStatus.INITIALIZING : session_entity_1.SessionStatus.DISCONNECTED);
    });
    it('propagates a failed write without checking or announcing its status', async () => {
        const { broadcaster, update, emitSessionStatus, dispatch } = make();
        const failure = new Error('write failed');
        update.mockRejectedValueOnce(failure);
        const canAnnounce = jest.fn(() => true);
        await expect(broadcaster.updateStatus('s1', session_entity_1.SessionStatus.INITIALIZING, canAnnounce)).rejects.toBe(failure);
        expect(canAnnounce).not.toHaveBeenCalled();
        expect(emitSessionStatus).not.toHaveBeenCalled();
        expect(dispatch).not.toHaveBeenCalled();
    });
});
