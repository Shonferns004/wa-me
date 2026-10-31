"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const bullmq_1 = require("@nestjs/bullmq");
const bullmq_2 = require("bullmq");
const logger_module_1 = require("../../common/services/logger.module");
const logger_service_1 = require("../../common/services/logger.service");
const shutdown_safe_queue_1 = require("./shutdown-safe-queue");
const REDIS_DOWN = "Stream isn't writeable and enableOfflineQueue options is false";
/** A ShutdownSafeQueue with no Redis behind it: Queue.close() rejects the way a dropped connection does. */
class DroppedQueue {
    name;
    constructor(name) {
        this.name = name;
        return Object.assign(Object.create(shutdown_safe_queue_1.ShutdownSafeQueue.prototype), { name });
    }
}
describe('ShutdownSafeQueue', () => {
    let superClose;
    let disconnect;
    let warn;
    beforeEach(() => {
        superClose = jest.spyOn(bullmq_2.Queue.prototype, 'close').mockRejectedValue(new Error(REDIS_DOWN));
        disconnect = jest.spyOn(Object.getPrototypeOf(bullmq_2.Queue.prototype), 'disconnect').mockResolvedValue(undefined);
        warn = jest.spyOn(logger_service_1.LoggerService.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(() => {
        bullmq_1.BullModule.queueClass = bullmq_2.Queue;
    });
    it('settles a close that rejects, logs it and drops the connection', async () => {
        const queue = new DroppedQueue('webhook');
        await expect(queue.close()).resolves.toBeUndefined();
        expect(superClose).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(warn.mock.calls)).toContain(REDIS_DOWN);
    });
    // A half-open socket swallows the QUIT: the close neither resolves nor rejects.
    it('settles a close that never settles at the deadline, logs it and drops the connection', async () => {
        jest.useFakeTimers();
        try {
            superClose.mockReturnValue(new Promise(() => undefined));
            const queue = new DroppedQueue('webhook');
            let settled = false;
            const closing = queue.close().then(() => {
                settled = true;
            });
            await jest.advanceTimersByTimeAsync(shutdown_safe_queue_1.QUEUE_CLOSE_TIMEOUT_MS - 1);
            expect(settled).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            await closing;
            expect(disconnect).toHaveBeenCalledTimes(1);
            expect(JSON.stringify(warn.mock.calls)).toContain(`${shutdown_safe_queue_1.QUEUE_CLOSE_TIMEOUT_MS} ms`);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('leaves no timer behind after a close that resolves', async () => {
        jest.useFakeTimers();
        try {
            superClose.mockResolvedValue(undefined);
            const queue = new DroppedQueue('webhook');
            await queue.close();
            expect(jest.getTimerCount()).toBe(0);
            expect(disconnect).not.toHaveBeenCalled();
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('does not wait for a disconnect that never settles', async () => {
        disconnect.mockReturnValue(new Promise(() => undefined));
        const queue = new DroppedQueue('webhook');
        await expect(queue.close()).resolves.toBeUndefined();
    });
    // Nest does not catch a rejected shutdown hook, so one queue that fails to close would skip the hooks
    // of every module destroyed after it. Global modules, the DataSource's among them, are destroyed last.
    it('lets the later shutdown hooks run when the producer close fails in a real app', async () => {
        bullmq_1.BullModule.queueClass = DroppedQueue;
        let databaseClosed = false;
        let DatabaseStubModule = class DatabaseStubModule {
            onApplicationShutdown() {
                databaseClosed = true;
            }
        };
        DatabaseStubModule = __decorate([
            (0, common_1.Global)(),
            (0, common_1.Module)({})
        ], DatabaseStubModule);
        let RootModule = class RootModule {
        };
        RootModule = __decorate([
            (0, common_1.Module)({
                imports: [
                    logger_module_1.LoggerModule,
                    DatabaseStubModule,
                    bullmq_1.BullModule.forRoot({ connection: {} }),
                    bullmq_1.BullModule.registerQueue({ name: 'webhook' }),
                ],
            })
        ], RootModule);
        const app = await core_1.NestFactory.createApplicationContext(RootModule, { logger: false });
        await expect(app.close()).resolves.toBeUndefined();
        expect(superClose).toHaveBeenCalled();
        expect(databaseClosed).toBe(true);
    });
});
