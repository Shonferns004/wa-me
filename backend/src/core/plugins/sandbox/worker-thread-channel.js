"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerThreadChannel = void 0;
const worker_threads_1 = require("worker_threads");
/**
 * Real {@link PluginWorkerChannel} backed by a Node `worker_thread`. Deliberately thin: it only
 * shuttles messages and surfaces worker lifetime events. All protocol logic lives in
 * {@link PluginWorkerHost}, so this adapter (and a future child-process variant) stays trivial.
 */
class WorkerThreadChannel {
    worker;
    constructor(options) {
        this.worker = new worker_threads_1.Worker(options.workerEntry, {
            execArgv: options.execArgv,
            env: options.env,
            resourceLimits: options.maxOldGenerationSizeMb !== undefined
                ? { maxOldGenerationSizeMb: options.maxOldGenerationSizeMb }
                : undefined,
        });
    }
    postMessage(message) {
        this.worker.postMessage(message);
    }
    onMessage(handler) {
        this.worker.on('message', handler);
        // Surface a worker startup/runtime crash as a protocol error so the host's pending call rejects
        // with the real reason instead of only an opaque exit code.
        this.worker.on('error', (error) => handler({ kind: 'error', error: error instanceof Error ? error.message : String(error) }));
    }
    onExit(handler) {
        this.worker.on('exit', handler);
    }
    async terminate() {
        await this.worker.terminate();
    }
}
exports.WorkerThreadChannel = WorkerThreadChannel;
