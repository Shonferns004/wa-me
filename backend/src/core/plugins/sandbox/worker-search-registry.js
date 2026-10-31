"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WorkerSearchRegistry = void 0;
/**
 * Worker-side search-provider handling, mirroring {@link WebhookRegistry}. A sandboxed plugin registers
 * ONE search handler (via ctx.registerSearchProvider); the registry tells the host once (so the host
 * creates a PluginSearchProvider), and on a `search` message runs the handler and replies with
 * `search-result` — a thrown handler becomes ok:false, a missing handler ok:false too.
 *
 * Unlike hooks (per-event) / webhooks (per-route), a plugin provides exactly one search handler, so
 * `register` replaces any prior handler and posts `search-provider-register` only on the first call
 * (the host dedups by `plugin:<id>` anyway, but this avoids re-registration churn).
 */
class WorkerSearchRegistry {
    post;
    handler;
    registered = false;
    constructor(post) {
        this.post = post;
    }
    register(handler) {
        this.handler = handler;
        if (this.registered)
            return;
        this.registered = true;
        this.post({ kind: 'search-provider-register' });
    }
    async handleSearch(message) {
        if (!this.handler) {
            this.post({ kind: 'search-result', id: message.id, ok: false, error: 'no search handler registered' });
            return;
        }
        try {
            const results = await this.handler(message.query);
            this.post({ kind: 'search-result', id: message.id, ok: true, results });
        }
        catch (err) {
            this.post({
                kind: 'search-result',
                id: message.id,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
exports.WorkerSearchRegistry = WorkerSearchRegistry;
