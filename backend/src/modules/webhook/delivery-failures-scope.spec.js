"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// GET /webhooks/delivery-failures takes sessionId as a QUERY param, which the ApiKeyGuard fence
// (route-params only) does not scope. A session-restricted ADMIN key must not read another session's
// failed-delivery rows — which carry the webhook URL, event, idempotencyKey and lastError. Exercised
// end-to-end against a real in-memory DB, mirroring webhook-session-scope.spec.ts.
const typeorm_1 = require("typeorm");
const webhook_service_1 = require("./webhook.service");
const webhook_delivery_failure_entity_1 = require("./entities/webhook-delivery-failure.entity");
const webhook_entity_1 = require("./entities/webhook.entity");
const session_entity_1 = require("../session/entities/session.entity");
describe('WebhookService.listDeliveryFailures session scoping', () => {
    let ds;
    let service;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [webhook_delivery_failure_entity_1.WebhookDeliveryFailure],
            synchronize: true,
        });
        await ds.initialize();
        const failureRepo = ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
        const cfg = { get: () => false };
        // 2nd arg is the delivery-failure repo; the webhook/session repos and the delivery service
        // (5th arg) are never touched by the scoping paths under test.
        service = new webhook_service_1.WebhookService({}, failureRepo, {}, cfg, {});
        for (const sessionId of ['sessA', 'sessB']) {
            await failureRepo.save(failureRepo.create({
                webhookId: `wh-${sessionId}`,
                sessionId,
                event: 'message.received',
                url: `https://${sessionId}.example/hook`,
                attempts: 3,
                lastError: 'ECONNREFUSED',
            }));
        }
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('a key scoped to sessA sees only sessA failures, never sessB', async () => {
        const rows = await service.listDeliveryFailures({}, ['sessA']);
        expect(rows.map(r => r.sessionId)).toEqual(['sessA']);
    });
    it('a scoped key requesting sessB (outside its scope) gets nothing', async () => {
        const rows = await service.listDeliveryFailures({ sessionId: 'sessB' }, ['sessA']);
        expect(rows).toEqual([]);
    });
    it('an unrestricted key (null allowlist) sees all sessions', async () => {
        const rows = await service.listDeliveryFailures({}, null);
        expect(rows.map(r => r.sessionId).sort()).toEqual(['sessA', 'sessB']);
    });
    it('an unrestricted key can narrow to a single session via the query param', async () => {
        const rows = await service.listDeliveryFailures({ sessionId: 'sessB' }, null);
        expect(rows.map(r => r.sessionId)).toEqual(['sessB']);
    });
});
// With payload retention on, a failure row keeps the whole event it was built from, which can be a message
// body. The route serializes the rows it gets as they are, so the column staying out of the read is what
// keeps that text from every key that may list failures.
describe('WebhookService.listDeliveryFailures retained event body', () => {
    let ds;
    let service;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, webhook_entity_1.Webhook, webhook_delivery_failure_entity_1.WebhookDeliveryFailure],
            synchronize: true,
        });
        await ds.initialize();
        const failureRepo = ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
        const webhookRepo = ds.getRepository(webhook_entity_1.Webhook);
        const cfg = {
            get: (key, fallback) => (key === 'webhook.failurePayloadRetentionHours' ? 24 : fallback),
        };
        service = new webhook_service_1.WebhookService(webhookRepo, failureRepo, {}, cfg, {});
        await ds.getRepository(session_entity_1.Session).save({ id: 'sessA', name: 'sessA', status: session_entity_1.SessionStatus.READY, config: {} });
        // The row is replayable only while its webhook exists.
        const webhook = await webhookRepo.save({ sessionId: 'sessA', url: 'https://sessA.example/hook' });
        await failureRepo.save(failureRepo.create({
            webhookId: webhook.id,
            sessionId: 'sessA',
            event: 'message.received',
            url: 'https://sessA.example/hook',
            idempotencyKey: 'key-1',
            attempts: 3,
            lastError: 'ECONNREFUSED',
            payload: { body: 'private message text' },
        }));
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('flags a row as replayable without returning the event body it retains', async () => {
        const rows = await service.listDeliveryFailures({}, null);
        expect(rows.map(r => r.replayable)).toEqual([true]);
        expect(JSON.stringify(rows)).not.toContain('private message text');
    });
});
