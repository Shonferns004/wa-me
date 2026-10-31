"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_crypto_1 = require("node:crypto");
const typeorm_1 = require("typeorm");
const session_entity_1 = require("../session/entities/session.entity");
const webhook_entity_1 = require("./entities/webhook.entity");
const webhook_delivery_failure_entity_1 = require("./entities/webhook-delivery-failure.entity");
const webhook_redrive_service_1 = require("./webhook-redrive.service");
const webhook_service_1 = require("./webhook.service");
// The redrive replays a row only to the webhook it was recorded for, while that webhook still belongs to the row's
// session. A webhook that was disabled or unsubscribed can be switched back and its rows redriven; a deleted one cannot
// come back (ids are generated), so its rows must not be listed as replayable.
describe('delivery-failure replayable flag', () => {
    let ds;
    let failures;
    let webhooks;
    let listing;
    let redrive;
    let redeliver;
    let hook;
    let row;
    const config = {
        get: (key, fallback) => key === 'webhook.failurePayloadRetentionHours' ? 24 : key === 'webhook.shutdownDrainMs' ? 5000 : fallback,
    };
    const addFailure = (overrides = {}) => failures.save(failures.create({
        webhookId: hook.id,
        sessionId: 'sess-1',
        event: 'message.received',
        url: hook.url,
        idempotencyKey: (0, node_crypto_1.randomUUID)(),
        deliveryId: (0, node_crypto_1.randomUUID)(),
        attempts: 3,
        lastStatusCode: 503,
        lastError: 'HTTP 503: receiver unavailable',
        payload: { id: 'msg-1', body: 'hi' },
        ...overrides,
    }));
    beforeEach(async () => {
        ds = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, webhook_entity_1.Webhook, webhook_delivery_failure_entity_1.WebhookDeliveryFailure],
            synchronize: true,
        }).initialize();
        failures = ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
        webhooks = ds.getRepository(webhook_entity_1.Webhook);
        await ds.getRepository(session_entity_1.Session).save({ id: 'sess-1', name: 'sess-1', status: session_entity_1.SessionStatus.READY, config: {} });
        hook = await webhooks.save(webhooks.create({
            sessionId: 'sess-1',
            url: 'https://receiver.example/h',
            events: ['message.received'],
            active: true,
            retryCount: 3,
        }));
        row = await addFailure();
        listing = new webhook_service_1.WebhookService(webhooks, failures, {}, config, {});
        // A delivered replay clears the rows of its key, as the real delivery path does.
        redeliver = jest.fn(async (webhook, _session, _event, key) => {
            await failures.delete({ webhookId: webhook.id, idempotencyKey: key });
            return 'delivered';
        });
        redrive = new webhook_redrive_service_1.WebhookRedriveService(webhooks, failures, { redeliver }, config);
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await ds.destroy();
    });
    const listed = async (id) => (await listing.listDeliveryFailures({}, null)).find(r => r.id === id)?.replayable;
    it('flags a row of an active, subscribed webhook replayable, and the redrive replays it', async () => {
        expect(await listed(row.id)).toBe(true);
        expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 1, remaining: 0 });
    });
    it.each([
        ['disabled', () => webhooks.update(hook.id, { active: false })],
        ['unsubscribed from the event', () => webhooks.update(hook.id, { events: ['message.ack'] })],
    ])('keeps a row replayable while its webhook is only %s, so switching it back lets the redrive take it', async (_, change) => {
        await change();
        expect(await listed(row.id)).toBe(true);
        expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 0, skipped: 0, remaining: 0 });
        await webhooks.update(hook.id, { active: true, events: ['message.received'] });
        expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 1 });
    });
    it('does not flag a row replayable once its webhook is deleted', async () => {
        await webhooks.delete(hook.id);
        expect(await listed(row.id)).toBe(false);
        expect(await redrive.redrive({ ids: [row.id] })).toMatchObject({ redriven: 0, remaining: 0 });
        expect(redeliver).not.toHaveBeenCalled();
    });
    it('does not flag a row replayable when its webhook belongs to another session', async () => {
        const foreign = await addFailure({ sessionId: 'sess-2' });
        expect(await listed(foreign.id)).toBe(false);
        expect(await listed(row.id)).toBe(true);
    });
    it('reads the webhooks of a page once, and not at all when no row holds a payload', async () => {
        await addFailure();
        const find = jest.spyOn(webhooks, 'find');
        await listing.listDeliveryFailures({}, null);
        expect(find).toHaveBeenCalledTimes(1);
        find.mockClear();
        await failures.update({ webhookId: hook.id }, { payload: null });
        expect((await listing.listDeliveryFailures({}, null)).every(r => !r.replayable)).toBe(true);
        expect(find).not.toHaveBeenCalled();
    });
});
