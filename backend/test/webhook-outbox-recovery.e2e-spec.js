"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const app_module_1 = require("./../src/app.module");
const app_validation_1 = require("./../src/config/app-validation");
const webhook_entity_1 = require("./../src/modules/webhook/entities/webhook.entity");
const webhook_outbox_event_entity_1 = require("./../src/modules/webhook/entities/webhook-outbox-event.entity");
const session_entity_1 = require("./../src/modules/session/entities/session.entity");
const webhook_delivery_service_1 = require("./../src/modules/webhook/webhook-delivery.service");
const webhook_reconciler_service_1 = require("./../src/modules/webhook/webhook-reconciler.service");
/**
 * The crash window, end to end.
 *
 * A hard crash cannot be staged inside a jest worker, but its OBSERVABLE state can: a delivery that
 * never completed leaves a 'pending' row still carrying its payload, which is exactly what the
 * process would leave behind. The first case proves the process really does reach that state; the
 * second proves a later instance drains it, and that the replay carries the SAME idempotency key so
 * a receiver deduping on that header sees one logical event rather than two.
 */
describe('Webhook outbox recovery (e2e)', () => {
    let app;
    let receiver;
    let receiverUrl;
    let captured;
    let hold;
    let release;
    let webhooks;
    let outbox;
    let sessions;
    let prevSsrf;
    beforeAll(async () => {
        prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;
        process.env.WEBHOOK_SSRF_PROTECT = 'false';
        const moduleFixture = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        webhooks = app.get((0, typeorm_1.getRepositoryToken)(webhook_entity_1.Webhook, 'data'));
        outbox = app.get((0, typeorm_1.getRepositoryToken)(webhook_outbox_event_entity_1.WebhookOutboxEvent, 'data'));
        sessions = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        captured = [];
        hold = false;
        const waiters = [];
        release = () => {
            while (waiters.length)
                waiters.pop()?.();
        };
        receiver = http_1.default.createServer((req, res) => {
            req.on('data', () => { });
            req.on('end', () => {
                captured.push({
                    idempotencyKey: req.headers['x-openwa-idempotency-key'],
                    deliveryId: req.headers['x-openwa-delivery-id'],
                });
                const answer = () => {
                    res.writeHead(200).end();
                };
                if (hold)
                    waiters.push(answer);
                else
                    answer();
            });
        });
        await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
        receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
    });
    afterAll(async () => {
        hold = false;
        release();
        await new Promise(resolve => receiver.close(() => resolve()));
        await app?.close();
        if (prevSsrf === undefined)
            delete process.env.WEBHOOK_SSRF_PROTECT;
        else
            process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
    });
    const newWebhook = async () => {
        const session = await sessions.save(sessions.create({ name: `outbox-${Date.now()}-${Math.random()}` }));
        const webhook = await webhooks.save(webhooks.create({ sessionId: session.id, url: receiverUrl, events: ['message.received'], active: true }));
        return { sessionId: session.id, webhookId: webhook.id };
    };
    it('leaves a record with its payload while the delivery is still in flight', async () => {
        const { sessionId, webhookId } = await newWebhook();
        hold = true;
        const delivery = app.get(webhook_delivery_service_1.WebhookDeliveryService);
        const inFlight = delivery.dispatch(sessionId, 'message.received', { from: '628123456789@c.us' });
        // The receiver has the request and is holding the response: this is the state a SIGKILL freezes.
        await waitFor(() => captured.length === 1);
        const row = await outbox.findOne({ where: { webhookId } });
        expect(row?.state).toBe('pending');
        expect(row?.payload).toMatchObject({ from: '628123456789@c.us' });
        hold = false;
        release();
        await inFlight;
        // Once it lands, the record is retired and stops being replayable.
        const settled = await outbox.findOne({ where: { webhookId } });
        expect(settled?.state).toBe('dispatched');
        expect(settled?.payload).toBeNull();
    });
    it('redelivers a stranded record with the SAME idempotency key, then retires it', async () => {
        const { sessionId, webhookId } = await newWebhook();
        // Exactly what a crashed instance leaves behind: recorded, never closed.
        await outbox.save(outbox.create({
            webhookId,
            sessionId,
            event: 'message.received',
            idempotencyKey: 'stranded-key_' + webhookId,
            deliveryId: 'delivery-from-the-dead-process',
            payload: { from: '628177000000@c.us' },
            state: 'pending',
            attempts: 0,
        }));
        const before = captured.length;
        const stats = await app
            .get(webhook_reconciler_service_1.WebhookReconcilerService)
            .sweep({ intervalMs: 60_000, graceMs: 0, batchSize: 10, maxAttempts: 5 });
        expect(stats.replayed).toBeGreaterThanOrEqual(1);
        await waitFor(() => captured.length > before);
        const replay = captured[captured.length - 1];
        // The receiver dedups on this header. A freshly derived key would read as a second event.
        expect(replay.idempotencyKey).toBe('stranded-key_' + webhookId);
        // The attempt gets its own id: that names the attempt, not the event.
        expect(replay.deliveryId).not.toBe('delivery-from-the-dead-process');
        const row = await outbox.findOne({ where: { webhookId } });
        expect(row?.state).toBe('dispatched');
        expect(row?.payload).toBeNull();
    });
});
async function waitFor(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs)
            throw new Error('timed out waiting for the receiver');
        await new Promise(r => setTimeout(r, 10));
    }
}
