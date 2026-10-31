"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const bullmq_1 = require("@nestjs/bullmq");
const queue_names_1 = require("./queue-names");
const queue_module_1 = require("./queue.module");
const shutdown_safe_queue_1 = require("./shutdown-safe-queue");
const webhook_module_1 = require("../webhook/webhook.module");
const webhook_outbox_module_1 = require("../webhook/webhook-outbox.module");
const webhook_outbox_service_1 = require("../webhook/webhook-outbox.service");
// A stub base keeps the factory from opening a Redis connection; ShutdownSafeQueue still extends it.
jest.mock('bullmq', () => ({
    ...jest.requireActual('bullmq'),
    Queue: class {
        name;
        constructor(name) {
            this.name = name;
        }
    },
}));
// The producers must be built as ShutdownSafeQueue: without it a dropped Redis rejects or hangs their
// close and Nest skips the DataSource close behind it. registerQueue captures the class when the
// @Module decorator runs, so the check builds the registered producers instead of reading the static.
describe('QueueModule producers', () => {
    it.each([queue_names_1.QUEUE_NAMES.WEBHOOK, queue_names_1.QUEUE_NAMES.INGRESS])('%s is created as a ShutdownSafeQueue', async (name) => {
        const imports = Reflect.getMetadata('imports', queue_module_1.QueueModule);
        const provider = imports
            .flatMap(m => m.providers ?? [])
            .find(p => p.provide === (0, bullmq_1.getQueueToken)(name));
        expect(provider).toBeDefined();
        expect(await provider.useFactory({ name })).toBeInstanceOf(shutdown_safe_queue_1.ShutdownSafeQueue);
    });
});
/**
 * Failed webhook jobs retain their full payload in Redis until eviction, so the retention window
 * must stay bounded on BOTH axes (count and age). The durable record of a lost delivery is the
 * webhook_delivery_failures row written on the final attempt — Redis is only a debugging window.
 * Payload bytes are bounded separately: media is shed before enqueue (see WebhookService).
 */
describe('WEBHOOK_QUEUE_JOB_OPTIONS', () => {
    it('auto-evicts completed jobs on a bounded count and age', () => {
        const opts = queue_module_1.WEBHOOK_QUEUE_JOB_OPTIONS.removeOnComplete;
        expect(typeof opts).toBe('object'); // a bounded window, not `false` (keep forever) / `true` (drop all)
        expect(opts.count).toBeGreaterThan(0);
        expect(opts.age).toBeGreaterThan(0);
    });
    it('auto-evicts failed jobs on a bounded count and age', () => {
        const opts = queue_module_1.WEBHOOK_QUEUE_JOB_OPTIONS.removeOnFail;
        expect(typeof opts).toBe('object');
        expect(opts.count).toBeGreaterThan(0);
        expect(opts.age).toBeGreaterThan(0);
    });
});
// The processors and the webhook module both need the outbox. Providing the service in each module made
// two instances with queue on, and its startup prune and daily timer ran twice.
describe('WebhookOutboxService wiring', () => {
    it('is provided by one module and imported by the queue and webhook modules', () => {
        for (const owner of [queue_module_1.QueueModule, webhook_module_1.WebhookModule]) {
            expect(Reflect.getMetadata('providers', owner)).not.toContain(webhook_outbox_service_1.WebhookOutboxService);
            expect(Reflect.getMetadata('imports', owner)).toContain(webhook_outbox_module_1.WebhookOutboxModule);
        }
        expect(Reflect.getMetadata('providers', webhook_outbox_module_1.WebhookOutboxModule)).toEqual([webhook_outbox_service_1.WebhookOutboxService]);
        expect(Reflect.getMetadata('exports', webhook_outbox_module_1.WebhookOutboxModule)).toEqual([webhook_outbox_service_1.WebhookOutboxService]);
    });
});
