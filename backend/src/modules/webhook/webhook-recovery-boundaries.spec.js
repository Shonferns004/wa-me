"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("@nestjs/config");
const node_crypto_1 = require("node:crypto");
const typeorm_1 = require("typeorm");
const undici_1 = require("undici");
const hooks_1 = require("../../core/hooks");
const ssrf = __importStar(require("../../common/security/ssrf-guard"));
const session_entity_1 = require("../session/entities/session.entity");
const webhook_entity_1 = require("./entities/webhook.entity");
const webhook_delivery_failure_entity_1 = require("./entities/webhook-delivery-failure.entity");
const webhook_outbox_event_entity_1 = require("./entities/webhook-outbox-event.entity");
const webhook_outbox_service_1 = require("./webhook-outbox.service");
const webhook_reconciler_service_1 = require("./webhook-reconciler.service");
const webhook_redrive_service_1 = require("./webhook-redrive.service");
const webhook_delivery_service_1 = require("./webhook-delivery.service");
const redis_connection_1 = require("../queue/redis-connection");
describe('webhook recovery across live ownership and configuration changes', () => {
    let ds;
    let webhooks;
    let failures;
    let primary;
    beforeEach(async () => {
        ds = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, webhook_entity_1.Webhook, webhook_delivery_failure_entity_1.WebhookDeliveryFailure, webhook_outbox_event_entity_1.WebhookOutboxEvent],
            synchronize: true,
        }).initialize();
        for (const id of ['s1', 's2'])
            await ds.getRepository(session_entity_1.Session).save({ id, name: id });
        webhooks = ds.getRepository(webhook_entity_1.Webhook);
        failures = ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
        primary = await webhooks.save({
            sessionId: 's1',
            url: 'https://old.example',
            events: ['message.received'],
            active: true,
            retryCount: 1,
        });
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await ds.destroy();
    });
    it('walks past live jobs, handles equal timestamps, and wraps after a deleted cursor row', async () => {
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        for (let i = 0; i < 5; i++) {
            await outbox.open({
                webhookId: primary.id,
                sessionId: primary.sessionId,
                event: 'message.received',
                idempotencyKey: `key${i}`,
                deliveryId: `job${i}`,
                payload: { id: i },
            });
            await repository.update({ idempotencyKey: `key${i}` }, { id: `row${i}`, createdAt: new Date('2026-10-01') });
            if (i !== 4)
                await outbox.markQueued(primary.id, `key${i}`, `job${i}`);
        }
        const delivery = {
            isLocallyPending: jest.fn((key) => key === 'key0'),
            isQueueJobPending: jest.fn((id) => Promise.resolve(id === 'job1' || id === 'job2')),
            hasQueueJobCompleted: jest.fn().mockResolvedValue(false),
            // Like the real redeliver, a delivered replay retires its own outbox row.
            redeliver: jest.fn(async (webhook, _sessionId, _event, key) => {
                await outbox.close(webhook.id, key, 'dispatched');
                return 'delivered';
            }),
            recordReplayExhaustion: jest.fn().mockResolvedValue(true),
        };
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, new config_1.ConfigService());
        const options = { intervalMs: 1000, graceMs: 0, batchSize: 2, maxAttempts: 5 };
        for (let i = 0; i < 3; i++)
            expect((await reconciler.sweep(options)).scanned).toBeLessThanOrEqual(2);
        expect(delivery.redeliver.mock.calls.map((call) => call[3])).toEqual(['key3', 'key4']);
        await repository.delete('row4');
        // A newly stranded row earlier than the cursor becomes reachable on the next cycle.
        delivery.isLocallyPending.mockReturnValue(false);
        await reconciler.sweep(options);
        expect(delivery.redeliver.mock.calls.map((call) => call[3])).toContain('key0');
        expect((await repository.findOneByOrFail({ id: 'row3' })).state).toBe('dispatched');
    });
    it.each(['disable', 'delete', 'unsubscribe', 'move-session', 'rotate'])('uses the current receiver for each redrive after a %s', async (change) => {
        for (let i = 0; i < 5; i++)
            await failures.save({
                webhookId: primary.id,
                sessionId: primary.sessionId,
                event: 'message.received',
                url: primary.url,
                idempotencyKey: `key${i}`,
                deliveryId: (0, node_crypto_1.randomUUID)(),
                attempts: 1,
                lastError: 'HTTP 503',
                payload: { id: i },
                createdAt: new Date(Date.now() - 10000 + i),
            });
        const config = new config_1.ConfigService({ webhook: { failurePayloadRetentionHours: 24, timeout: 1000 } });
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, new hooks_1.HookManager(), new webhook_outbox_service_1.WebhookOutboxService(ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent)));
        const redrive = new webhook_redrive_service_1.WebhookRedriveService(webhooks, failures, delivery, config);
        let release;
        const held = new Promise(resolve => (release = resolve));
        let called = 0;
        const post = jest.spyOn(ssrf, 'withSafeFetch').mockImplementation(async (_url, _init, use) => {
            called++;
            if (called <= 4)
                await held;
            return use(new undici_1.Response(null, { status: 200 }));
        });
        const running = redrive.redrive({});
        for (let i = 0; i < 100 && called < 4; i++)
            await new Promise(resolve => setImmediate(resolve));
        expect(called).toBe(4);
        if (change === 'delete')
            await webhooks.delete(primary.id);
        else
            await webhooks.update(primary.id, change === 'disable'
                ? { active: false }
                : change === 'unsubscribe'
                    ? { events: ['message.ack'] }
                    : change === 'move-session'
                        ? { sessionId: 's2' }
                        : { url: 'https://new.example', secret: 'new-secret', headers: { Authorization: 'new-token' } });
        release();
        expect(await running).toMatchObject(change === 'rotate' ? { delivered: 5, skipped: 0 } : { delivered: 4, skipped: 1 });
        if (change === 'rotate') {
            const [url, init] = post.mock.calls[4];
            expect(typeof init.body).toBe('string');
            expect(url).toBe('https://new.example');
            expect(init.headers).toMatchObject({
                Authorization: 'new-token',
                'X-OpenWA-Signature': `sha256=${(0, node_crypto_1.createHmac)('sha256', 'new-secret')
                    .update(init.body)
                    .digest('hex')}`,
            });
        }
        else {
            expect(post).toHaveBeenCalledTimes(4);
            expect(await failures.count()).toBe(1);
        }
    });
    it('retires the outbox copy when a redrive delivers, so the next sweep sends nothing', async () => {
        const config = new config_1.ConfigService({ webhook: { failurePayloadRetentionHours: 24, timeout: 1000, retryDelay: 1 } });
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, new hooks_1.HookManager(), outbox);
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, config);
        const redrive = new webhook_redrive_service_1.WebhookRedriveService(webhooks, failures, delivery, config);
        const options = { intervalMs: 1000, graceMs: 0, batchSize: 50, maxAttempts: 5 };
        // A dispatch interrupted before it settled leaves its row pending for the sweep.
        await outbox.open({
            webhookId: primary.id,
            sessionId: primary.sessionId,
            event: 'message.received',
            idempotencyKey: 'stranded-key',
            deliveryId: 'job0',
            payload: { id: 'MSG1' },
        });
        await repository.update({ idempotencyKey: 'stranded-key' }, { createdAt: new Date(Date.now() - 60_000) });
        let status = 503;
        const post = jest
            .spyOn(ssrf, 'withSafeFetch')
            .mockImplementation((_url, _init, use) => Promise.resolve(use(new undici_1.Response(null, { status }))));
        // The sweep's replay fails: the row stays pending and a redrivable failure row is filed.
        expect(await reconciler.sweep(options)).toMatchObject({ scanned: 1, failed: 1 });
        expect(await failures.count({ where: { idempotencyKey: 'stranded-key' } })).toBe(1);
        status = 200;
        expect(await redrive.redrive({})).toMatchObject({ delivered: 1, failed: 0 });
        expect(await failures.count()).toBe(0);
        const row = await repository.findOneByOrFail({ idempotencyKey: 'stranded-key' });
        expect(row.state).toBe('dispatched');
        expect(row.payload).toBeNull();
        expect(await reconciler.sweep(options)).toMatchObject({ scanned: 0 });
        expect(post).toHaveBeenCalledTimes(2);
    });
    it('points a replayed row at its new queue job, so the next sweep enqueues nothing', async () => {
        const config = new config_1.ConfigService({ queue: { enabled: true }, webhook: { timeout: 1000 } });
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        const live = new Set();
        const queue = {
            add: jest.fn((_name, _data, options) => {
                live.add(options.jobId);
                return Promise.resolve({});
            }),
            getJob: jest.fn((id) => Promise.resolve(live.has(id) ? { getState: () => Promise.resolve('waiting') } : undefined)),
            waitUntilReady: jest.fn().mockResolvedValue(undefined),
        };
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, new hooks_1.HookManager(), outbox, undefined, queue);
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, config);
        const options = { intervalMs: 1000, graceMs: 0, batchSize: 10, maxAttempts: 5 };
        // A crash before the add left a row that names a job which was never created.
        await outbox.open({
            webhookId: primary.id,
            sessionId: primary.sessionId,
            event: 'message.received',
            idempotencyKey: 'key-a',
            deliveryId: 'job-never-added',
            payload: { id: 1 },
        });
        await repository.update({ idempotencyKey: 'key-a' }, { createdAt: new Date(Date.now() - 600_000) });
        expect(await reconciler.sweep(options)).toMatchObject({ replayed: 1, skipped: 0 });
        const [[, , added]] = queue.add.mock.calls;
        expect(await repository.findOneByOrFail({ idempotencyKey: 'key-a' })).toMatchObject({
            state: 'queued',
            deliveryId: added.jobId,
        });
        // The replacement job is alive: with the row pointing at it, the sweep leaves the row alone.
        expect(await reconciler.sweep(options)).toMatchObject({ replayed: 0, skipped: 1 });
        expect(queue.add).toHaveBeenCalledTimes(1);
    });
    it('rechecks the receiver after a held webhook hook before the first POST', async () => {
        const config = new config_1.ConfigService({ webhook: { failurePayloadRetentionHours: 24 } });
        const hooks = new hooks_1.HookManager();
        let release;
        const held = new Promise(resolve => (release = resolve));
        jest.spyOn(hooks, 'execute').mockImplementation(async (_event, data) => {
            await held;
            return { continue: true, data };
        });
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, hooks, new webhook_outbox_service_1.WebhookOutboxService(ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent)));
        const post = jest
            .spyOn(ssrf, 'withSafeFetch')
            .mockImplementation((_url, _init, use) => Promise.resolve(use(new undici_1.Response(null, { status: 200 }))));
        const running = delivery.redeliver(primary, primary.sessionId, 'message.received', 'held-key', {}, { singleAttempt: true });
        await webhooks.update(primary.id, { active: false });
        release();
        expect(await running).toBe('cancelled');
        expect(post).not.toHaveBeenCalled();
        expect(await failures.count()).toBe(0);
    });
    // A replay holds no dispatch slot, so the delivery drain neither waits for nor stops it. Destroying
    // the reconciler must, or the pass goes on POSTing after the drain and after plugin teardown.
    it('stops a running sweep on destroy without POSTing a retry or another row after it', async () => {
        await webhooks.update(primary.id, { retryCount: 3 });
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        for (const [i, key] of ['key-a', 'key-b'].entries()) {
            await outbox.open({
                webhookId: primary.id,
                sessionId: primary.sessionId,
                event: 'message.received',
                idempotencyKey: key,
                deliveryId: (0, node_crypto_1.randomUUID)(),
                payload: { id: i },
            });
            await repository.update({ idempotencyKey: key }, { createdAt: new Date(Date.now() - 600_000 + i) });
        }
        // key-b is over budget: a pass that went on past the stop would write its terminal failure row.
        await repository.update({ idempotencyKey: 'key-b' }, { attempts: 5 });
        // A backoff far beyond the test timeout: destroy only resolves if the stop cuts the running backoff short.
        const config = new config_1.ConfigService({ webhook: { retryDelay: 600_000, timeout: 1000 } });
        const hooks = new hooks_1.HookManager();
        const execute = jest.spyOn(hooks, 'execute');
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, hooks, outbox);
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, config);
        let posted;
        const firstPost = new Promise(resolve => (posted = resolve));
        const post = jest.spyOn(ssrf, 'withSafeFetch').mockImplementation((_url, _init, use) => {
            posted();
            return Promise.resolve(use(new undici_1.Response(null, { status: 503 })));
        });
        const sweep = reconciler.sweep({ intervalMs: 1000, graceMs: 0, batchSize: 10, maxAttempts: 5 });
        await firstPost;
        // Let the 503 settle so the retry backoff timer is already running when the stop lands.
        await new Promise(resolve => setImmediate(resolve));
        await reconciler.onModuleDestroy();
        const postsAtDestroy = post.mock.calls.length;
        const stats = await sweep;
        expect(postsAtDestroy).toBe(1);
        expect(post).toHaveBeenCalledTimes(1);
        // An interruption, not a delivery fault: counted as skipped, not failed.
        expect(stats).toMatchObject({ replayed: 0, failed: 0, skipped: 1 });
        const rows = await repository.find({ order: { idempotencyKey: 'ASC' } });
        expect(rows.map(row => [row.idempotencyKey, row.state, row.attempts])).toEqual([
            ['key-a', 'pending', 1],
            ['key-b', 'pending', 5],
        ]);
        // Interrupted, not given up: no terminal failure row or error hook, and both stay pending for the next start.
        expect(await failures.count()).toBe(0);
        expect(execute.mock.calls.filter(([name]) => name === 'webhook:error')).toHaveLength(0);
    });
    it('stops the direct fallback of a replay the queue refused in its backoff on destroy', async () => {
        await webhooks.update(primary.id, { retryCount: 3 });
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        await outbox.open({
            webhookId: primary.id,
            sessionId: primary.sessionId,
            event: 'message.received',
            idempotencyKey: 'key-a',
            deliveryId: (0, node_crypto_1.randomUUID)(),
            payload: { id: 1 },
        });
        await repository.update({ idempotencyKey: 'key-a' }, { createdAt: new Date(Date.now() - 600_000) });
        const config = new config_1.ConfigService({ queue: { enabled: true }, webhook: { retryDelay: 600_000, timeout: 1000 } });
        const hooks = new hooks_1.HookManager();
        const execute = jest.spyOn(hooks, 'execute');
        const queue = {
            add: jest.fn().mockRejectedValue(new Error('Connection is closed')),
            getJob: jest.fn().mockResolvedValue(undefined),
            waitUntilReady: jest.fn().mockResolvedValue(undefined),
        };
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, hooks, outbox, undefined, queue);
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, config);
        let posted;
        const firstPost = new Promise(resolve => (posted = resolve));
        const post = jest.spyOn(ssrf, 'withSafeFetch').mockImplementation((_url, _init, use) => {
            posted();
            return Promise.resolve(use(new undici_1.Response(null, { status: 503 })));
        });
        const sweep = reconciler.sweep({ intervalMs: 1000, graceMs: 0, batchSize: 10, maxAttempts: 5 });
        await firstPost;
        // Let the 503 settle so the retry backoff timer is already running when the stop lands.
        await new Promise(resolve => setImmediate(resolve));
        await reconciler.onModuleDestroy();
        const stats = await sweep;
        expect(queue.add).toHaveBeenCalledTimes(1);
        expect(post).toHaveBeenCalledTimes(1);
        expect(stats).toMatchObject({ replayed: 0, failed: 0, skipped: 1 });
        expect(await failures.count()).toBe(0);
        const errors = execute.mock.calls.filter(([name]) => name === 'webhook:error');
        expect(errors).toHaveLength(1);
        expect(errors[0][1]).toMatchObject({ error: expect.stringContaining('Queue failed') });
        expect(await repository.findOneByOrFail({ idempotencyKey: 'key-a' })).toMatchObject({
            state: 'pending',
            attempts: 1,
        });
    });
    // Before Redis has ever connected, the queue add waits up to the connect timeout and then falls back
    // to a direct POST. A replay whose owner stopped during that wait must send nothing and run no hooks.
    it('sends nothing for a replay stopped while its queue add waited for a first connect', async () => {
        const config = new config_1.ConfigService({ queue: { enabled: true }, webhook: { timeout: 1000 } });
        const hooks = new hooks_1.HookManager();
        const execute = jest.spyOn(hooks, 'execute');
        let onWait;
        const waiting = new Promise(resolve => (onWait = resolve));
        const never = () => new Promise(() => { });
        const queue = {
            add: jest.fn(never),
            waitUntilReady: jest.fn(() => {
                onWait();
                return never();
            }),
        };
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent));
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, hooks, outbox, undefined, queue);
        const post = jest
            .spyOn(ssrf, 'withSafeFetch')
            .mockImplementation((_url, _init, use) => Promise.resolve(use(new undici_1.Response(null, { status: 200 }))));
        const stop = new AbortController();
        let result;
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        try {
            const running = delivery
                .redeliver(primary, primary.sessionId, 'message.received', 'key-a', {}, { signal: stop.signal })
                .then(outcome => outcome, (error) => error.name);
            await waiting;
            stop.abort();
            await jest.advanceTimersByTimeAsync((0, redis_connection_1.producerConnectWaitMs)());
            result = await running;
        }
        finally {
            jest.useRealTimers();
        }
        expect(result).toBe('AbortError');
        expect(queue.add).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
        expect(execute.mock.calls.map(([name]) => name).filter(name => name !== 'webhook:before')).toEqual([]);
        expect(await failures.count()).toBe(0);
    });
    describe('a spent replay budget', () => {
        const spent = (idempotencyKey) => ({
            id: 'outbox-row',
            webhookId: primary.id,
            sessionId: primary.sessionId,
            event: 'message.received',
            idempotencyKey,
            payload: { id: 1 },
            attempts: 5,
        });
        const build = (webhook = {}) => new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, new config_1.ConfigService({ webhook }), new hooks_1.HookManager(), new webhook_outbox_service_1.WebhookOutboxService(ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent)));
        it('keeps the reason a shed delivery was recorded with, which the generic row would replace', async () => {
            await failures.save(failures.create({
                webhookId: primary.id,
                sessionId: primary.sessionId,
                event: 'message.received',
                url: primary.url,
                idempotencyKey: 'key-shed',
                attempts: 0,
                lastError: 'Webhook payload is 210 bytes after webhook:before hooks, exceeds 50',
            }));
            expect(await build().recordReplayExhaustion(spent('key-shed'), primary.url)).toBe(true);
            const rows = await failures.find();
            expect(rows).toHaveLength(1);
            expect(rows[0].attempts).toBe(5);
            expect(rows[0].lastError).toBe('Webhook replay budget exhausted; last error: Webhook payload is 210 bytes after webhook:before hooks, exceeds 50');
        });
        it('records the plain exhaustion reason when nothing was recorded before', async () => {
            expect(await build().recordReplayExhaustion(spent('key-plain'), primary.url)).toBe(true);
            expect((await failures.find()).map(row => row.lastError)).toEqual(['Webhook replay budget exhausted']);
        });
        it('leaves a terminal failure that is already on record as it is', async () => {
            await failures.save(failures.create({
                webhookId: primary.id,
                sessionId: primary.sessionId,
                event: 'message.received',
                url: primary.url,
                idempotencyKey: 'key-failed',
                attempts: 3,
                lastStatusCode: 503,
                lastError: 'HTTP 503: Service Unavailable',
            }));
            expect(await build().recordReplayExhaustion(spent('key-failed'), primary.url)).toBe(true);
            // The receiver's own answer is what the operator has to act on; the generic reason would replace it.
            const rows = await failures.find();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ attempts: 3, lastStatusCode: 503, lastError: 'HTTP 503: Service Unavailable' });
        });
        it('stores no event body on the exhaustion row while payload retention is off', async () => {
            await build().recordReplayExhaustion(spent('key-private'), primary.url);
            const [row] = await failures.find({ select: { id: true, payload: true } });
            expect(row.payload).toBeNull();
        });
        it('keeps the event body on the exhaustion row for a redrive while payload retention is on', async () => {
            await build({ failurePayloadRetentionHours: 24 }).recordReplayExhaustion(spent('key-kept'), primary.url);
            const [row] = await failures.find({ select: { id: true, payload: true } });
            expect(row.payload).toEqual({ id: 1 });
        });
    });
    it('does not replay a row whose pre-checks were under way when destroy began', async () => {
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        for (const [i, key] of ['key-a', 'key-b'].entries()) {
            await outbox.open({
                webhookId: primary.id,
                sessionId: primary.sessionId,
                event: 'message.received',
                idempotencyKey: key,
                deliveryId: (0, node_crypto_1.randomUUID)(),
                payload: { id: i },
            });
            await repository.update({ idempotencyKey: key }, { createdAt: new Date(Date.now() - 600_000 + i) });
        }
        const config = new config_1.ConfigService({ webhook: { retryDelay: 300, timeout: 1000 } });
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, new hooks_1.HookManager(), outbox);
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, config);
        const post = jest
            .spyOn(ssrf, 'withSafeFetch')
            .mockImplementation((_url, _init, use) => Promise.resolve(use(new undici_1.Response(null, { status: 200 }))));
        let reached;
        const secondCheck = new Promise(resolve => (reached = resolve));
        let release;
        const held = new Promise(resolve => (release = resolve));
        jest
            .spyOn(delivery, 'isQueueJobPending')
            .mockImplementationOnce(() => Promise.resolve(false))
            .mockImplementationOnce(async () => {
            reached();
            await held;
            return false;
        });
        const sweep = reconciler.sweep({ intervalMs: 1000, graceMs: 0, batchSize: 10, maxAttempts: 5 });
        await secondCheck;
        const destroyed = reconciler.onModuleDestroy();
        release();
        await destroyed;
        await sweep;
        expect(post).toHaveBeenCalledTimes(1);
        expect(await repository.findOneByOrFail({ idempotencyKey: 'key-b' })).toMatchObject({
            state: 'pending',
            attempts: 0,
        });
    });
    it('does not POST a retry whose backoff ended before the stop', async () => {
        await webhooks.update(primary.id, { retryCount: 2 });
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        await outbox.open({
            webhookId: primary.id,
            sessionId: primary.sessionId,
            event: 'message.received',
            idempotencyKey: 'key-a',
            deliveryId: (0, node_crypto_1.randomUUID)(),
            payload: { id: 1 },
        });
        await repository.update({ idempotencyKey: 'key-a' }, { createdAt: new Date(Date.now() - 600_000) });
        const hooks = new hooks_1.HookManager();
        const execute = jest.spyOn(hooks, 'execute');
        const config = new config_1.ConfigService({ webhook: { retryDelay: 1, timeout: 1000 } });
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, hooks, outbox);
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, config);
        const post = jest
            .spyOn(ssrf, 'withSafeFetch')
            .mockImplementation((_url, _init, use) => Promise.resolve(use(new undici_1.Response(null, { status: 503 }))));
        // The stop lands while the retry re-reads its webhook, after the backoff has already ended.
        const findOne = webhooks.findOne.bind(webhooks);
        let destroyed;
        jest.spyOn(webhooks, 'findOne').mockImplementation(options => {
            if (post.mock.calls.length === 1)
                destroyed ??= reconciler.onModuleDestroy();
            return findOne(options);
        });
        const stats = await reconciler.sweep({ intervalMs: 1000, graceMs: 0, batchSize: 10, maxAttempts: 5 });
        await destroyed;
        expect(destroyed).toBeDefined();
        expect(post).toHaveBeenCalledTimes(1);
        expect(stats).toMatchObject({ replayed: 0, failed: 0, skipped: 1 });
        expect(await failures.count()).toBe(0);
        expect(execute.mock.calls.filter(([name]) => name === 'webhook:error')).toHaveLength(0);
        expect(await repository.findOneByOrFail({ idempotencyKey: 'key-a' })).toMatchObject({
            state: 'pending',
            attempts: 1,
        });
    });
    it('reports a last-attempt replay failure that lands after the stop as a terminal failure', async () => {
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        await outbox.open({
            webhookId: primary.id,
            sessionId: primary.sessionId,
            event: 'message.received',
            idempotencyKey: 'key-a',
            deliveryId: (0, node_crypto_1.randomUUID)(),
            payload: { id: 1 },
        });
        await repository.update({ idempotencyKey: 'key-a' }, { createdAt: new Date(Date.now() - 600_000) });
        const hooks = new hooks_1.HookManager();
        const execute = jest.spyOn(hooks, 'execute');
        const config = new config_1.ConfigService({ webhook: { retryDelay: 300, timeout: 1000 } });
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService(webhooks, failures, config, hooks, outbox);
        const reconciler = new webhook_reconciler_service_1.WebhookReconcilerService(webhooks, outbox, delivery, config);
        let posted;
        const firstPost = new Promise(resolve => (posted = resolve));
        let fail;
        const held = new Promise(resolve => (fail = resolve));
        jest.spyOn(ssrf, 'withSafeFetch').mockImplementation(async (_url, _init, use) => {
            posted();
            await held;
            return use(new undici_1.Response(null, { status: 503 }));
        });
        const sweep = reconciler.sweep({ intervalMs: 1000, graceMs: 0, batchSize: 10, maxAttempts: 5 });
        await firstPost;
        const destroyed = reconciler.onModuleDestroy();
        fail();
        await destroyed;
        // retryCount 1: the POST in flight at the stop was the only attempt, so its failure is final, and
        // destroy waits for it to be recorded rather than leaving it to land after teardown.
        expect(await failures.count()).toBe(1);
        expect(execute.mock.calls.filter(([name]) => name === 'webhook:error')).toHaveLength(1);
        expect(await sweep).toMatchObject({ replayed: 0, failed: 1 });
        expect(await repository.findOneByOrFail({ idempotencyKey: 'key-a' })).toMatchObject({
            state: 'pending',
            attempts: 1,
        });
    });
});
