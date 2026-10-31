"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WebhookRegistry = void 0;
const worker_hooks_1 = require("./worker-hooks");
/**
 * Worker-side webhook handling, mirroring WorkerHookRegistry. A sandboxed plugin registers one
 * handler per ingress route (via ctx.registerWebhook). The registry subscribes the host to the route
 * the first time it sees a handler for it, and on a `webhook` message runs the handler and replies
 * with `webhook-result` — a thrown handler becomes a 500 error result, an unknown route a 404.
 */
class WebhookRegistry {
    post;
    handlers = new Map();
    constructor(post) {
        this.post = post;
    }
    register(route, handler) {
        this.handlers.set(route, handler);
        this.post({ kind: 'webhook-subscribe', route });
    }
    async handleWebhook(message) {
        const handler = this.handlers.get(message.route);
        if (!handler) {
            this.post({ kind: 'webhook-result', id: message.id, status: 404, error: 'no handler for route' });
            return;
        }
        // Run inside the per-instance config scope so ctx.config resolves to this delivery's instance config
        // (mirrors WorkerHookRegistry.handleHook). Absent config => the bootstrap getter falls back to base.
        const run = async () => {
            try {
                const result = await handler({
                    instanceId: message.instanceId,
                    method: message.method,
                    headers: message.headers,
                    query: message.query,
                    body: message.body,
                    rawBody: message.rawBody,
                    verified: message.verified,
                    deliveryId: message.deliveryId,
                    sessionId: message.sessionId,
                });
                this.post({
                    kind: 'webhook-result',
                    id: message.id,
                    status: result?.status ?? 200,
                    headers: result?.headers,
                    body: result?.body,
                });
            }
            catch (err) {
                this.post({
                    kind: 'webhook-result',
                    id: message.id,
                    status: 500,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        };
        if (message.config !== undefined)
            await worker_hooks_1.hookConfigStore.run({ config: message.config }, run);
        else
            await run();
    }
}
exports.WebhookRegistry = WebhookRegistry;
