"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeyedAsyncLock = void 0;
exports.orderingKeyFor = orderingKeyFor;
// Single-node, in-process keyed lock: a chain of promises per key. The ordering key is a plain
// string (no closures) so a distributed lock (e.g. Redis redlock / SET NX PX) can replace this
// verbatim once ingress runs on more than one node.
class KeyedAsyncLock {
    tails = new Map();
    run(key, fn) {
        const prev = this.tails.get(key) ?? Promise.resolve();
        // Chain fn after prev; swallow prev's rejection so one failure doesn't poison the chain.
        const next = prev.catch(() => undefined).then(fn);
        this.tails.set(key, next);
        // Clean up the map entry once this is the tail and it settles, to avoid unbounded growth.
        void next
            .catch(() => undefined)
            .finally(() => {
            if (this.tails.get(key) === next)
                this.tails.delete(key);
        });
        return next;
    }
}
exports.KeyedAsyncLock = KeyedAsyncLock;
// Key on the CONVERSATION, never the deliveryId (a delivery-unique key would serialize nothing).
// providerConversationId is populated host-side when the plugin manifest declares a conversationId
// pointer; absent it, we serialize per instance: correct (never reorders within a conversation) but
// coarse. The conversation key unlocks intra-instance parallelism once the manifest declares the
// pointer. The key is scoped per (plugin, instance): an instanceId is unique only within its plugin,
// so two plugins may both name an instance 'prod' and must not serialize each other. NUL-joined so
// no choice of ids can make one tuple read as another; an absent conversation is the empty field.
function orderingKeyFor(job) {
    return [job.pluginId, job.instanceId, job.providerConversationId ?? ''].join('\u0000');
}
