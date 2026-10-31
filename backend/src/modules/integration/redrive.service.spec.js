"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redrive_service_1 = require("./redrive.service");
const integration_constants_1 = require("./integration.constants");
const logger_service_1 = require("../../common/services/logger.service");
describe('RedriveService', () => {
    let repo;
    let events;
    let ingressEnqueue;
    beforeEach(() => {
        repo = {
            find: jest.fn(),
            findOneBy: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
            increment: jest.fn().mockResolvedValue(undefined),
            count: jest.fn().mockResolvedValue(0),
        };
        events = { update: jest.fn().mockResolvedValue(undefined) };
        ingressEnqueue = { enqueue: jest.fn().mockResolvedValue({ outcome: 'queued' }) };
    });
    function makeSvc() {
        return new redrive_service_1.RedriveService(repo, events, ingressEnqueue);
    }
    it('redrives the rows it can read when one stored payload does not parse', async () => {
        const ingress = { headers: {}, query: {}, body: '{}', rawBody: '{}' };
        const healthy = { id: 'f2', pluginId: 'p', instanceId: 'i', deliveryId: 'd2', payload: { route: 'r', ingress } };
        // The window read fails as a whole; read again by id, the first row cannot be read and the second can.
        repo.find
            .mockRejectedValueOnce(new SyntaxError('Unexpected token o in JSON at position 1'))
            .mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]);
        repo.findOneBy.mockRejectedValueOnce(new SyntaxError('bad json')).mockResolvedValueOnce(healthy);
        const logged = jest.spyOn(logger_service_1.LoggerService.prototype, 'error').mockImplementation(() => undefined);
        try {
            const res = await makeSvc().redriveInstance('p', 'i', null);
            expect(res.redriven).toBe(1);
            expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
            expect(repo.update).toHaveBeenCalledWith({ id: 'f2' }, { redriven: true });
            // The unreadable row goes behind the readable ones, so a batch of them cannot starve the rest.
            expect(repo.increment).toHaveBeenCalledWith({ id: 'f1' }, 'attempts', 1);
            // Its id and the action are fields of the log line, as an alert on the action reads them: not
            // folded into the trace argument.
            expect(logged).toHaveBeenCalledWith(expect.stringContaining('could not be read'), expect.any(String), expect.objectContaining({ id: 'f1', action: 'ingress_redrive_row_unreadable' }));
        }
        finally {
            logged.mockRestore();
        }
    });
    it('re-enqueues non-redriven inbound failures for an instance and marks them redriven', async () => {
        const rows = [
            {
                id: 'f1',
                direction: 'inbound',
                pluginId: 'p',
                instanceId: 'i',
                deliveryId: 'd1',
                payload: {
                    route: 'chatwoot',
                    providerConversationId: 'conv-1',
                    ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
                },
                sessionId: 's',
                redriven: false,
            },
            {
                id: 'f2',
                direction: 'inbound',
                pluginId: 'p',
                instanceId: 'i',
                deliveryId: 'd2',
                payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
                sessionId: 's',
                redriven: false,
            },
        ];
        repo.find.mockResolvedValue(rows);
        const svc = makeSvc();
        const res = await svc.redriveInstance('p', 'i', null);
        expect(res.redriven).toBe(2);
        expect(res).toEqual({ redriven: 2, remaining: 0, batchSize: 100 });
        expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(2);
        expect(ingressEnqueue.enqueue).toHaveBeenNthCalledWith(1, {
            pluginId: 'p',
            instanceId: 'i',
            route: 'chatwoot',
            method: 'POST',
            deliveryId: 'd1',
            sessionId: 's',
            providerConversationId: 'conv-1',
            payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        }, 'redrive:f1', expect.any(AbortSignal));
        expect(repo.update).toHaveBeenCalledWith({ id: 'f1' }, { redriven: true });
        expect(repo.update).toHaveBeenCalledWith({ id: 'f2' }, { redriven: true });
    });
    it('retires the matching pending ingress_events row on a successful redrive (the reconciler must not replay it)', async () => {
        // A live-path inline failure leaves the event row 'pending' next to the DLQ row; marking only
        // the DLQ row redriven would let the reconciler sweep the event row and deliver it a second time.
        const rows = [
            {
                id: 'f1',
                direction: 'inbound',
                pluginId: 'p',
                instanceId: 'i',
                deliveryId: 'd1',
                payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
                sessionId: 's',
                redriven: false,
            },
        ];
        repo.find.mockResolvedValue(rows);
        const svc = makeSvc();
        const res = await svc.redriveInstance('p', 'i', null);
        expect(res.redriven).toBe(1);
        expect(events.update).toHaveBeenCalledTimes(1);
        const [criteria, patch] = events.update.mock.calls[0];
        expect(criteria).toEqual({ pluginId: 'p', instanceId: 'i', providerDeliveryId: 'd1', dispatchState: 'pending' });
        expect(patch).toMatchObject({ dispatchState: 'dispatched', payload: null });
        expect(patch.lastDispatchAt).toBeInstanceOf(Date);
    });
    it('leaves the row redrivable (does not mark redriven) when the inline re-dispatch is swallowed as failed', async () => {
        // A queue-disabled fallback that silently fails must NOT retire the DLQ row, or the event is lost
        // permanently with no way to redrive it again.
        const rows = [
            {
                id: 'f9',
                direction: 'inbound',
                pluginId: 'p',
                instanceId: 'i',
                deliveryId: 'd9',
                payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
                sessionId: 's',
                redriven: false,
            },
        ];
        repo.find.mockResolvedValue(rows);
        ingressEnqueue.enqueue.mockResolvedValue({ outcome: 'failed' });
        const svc = makeSvc();
        const res = await svc.redriveInstance('p', 'i', null);
        expect(res.redriven).toBe(0);
        expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
        expect(repo.update).toHaveBeenCalledWith({ id: 'f9' }, { attempts: 1, lastError: 'redrive dispatch failed' });
        expect(events.update).not.toHaveBeenCalled(); // nothing was delivered, so the event row stays as-is
    });
    it('queries only non-redriven inbound rows of the current binding and returns 0 when none are found', async () => {
        repo.find.mockResolvedValue([]);
        const svc = makeSvc();
        const res = await svc.redriveInstance('p', 'i', 'sess-current');
        // The binding enters BOTH the find() and the count() query: rows of an earlier binding neither consume
        // the batch nor leak through `remaining`, since dispatch refuses them and a replay would only fail again.
        expect(repo.find).toHaveBeenCalledWith({
            where: { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false, sessionId: 'sess-current' },
            order: { attempts: 'ASC', createdAt: 'ASC' },
            take: 100,
        });
        expect(repo.count).toHaveBeenCalledWith({
            where: { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false, sessionId: 'sess-current' },
        });
        expect(res.redriven).toBe(0);
        expect(ingressEnqueue.enqueue).not.toHaveBeenCalled();
        expect(repo.update).not.toHaveBeenCalled();
    });
    it.each([null, '*'])('takes a row with no session or "*" for an instance bound to all sessions (%s)', async (scope) => {
        repo.find.mockResolvedValue([]);
        const svc = makeSvc();
        await svc.redriveInstance('p', 'i', scope);
        const base = { pluginId: 'p', instanceId: 'i', direction: 'inbound', redriven: false };
        const where = [
            { ...base, sessionId: expect.objectContaining({ _type: 'isNull' }) },
            { ...base, sessionId: '*' },
        ];
        expect(repo.find).toHaveBeenCalledWith({ where, order: { attempts: 'ASC', createdAt: 'ASC' }, take: 100 });
        expect(repo.count).toHaveBeenCalledWith({ where });
    });
    it('falls back to the failure row id as deliveryId when deliveryId is null', async () => {
        const rows = [
            {
                id: 'f3',
                direction: 'inbound',
                pluginId: 'p',
                instanceId: 'i',
                deliveryId: null,
                payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
                sessionId: null,
                redriven: false,
            },
        ];
        repo.find.mockResolvedValue(rows);
        const svc = makeSvc();
        await svc.redriveInstance('p', 'i', null);
        expect(ingressEnqueue.enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'f3', sessionId: undefined }), 'redrive:f3', expect.any(AbortSignal));
        // A legacy row without a deliveryId predates persist-before-ack — there is no event row to retire.
        expect(events.update).not.toHaveBeenCalled();
    });
    describe('shutdown', () => {
        const failure = (id, deliveryId) => ({
            id,
            direction: 'inbound',
            pluginId: 'p',
            instanceId: 'i',
            deliveryId,
            payload: { route: 'chatwoot', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
            sessionId: 's',
            redriven: false,
            attempts: 0,
        });
        const tick = () => new Promise(resolve => setImmediate(resolve));
        it('stops at the next row and leaves the rows it did not reach open and unchanged', async () => {
            repo.find.mockResolvedValue([failure('f1', 'd1'), failure('f2', 'd2'), failure('f3', 'd3')]);
            repo.count.mockResolvedValue(2);
            let finishFirst;
            ingressEnqueue.enqueue.mockImplementationOnce(() => new Promise(resolve => (finishFirst = () => resolve({ outcome: 'queued' }))));
            const svc = makeSvc();
            const running = svc.redriveInstance('p', 'i', null);
            while (!finishFirst)
                await tick();
            const destroyed = svc.onModuleDestroy();
            finishFirst();
            expect(await running).toEqual({ redriven: 1, remaining: 2, batchSize: 100 });
            await destroyed;
            expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
            expect(repo.update).toHaveBeenCalledTimes(1);
            expect(repo.update).toHaveBeenCalledWith({ id: 'f1' }, { redriven: true });
        });
        it('leaves a row open and unchanged when its enqueue is refused because shutdown began', async () => {
            repo.find.mockResolvedValue([failure('f1', 'd1'), failure('f2', 'd2')]);
            repo.count.mockResolvedValue(2);
            const svc = makeSvc();
            let destroyed;
            ingressEnqueue.enqueue.mockImplementationOnce(() => {
                destroyed = svc.onModuleDestroy();
                return Promise.reject(new Error('The operation was aborted'));
            });
            expect(await svc.redriveInstance('p', 'i', null)).toEqual({ redriven: 0, remaining: 2, batchSize: 100 });
            await destroyed;
            expect(ingressEnqueue.enqueue).toHaveBeenCalledTimes(1);
            expect(repo.update).not.toHaveBeenCalled();
            expect(events.update).not.toHaveBeenCalled();
        });
        it('still surfaces an enqueue failure that is not a shutdown', async () => {
            repo.find.mockResolvedValue([failure('f1', 'd1')]);
            ingressEnqueue.enqueue.mockRejectedValueOnce(new Error('database is gone'));
            await expect(makeSvc().redriveInstance('p', 'i', null)).rejects.toThrow('database is gone');
        });
        it('settles its teardown when the redrive it waits for fails', async () => {
            repo.find.mockResolvedValue([failure('f1', 'd1')]);
            // A bookkeeping write after the enqueue is not covered by the shutdown refusal above, so the run rejects.
            events.update.mockRejectedValueOnce(new Error('database is gone'));
            let finishFirst;
            ingressEnqueue.enqueue.mockImplementationOnce(() => new Promise(resolve => (finishFirst = () => resolve({ outcome: 'queued' }))));
            const svc = makeSvc();
            const running = svc.redriveInstance('p', 'i', null);
            const failed = expect(running).rejects.toThrow('database is gone');
            while (!finishFirst)
                await tick();
            const destroyed = svc.onModuleDestroy();
            finishFirst();
            // A rejecting destroy hook makes Nest skip every later one (plugin onDisable, the DataSource close).
            await expect(destroyed).resolves.toBeUndefined();
            await failed;
        });
        it('waits at most the dispatch timeout for a replay still in hand', async () => {
            jest.useFakeTimers();
            try {
                repo.find.mockResolvedValue([failure('f1', 'd1')]);
                ingressEnqueue.enqueue.mockReturnValueOnce(new Promise(() => undefined));
                const svc = makeSvc();
                void svc.redriveInstance('p', 'i', null);
                await jest.advanceTimersByTimeAsync(0);
                let settled = false;
                const destroyed = svc.onModuleDestroy().then(() => (settled = true));
                await jest.advanceTimersByTimeAsync(integration_constants_1.INGRESS_DISPATCH_TIMEOUT_MS - 1);
                expect(settled).toBe(false);
                await jest.advanceTimersByTimeAsync(1);
                await destroyed;
                expect(settled).toBe(true);
            }
            finally {
                jest.useRealTimers();
            }
        });
        it('has nothing to wait for when no redrive is running', async () => {
            await expect(makeSvc().onModuleDestroy()).resolves.toBeUndefined();
        });
    });
});
