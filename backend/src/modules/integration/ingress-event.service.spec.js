"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const ingress_event_entity_1 = require("./entities/ingress-event.entity");
const ingress_event_service_1 = require("./ingress-event.service");
const _1781900000000_AddIntegrationFabric_1 = require("../../database/migrations/1781900000000-AddIntegrationFabric");
const _1782100000000_WidenIngressDedupKey_1 = require("../../database/migrations/1782100000000-WidenIngressDedupKey");
const _1785112230000_AddIngressEventDispatchState_1 = require("../../database/migrations/1785112230000-AddIngressEventDispatchState");
const _1785600000000_SlimIngressEventPayload_1 = require("../../database/migrations/1785600000000-SlimIngressEventPayload");
describe('IngressEventService.recordOrSkip', () => {
    let ds;
    let service;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ingress_event_entity_1.IngressEvent], migrations: [] });
        await ds.initialize();
        const runner = ds.createQueryRunner();
        await new _1781900000000_AddIntegrationFabric_1.AddIntegrationFabric1781900000000().up(runner);
        await new _1782100000000_WidenIngressDedupKey_1.WidenIngressDedupKey1782100000000().up(runner);
        await new _1785112230000_AddIngressEventDispatchState_1.AddIngressEventDispatchState1785112230000().up(runner);
        await new _1785600000000_SlimIngressEventPayload_1.SlimIngressEventPayload1785600000000().up(runner);
        await runner.release();
        service = new ingress_event_service_1.IngressEventService(ds.getRepository(ingress_event_entity_1.IngressEvent));
    });
    afterEach(async () => {
        if (ds.isInitialized)
            await ds.destroy();
    });
    const row = () => ({
        instanceId: 'inst',
        pluginId: 'plug',
        providerDeliveryId: 'd1',
        route: 'chatwoot',
        payload: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
        payloadHash: 'hash-of-{}',
        sessionId: null,
    });
    const key = { pluginId: 'plug', instanceId: 'inst', providerDeliveryId: 'd1' };
    const stored = () => ds.getRepository(ingress_event_entity_1.IngressEvent).findOneByOrFail(key);
    it('returns true for a first delivery and false for a replay of the same delivery id', async () => {
        expect(await service.recordOrSkip(row())).toBe(true);
        expect(await service.recordOrSkip(row())).toBe(false);
    });
    it('treats the same delivery id under a different instance as new', async () => {
        expect(await service.recordOrSkip(row())).toBe(true);
        expect(await service.recordOrSkip({ ...row(), instanceId: 'inst2' })).toBe(true);
    });
    it('treats the same instance+delivery id under a different plugin as new (dedup key includes pluginId)', async () => {
        // instanceId is only unique within a plugin; two plugins sharing the string must not collide.
        expect(await service.recordOrSkip(row())).toBe(true);
        expect(await service.recordOrSkip({ ...row(), pluginId: 'other-plug' })).toBe(true);
    });
    it('writes new events as dispatchState pending with zero attempts (watched by the reconciler)', async () => {
        await service.recordOrSkip(row());
        const event = await stored();
        expect(event.dispatchState).toBe('pending');
        expect(event.dispatchAttempts).toBe(0);
        expect(event.lastDispatchAt).toBeNull();
    });
    it('keeps the full payload (the reconciler replay source) plus its hash while pending', async () => {
        await service.recordOrSkip(row());
        const event = await stored();
        expect(event.payload).toEqual({ headers: {}, query: {}, body: '{}', rawBody: '{}' });
        expect(event.payloadHash).toBe('hash-of-{}');
    });
    it.each(['queued', 'dispatched'])('marks outcome %s as dispatched with a dispatch timestamp', async (outcome) => {
        await service.recordOrSkip(row());
        await service.markDispatchOutcome(key, outcome);
        const event = await stored();
        expect(event.dispatchState).toBe('dispatched');
        expect(event.lastDispatchAt).toBeInstanceOf(Date);
        expect(event.dispatchAttempts).toBe(0);
    });
    it.each(['queued', 'dispatched'])('retires the full payload on outcome %s but keeps the hash and the dedup oracle', async (outcome) => {
        await service.recordOrSkip(row());
        await service.markDispatchOutcome(key, outcome);
        const event = await stored();
        // The dispatch tier owns the payload now — the dedup row slims to its marker + fingerprint.
        expect(event.payload).toBeNull();
        expect(event.payloadHash).toBe('hash-of-{}');
        // Dedup is keyed on (pluginId, instanceId, providerDeliveryId), never on the payload.
        expect(await service.recordOrSkip(row())).toBe(false);
    });
    it('marks outcome failed as still-pending with the attempt counted AND the payload kept (reconciler replays from it)', async () => {
        await service.recordOrSkip(row());
        await service.markDispatchOutcome(key, 'failed');
        const event = await stored();
        expect(event.dispatchState).toBe('pending');
        expect(event.dispatchAttempts).toBe(1);
        expect(event.lastDispatchAt).toBeInstanceOf(Date);
        expect(event.payload).not.toBeNull();
        // Repeated failures accumulate against the reconciler's replay budget.
        await service.markDispatchOutcome(key, 'failed');
        expect((await stored()).dispatchAttempts).toBe(2);
        expect((await stored()).dispatchState).toBe('pending');
    });
});
