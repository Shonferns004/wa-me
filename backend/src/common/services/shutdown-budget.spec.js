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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const yaml = __importStar(require("js-yaml"));
const cache_service_1 = require("../cache/cache.service");
const redis_throttler_storage_1 = require("../throttler/redis-throttler.storage");
const configuration_1 = __importDefault(require("../../config/configuration"));
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const api_key_usage_tracker_service_1 = require("../../modules/auth/api-key-usage-tracker.service");
const redis_io_adapter_1 = require("../../modules/events/redis-io.adapter");
const integration_constants_1 = require("../../modules/integration/integration.constants");
const close_worker_1 = require("../../modules/queue/processors/close-worker");
const queue_names_1 = require("../../modules/queue/queue-names");
const shutdown_safe_queue_1 = require("../../modules/queue/shutdown-safe-queue");
const session_lifecycle_fences_1 = require("../../modules/session/session-lifecycle-fences");
const session_service_1 = require("../../modules/session/session.service");
const shutdown_budget_1 = require("./shutdown-budget");
/**
 * The bounded teardown stages, summed in Nest destroy order, must fit the shipped kill deadline. The
 * figures come from the constants the stages use, so raising one without raising the deadline (and the
 * table in shutdown-budget.ts) fails here. A new bounded stage has to be added to the sums below.
 */
describe('shutdown time budget', () => {
    const MIN_RESERVE_MS = 5_000;
    const root = (0, path_1.join)(__dirname, '../../..');
    // Each queue is its own BullModule.registerQueue module, and Nest closes modules one after the other.
    const QUEUE_COUNT = Object.keys(queue_names_1.QUEUE_NAMES).length;
    const base = shutdown_budget_1.DEFAULT_SHUTDOWN_DELAY_MS +
        integration_constants_1.INGRESS_DISPATCH_TIMEOUT_MS +
        session_lifecycle_fences_1.ENGINE_TEARDOWN_TIMEOUT_MS +
        session_service_1.AUTOSTART_SHUTDOWN_WAIT_MS +
        shutdown_budget_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS +
        api_key_usage_tracker_service_1.ApiKeyUsageTracker.SHUTDOWN_FLUSH_TIMEOUT_MS;
    const withPlugins = base + plugin_loader_service_1.PLUGIN_SHUTDOWN_WAIT_MS;
    const clustered = withPlugins +
        close_worker_1.MAX_WORKER_CLOSE_WAIT_MS +
        shutdown_safe_queue_1.QUEUE_CLOSE_TIMEOUT_MS * QUEUE_COUNT +
        redis_throttler_storage_1.THROTTLER_REDIS_QUIT_TIMEOUT_MS +
        cache_service_1.CACHE_QUIT_TIMEOUT_MS +
        redis_io_adapter_1.WS_REDIS_QUIT_TIMEOUT_MS;
    it('sums to the documented totals', () => {
        expect([base, withPlugins, clustered]).toEqual([33_000, 43_000, 63_000]);
    });
    it('registers one queue module per queue name, so the queue stage is counted per queue', () => {
        const source = (0, fs_1.readFileSync)((0, path_1.join)(root, 'src/modules/queue/queue.module.js'), 'utf8');
        expect(source.match(/BullModule\.registerQueue(Async)?\(/g)).toHaveLength(QUEUE_COUNT);
    });
    it('uses the webhook drain default the budget is written for', () => {
        expect((0, configuration_1.default)().webhook.shutdownDrainMs).toBe(shutdown_budget_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
    });
    // The reserve pays for the uncapped hooks after the HTTP close. A stage added or raised eats into it; the
    // message names the fix, so the failure does not read as a bare number mismatch.
    it('leaves a reserve for the hooks after the HTTP close, even when every cap is hit at once', () => {
        const reserveMs = shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS - (clustered - shutdown_budget_1.DEFAULT_SHUTDOWN_DELAY_MS);
        expect(reserveMs >= MIN_RESERVE_MS
            ? 'ok'
            : `reserve ${reserveMs} ms < ${MIN_RESERVE_MS} ms: raise SHUTDOWN_KILL_DEADLINE_MS, both compose files and the chart in step`).toBe('ok');
    });
    it('keeps the 67 s teardown limit and the 5 s kill margin the docs quote', () => {
        expect(shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS).toBe(67_000);
        expect(shutdown_budget_1.SHUTDOWN_KILL_DEADLINE_MS - shutdown_budget_1.DEFAULT_SHUTDOWN_DELAY_MS - shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS).toBe(5_000);
    });
    // The prose that quotes the limit and the totals has to follow the constants.
    it.each([
        ['CHANGELOG.md', [shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS, shutdown_budget_1.SHUTDOWN_KILL_DEADLINE_MS]],
        ['.env.example', [shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS, shutdown_budget_1.SHUTDOWN_KILL_DEADLINE_MS]],
        ['docs/06-api-specification.md', [shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS]],
        ['docker-compose.yml', [shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS, base, clustered]],
        ['charts/openwa/values.yaml', [shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS, clustered]],
    ])('quotes the current figures in %s', (file, figures) => {
        const text = (0, fs_1.readFileSync)((0, path_1.join)(root, file), 'utf8');
        for (const ms of figures)
            expect(text).toMatch(new RegExp(`\\b${ms / 1000} ?s\\b`));
    });
    it('moves the teardown limit 1:1 with WEBHOOK_SHUTDOWN_DRAIN_MS and keeps it a valid timer delay', () => {
        expect((0, shutdown_budget_1.shutdownTeardownLimitMs)(shutdown_budget_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS)).toBe(shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS);
        expect((0, shutdown_budget_1.shutdownTeardownLimitMs)(shutdown_budget_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS + 7_000)).toBe(shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS + 7_000);
        expect((0, shutdown_budget_1.shutdownTeardownLimitMs)(0)).toBe(shutdown_budget_1.SHUTDOWN_TEARDOWN_LIMIT_MS - shutdown_budget_1.DEFAULT_WEBHOOK_SHUTDOWN_DRAIN_MS);
        expect((0, shutdown_budget_1.shutdownTeardownLimitMs)(Number.MAX_SAFE_INTEGER)).toBe(2 ** 31 - 1);
    });
    it('matches the shipped kill deadlines in both compose files and the Helm chart', () => {
        const grace = (file) => Number(/^\s+stop_grace_period: (\d+)s$/m.exec((0, fs_1.readFileSync)((0, path_1.join)(root, file), 'utf8'))?.[1]) * 1000;
        const values = (0, fs_1.readFileSync)((0, path_1.join)(root, 'charts/openwa/values.yaml'), 'utf8');
        expect(grace('docker-compose.yml')).toBe(shutdown_budget_1.SHUTDOWN_KILL_DEADLINE_MS);
        expect(grace('docker-compose.dev.yml')).toBe(shutdown_budget_1.SHUTDOWN_KILL_DEADLINE_MS);
        expect(Number(/^terminationGracePeriodSeconds: (\d+)$/m.exec(values)?.[1]) * 1000).toBe(shutdown_budget_1.SHUTDOWN_KILL_DEADLINE_MS);
    });
    // dumb-init is PID 1 as root and gosu then runs node as uid 997. A root process without CAP_KILL can only
    // signal its own uid, so a cap_drop ALL stack that does not re-add KILL never delivers SIGTERM to node:
    // every stop waits out the whole kill deadline and ends in SIGKILL with no teardown at all.
    it.each(['docker-compose.yml', 'docker-compose.dev.yml'])('%s re-adds KILL so dumb-init can signal node', file => {
        const compose = yaml.load((0, fs_1.readFileSync)((0, path_1.join)(root, file), 'utf8'));
        const api = Object.values(compose.services).find(service => service.container_name === 'openwa-api');
        expect(api?.cap_drop).toContain('ALL');
        expect(api?.cap_add).toContain('KILL');
    });
    it('re-adds KILL in the Helm chart and in the Kubernetes example of the scaling guide', () => {
        const values = yaml.load((0, fs_1.readFileSync)((0, path_1.join)(root, 'charts/openwa/values.yaml'), 'utf8'));
        expect(values.containerSecurityContext.capabilities.add).toContain('KILL');
        const scaling = (0, fs_1.readFileSync)((0, path_1.join)(root, 'docs/13-horizontal-scaling.md'), 'utf8');
        expect(scaling).toMatch(/add: \[[^\]]*'KILL'[^\]]*\]/);
        // Kubernetes' default grace of 30 s is shorter than the teardown can take, so the example sets the deadline.
        expect(scaling).toContain(`terminationGracePeriodSeconds: ${shutdown_budget_1.SHUTDOWN_KILL_DEADLINE_MS / 1000}`);
    });
    it('destroys open sockets at the HTTP close, which the table counts as 0 s', () => {
        expect((0, fs_1.readFileSync)((0, path_1.join)(root, 'src/main.js'), 'utf8')).toMatch(/^\s+forceCloseConnections: true,/m);
    });
});
