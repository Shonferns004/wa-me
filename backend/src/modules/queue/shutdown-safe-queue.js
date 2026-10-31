"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShutdownSafeQueue = exports.QUEUE_CLOSE_TIMEOUT_MS = void 0;
const bullmq_1 = require("bullmq");
const logger_service_1 = require("../../common/services/logger.service");
const logger = (0, logger_service_1.createLogger)('QueueShutdown');
/** How long a producer queue close may take. Same bound as the other Redis quits (cache, throttler, WebSocket). */
exports.QUEUE_CLOSE_TIMEOUT_MS = 2000;
/**
 * A producer Queue whose close() neither rejects nor hangs. BullModule awaits that close in the
 * queue's onApplicationShutdown hook, Nest does not catch a rejected hook, and every later hook is
 * skipped: the global DataSource close and the ffmpeg kill. Two Redis failures reach it. Once Redis
 * has dropped, the producer connection has no offline queue and the QUIT inside Queue.close()
 * rejects at once. On a half-open socket (a network partition) the QUIT is written and no reply ever
 * arrives, so the close never settles and the later hooks wait for the force-exit. Either way the
 * failure is logged and the connection is dropped, within QUEUE_CLOSE_TIMEOUT_MS. The disconnect is
 * not awaited: on a socket that is already gone ioredis never emits the 'end' it would wait for.
 */
class ShutdownSafeQueue extends bullmq_1.Queue {
    async close() {
        let timer;
        try {
            await Promise.race([
                super.close(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new Error(`close did not settle within ${exports.QUEUE_CLOSE_TIMEOUT_MS} ms`)), exports.QUEUE_CLOSE_TIMEOUT_MS);
                }),
            ]);
        }
        catch (err) {
            logger.warn('Queue close failed; dropping the connection and continuing shutdown', {
                queue: this.name,
                error: err instanceof Error ? err.message : String(err),
            });
            this.disconnect().catch(() => undefined);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.ShutdownSafeQueue = ShutdownSafeQueue;
