"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const ingress_event_entity_1 = require("./entities/ingress-event.entity");
const ingress_event_service_1 = require("./ingress-event.service");
const ingress_service_1 = require("./ingress.service");
const _1781900000000_AddIntegrationFabric_1 = require("../../database/migrations/1781900000000-AddIntegrationFabric");
const _1782100000000_WidenIngressDedupKey_1 = require("../../database/migrations/1782100000000-WidenIngressDedupKey");
const _1785112230000_AddIngressEventDispatchState_1 = require("../../database/migrations/1785112230000-AddIngressEventDispatchState");
const _1785600000000_SlimIngressEventPayload_1 = require("../../database/migrations/1785600000000-SlimIngressEventPayload");
// A provider that carries the delivery in the query string (a GET callback, or a POST with no body) and
// sends no delivery header. Each distinct callback is a distinct delivery and must reach the plugin.
describe('ingress deliveries carried in the query string', () => {
    let ds;
    let enqueue;
    let svc;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [ingress_event_entity_1.IngressEvent], migrations: [] });
        await ds.initialize();
        const runner = ds.createQueryRunner();
        await new _1781900000000_AddIntegrationFabric_1.AddIntegrationFabric1781900000000().up(runner);
        await new _1782100000000_WidenIngressDedupKey_1.WidenIngressDedupKey1782100000000().up(runner);
        await new _1785112230000_AddIngressEventDispatchState_1.AddIngressEventDispatchState1785112230000().up(runner);
        await new _1785600000000_SlimIngressEventPayload_1.SlimIngressEventPayload1785600000000().up(runner);
        await runner.release();
        const events = new ingress_event_service_1.IngressEventService(ds.getRepository(ingress_event_entity_1.IngressEvent));
        enqueue = jest.fn().mockResolvedValue({ outcome: 'queued' });
        svc = new ingress_service_1.IngressService({
            instances: {
                resolve: () => Promise.resolve({
                    id: 'sms:acct1',
                    pluginId: 'sms',
                    instanceId: 'acct1',
                    secret: 'a-shared-secret-of-enough-length',
                    enabled: true,
                    sessionScope: 'sess-1',
                    verifyToken: null,
                }),
            },
            manifestRoute: () => ({
                route: 'inbound',
                mode: 'async',
                verify: 'core',
                maxBodyBytes: 4096,
                signature: { scheme: 'shared-secret', header: 'x-api-key' },
            }),
            events: { recordOrSkip: input => events.recordOrSkip(input) },
            enqueue,
            now: () => 1_700_000_000_000,
        });
    });
    afterEach(async () => {
        if (ds.isInitialized)
            await ds.destroy();
    });
    const delivery = (method, query, rawBody = '') => ({
        pluginId: 'sms',
        instanceId: 'acct1',
        route: 'inbound',
        method,
        headers: { 'x-api-key': 'a-shared-secret-of-enough-length' },
        query,
        rawBody,
    });
    const storedIds = async () => (await ds.getRepository(ingress_event_entity_1.IngressEvent).find()).map(e => e.providerDeliveryId);
    it('dispatches two different GET callbacks', async () => {
        const first = await svc.handle(delivery('GET', { msisdn: '6281111', text: 'hello', messageId: 'm-1' }));
        const second = await svc.handle(delivery('GET', { msisdn: '6282222', text: 'order 42', messageId: 'm-2' }));
        expect(first.status).toBe(202);
        expect(second.status).toBe(202);
        expect(enqueue).toHaveBeenCalledTimes(2);
        expect(await ds.getRepository(ingress_event_entity_1.IngressEvent).count()).toBe(2);
    });
    it('dispatches two different bodiless POST callbacks', async () => {
        await svc.handle(delivery('POST', { event: 'delivered', ref: 'a' }));
        await svc.handle(delivery('POST', { event: 'failed', ref: 'b' }));
        expect(enqueue).toHaveBeenCalledTimes(2);
    });
    it('still collapses a repeat of the same callback', async () => {
        await svc.handle(delivery('GET', { msisdn: '6281111', text: 'hello', messageId: 'm-1' }));
        await svc.handle(delivery('GET', { msisdn: '6281111', text: 'hello', messageId: 'm-1' }));
        expect(enqueue).toHaveBeenCalledTimes(1);
    });
    it('collapses a repeat whose query parameters arrive in another order', async () => {
        await svc.handle(delivery('GET', { msisdn: '6281111', text: 'hello' }));
        await svc.handle(delivery('GET', { text: 'hello', msisdn: '6281111' }));
        expect(enqueue).toHaveBeenCalledTimes(1);
    });
    // The ids below are the ones these shapes were given before the query took part, so a provider retry of
    // a delivery made before an upgrade still collapses with it.
    it('keeps the body-only id for a delivery that has a body, whatever its query', async () => {
        await svc.handle(delivery('POST', { ref: 'a' }, '{"text":"hi"}'));
        await svc.handle(delivery('POST', { ref: 'b' }, '{"text":"hi"}'));
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(await storedIds()).toEqual(['26b4ba94605d073176aa485b5b064b98371cb9b7caa0c2fe61b47e0c20c44490']);
    });
    it('keeps one id for deliveries with neither a body nor a query', async () => {
        await svc.handle(delivery('POST', {}));
        await svc.handle(delivery('GET', {}));
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(await storedIds()).toEqual(['0575671139026e4e0fe3c90d07bc53f130be380d3d6200ada3e4788e57fa5060']);
    });
});
