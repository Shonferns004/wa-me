"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const constants_1 = require("@nestjs/common/constants");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const testing_1 = require("@nestjs/testing");
const bullmq_1 = require("@nestjs/bullmq");
const typeorm_1 = require("@nestjs/typeorm");
const bullmq_2 = require("bullmq");
const ingress_processor_1 = require("./processors/ingress.processor");
const webhook_processor_1 = require("./processors/webhook.processor");
const queue_names_1 = require("./queue-names");
const queue_module_1 = require("./queue.module");
const close_worker_1 = require("./processors/close-worker");
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const hooks_1 = require("../../core/hooks");
const shutdown_service_1 = require("../../common/services/shutdown.service");
const logger_module_1 = require("../../common/services/logger.module");
const integration_delivery_failure_entity_1 = require("../integration/entities/integration-delivery-failure.entity");
const ingress_event_entity_1 = require("../integration/entities/ingress-event.entity");
const webhook_entity_1 = require("../webhook/entities/webhook.entity");
const webhook_delivery_failure_entity_1 = require("../webhook/entities/webhook-delivery-failure.entity");
const webhook_outbox_service_1 = require("../webhook/webhook-outbox.service");
/**
 * A worker that is still open when PluginLoaderService disables the plugins keeps taking jobs, and
 * each one fails against a terminated sandbox. The real lifecycle runs here (BullModule's explorer,
 * Nest's destroy and shutdown order, the real processors) with Redis-free queue and worker classes,
 * and the plugin stub sits in a global module the way PluginsModule does, so it is destroyed last.
 */
class FakeWorker {
    name;
    static all = [];
    // Worker.close() while Redis is unreachable: it never settles.
    static closeHangs = false;
    closed = false;
    constructor(name) {
        this.name = name;
        FakeWorker.all.push(this);
    }
    on() {
        return this;
    }
    close() {
        if (FakeWorker.closeHangs)
            return new Promise(() => undefined);
        this.closed = true;
        return Promise.resolve();
    }
}
class FakeQueue {
    name;
    opts;
    constructor(name, opts = {}) {
        this.name = name;
        this.opts = opts;
    }
    close() {
        return Promise.resolve();
    }
}
let pluginTeardownRan = false;
function buildRootModule(openAtPluginTeardown, openAtSessionTeardown = []) {
    class PluginLoaderStub {
        onModuleDestroy() {
            pluginTeardownRan = true;
            openAtPluginTeardown.push(...FakeWorker.all.filter(w => !w.closed).map(w => w.name));
        }
    }
    let PluginsStubModule = class PluginsStubModule {
    };
    PluginsStubModule = __decorate([
        (0, common_1.Global)(),
        (0, common_1.Module)({
            providers: [{ provide: plugin_loader_service_1.PluginLoaderService, useClass: PluginLoaderStub }],
            exports: [plugin_loader_service_1.PluginLoaderService],
        })
    ], PluginsStubModule);
    const repo = {};
    let QueueStubModule = class QueueStubModule {
    };
    QueueStubModule = __decorate([
        (0, common_1.Module)({
            imports: [
                bullmq_1.BullModule.forRoot({ connection: {} }),
                bullmq_1.BullModule.registerQueue({ name: queue_names_1.QUEUE_NAMES.WEBHOOK }, { name: queue_names_1.QUEUE_NAMES.INGRESS }),
            ],
            providers: [
                ingress_processor_1.IngressProcessor,
                webhook_processor_1.WebhookProcessor,
                { provide: (0, typeorm_1.getRepositoryToken)(integration_delivery_failure_entity_1.IntegrationDeliveryFailure, 'data'), useValue: repo },
                { provide: (0, typeorm_1.getRepositoryToken)(ingress_event_entity_1.IngressEvent, 'data'), useValue: repo },
                { provide: (0, typeorm_1.getRepositoryToken)(webhook_entity_1.Webhook, 'data'), useValue: repo },
                { provide: (0, typeorm_1.getRepositoryToken)(webhook_delivery_failure_entity_1.WebhookDeliveryFailure, 'data'), useValue: repo },
                { provide: hooks_1.HookManager, useValue: {} },
                { provide: config_1.ConfigService, useValue: { get: (_key, fallback) => fallback } },
                { provide: webhook_outbox_service_1.WebhookOutboxService, useValue: {} },
            ],
        })
    ], QueueStubModule);
    // SessionModule sits closer to the root than QueueModule, so Nest destroys it, and the engines with
    // it, before the processors' own destroy hooks run.
    class SessionStub {
        onModuleDestroy() {
            openAtSessionTeardown.push(...FakeWorker.all.filter(w => !w.closed).map(w => w.name));
        }
    }
    let SessionStubModule = class SessionStubModule {
    };
    SessionStubModule = __decorate([
        (0, common_1.Module)({ imports: [QueueStubModule], providers: [SessionStub] })
    ], SessionStubModule);
    let RootModule = class RootModule {
    };
    RootModule = __decorate([
        (0, common_1.Module)({ imports: [logger_module_1.LoggerModule, PluginsStubModule, SessionStubModule] })
    ], RootModule);
    return RootModule;
}
describe('queue workers at shutdown', () => {
    beforeEach(() => {
        bullmq_1.BullModule.queueClass = FakeQueue;
        bullmq_1.BullModule.workerClass = FakeWorker;
        FakeWorker.all = [];
        FakeWorker.closeHangs = false;
        pluginTeardownRan = false;
    });
    afterAll(() => {
        bullmq_1.BullModule.queueClass = bullmq_2.Queue;
        bullmq_1.BullModule.workerClass = bullmq_2.Worker;
    });
    // Nest destroys global modules last; the ordering below only holds while QueueModule is not one of them.
    it('keeps the processors in a module that is not global', () => {
        expect(Reflect.getMetadata(constants_1.GLOBAL_MODULE_METADATA, queue_module_1.QueueModule)).toBeUndefined();
        expect(Reflect.getMetadata(constants_1.MODULE_METADATA.PROVIDERS, queue_module_1.QueueModule)).toEqual(expect.arrayContaining([ingress_processor_1.IngressProcessor, webhook_processor_1.WebhookProcessor]));
    });
    it('closes every worker before the plugins are torn down', async () => {
        const openAtPluginTeardown = [];
        const app = await core_1.NestFactory.createApplicationContext(buildRootModule(openAtPluginTeardown), { logger: false });
        expect(FakeWorker.all.map(w => w.name).sort()).toEqual([queue_names_1.QUEUE_NAMES.INGRESS, queue_names_1.QUEUE_NAMES.WEBHOOK].sort());
        await app.close();
        expect(openAtPluginTeardown).toEqual([]);
    });
    // A plugin's ingress handler sends through the session engines, so a job taken once they are torn
    // down fails and spends an attempt. The worker stops taking jobs when shutdown begins instead.
    it('stops taking ingress jobs before the sessions are torn down', async () => {
        const openAtSessionTeardown = [];
        const app = await core_1.NestFactory.createApplicationContext(buildRootModule([], openAtSessionTeardown), {
            logger: false,
        });
        const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            app.get(shutdown_service_1.ShutdownService).markShuttingDown();
            await app.close();
        }
        finally {
            log.mockRestore();
        }
        expect(openAtSessionTeardown).not.toContain(queue_names_1.QUEUE_NAMES.INGRESS);
    });
    // The early close must not leave the plugins up forever when Redis is gone: past the bounded wait the
    // global destroy hooks run, as they did when the workers were only closed at application shutdown.
    it('stops waiting for a worker that cannot close and still tears down the plugins', async () => {
        FakeWorker.closeHangs = true;
        const app = await core_1.NestFactory.createApplicationContext(buildRootModule([]), { logger: false });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.useFakeTimers();
        try {
            const closing = app.close();
            await jest.advanceTimersByTimeAsync(close_worker_1.MAX_WORKER_CLOSE_WAIT_MS - 1);
            expect(pluginTeardownRan).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(pluginTeardownRan).toBe(true);
            // BullModule awaits the same worker close again in onApplicationShutdown, ahead of the DataSource
            // close; it must not wait on the close that never settles.
            await expect(closing).resolves.toBeUndefined();
            const warned = warn.mock.calls.flat().join('\n');
            expect(warned).toContain(queue_names_1.QUEUE_NAMES.INGRESS);
            expect(warned).toContain(queue_names_1.QUEUE_NAMES.WEBHOOK);
        }
        finally {
            jest.useRealTimers();
            warn.mockRestore();
        }
    });
    // A bootstrap that fails before listen() closes an app whose workers were never created; the destroy
    // hooks must not reject, or the remaining teardown (plugins, database, Redis) is skipped.
    it('tears down an app closed before its workers were created', async () => {
        const moduleRef = await testing_1.Test.createTestingModule({ imports: [buildRootModule([])] }).compile();
        expect(FakeWorker.all).toEqual([]);
        await expect(moduleRef.close()).resolves.toBeUndefined();
        expect(pluginTeardownRan).toBe(true);
    });
});
