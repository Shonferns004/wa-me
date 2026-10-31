"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin_worker_host_1 = require("./plugin-worker-host");
const worker_webhooks_1 = require("./worker-webhooks");
const worker_hooks_1 = require("./worker-hooks");
/**
 * A fake worker channel mirroring the IPC surface the host talks to. It conforms to
 * PluginWorkerChannel so the real PluginWorkerHost constructor accepts it (channel-only), and lets a
 * test drive the worker side: capture posted messages, replay a `webhook-result`, or simulate a crash.
 */
function fakeChannel() {
    const handlers = {};
    const posted = [];
    return {
        posted,
        postMessage: (m) => {
            posted.push(m);
        },
        onMessage: (cb) => {
            handlers.message = cb;
        },
        onExit: (cb) => {
            handlers.exit = cb;
        },
        terminate: () => Promise.resolve(),
        emitMessage: (m) => handlers.message?.(m),
        emitExit: (code) => handlers.exit?.(code),
    };
}
const webhookOptions = () => ({
    instanceId: 'i',
    route: 'chatwoot',
    method: 'POST',
    headers: {},
    query: {},
    body: '{}',
    rawBody: '{}',
    verified: true,
    deliveryId: 'd1',
    timeoutMs: 1000,
});
describe('PluginWorkerHost.dispatchWebhook', () => {
    it('resolves with the worker webhook-result when the worker replies', async () => {
        const channel = fakeChannel();
        const host = new plugin_worker_host_1.PluginWorkerHost(channel);
        const promise = host.dispatchWebhook(webhookOptions());
        const sent = channel.posted.find(m => m.kind === 'webhook');
        channel.emitMessage({ kind: 'webhook-result', id: sent.id, status: 200, body: 'ok' });
        await expect(promise).resolves.toMatchObject({ ok: true, status: 200, body: 'ok' });
    });
    it('fail-opens to 504 when the worker never replies before the timeout', async () => {
        jest.useFakeTimers();
        try {
            const host = new plugin_worker_host_1.PluginWorkerHost(fakeChannel());
            const promise = host.dispatchWebhook(webhookOptions());
            jest.advanceTimersByTime(1001);
            await expect(promise).resolves.toMatchObject({ ok: false, status: 504 });
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('invokes onTimeout when the fail-open timeout fires', async () => {
        jest.useFakeTimers();
        try {
            const onTimeout = jest.fn();
            const host = new plugin_worker_host_1.PluginWorkerHost(fakeChannel());
            const promise = host.dispatchWebhook({ ...webhookOptions(), onTimeout });
            jest.advanceTimersByTime(1001);
            await promise;
            expect(onTimeout).toHaveBeenCalledTimes(1);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('drains pending webhooks to 502 when the worker crashes mid-request', async () => {
        const channel = fakeChannel();
        const host = new plugin_worker_host_1.PluginWorkerHost(channel);
        const promise = host.dispatchWebhook({ ...webhookOptions(), timeoutMs: 100000 });
        channel.emitExit(1);
        await expect(promise).resolves.toMatchObject({ ok: false, status: 502 });
    });
    it('surfaces a worker handler error as ok:false with the reported status', async () => {
        const channel = fakeChannel();
        const host = new plugin_worker_host_1.PluginWorkerHost(channel);
        const promise = host.dispatchWebhook(webhookOptions());
        const sent = channel.posted.find(m => m.kind === 'webhook');
        channel.emitMessage({ kind: 'webhook-result', id: sent.id, status: 500, error: 'boom' });
        await expect(promise).resolves.toMatchObject({ ok: false, status: 500, error: 'boom' });
    });
});
describe('WebhookRegistry config scoping', () => {
    it('exposes the webhook message config via hookConfigStore during the handler', async () => {
        let seen;
        const reg = new worker_webhooks_1.WebhookRegistry(() => { });
        reg.register('r', () => {
            seen = worker_hooks_1.hookConfigStore.getStore()?.config;
        });
        await reg.handleWebhook({
            kind: 'webhook',
            id: 1,
            instanceId: 'i',
            route: 'r',
            method: 'POST',
            headers: {},
            query: {},
            body: '',
            rawBody: '',
            verified: true,
            deliveryId: 'd',
            config: { baseUrl: 'https://x' },
        });
        expect(seen).toEqual({ baseUrl: 'https://x' });
    });
});
