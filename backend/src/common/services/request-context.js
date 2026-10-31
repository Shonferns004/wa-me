"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWithRequestId = runWithRequestId;
exports.outsideRequest = outsideRequest;
exports.getRequestId = getRequestId;
exports.setRequestActor = setRequestActor;
exports.getRequestActor = getRequestActor;
/**
 * Per-request async context, propagated to every log line and audit record produced while handling a
 * request. Today it carries the X-Request-ID plus the resolved API key and client IP, so audit log
 * rows are stamped with who made the call and from where WITHOUT every controller having to thread
 * `@CurrentApiKey()` + `req.ip` into each `auditService.log*()` call (most call sites legitimately
 * don't know the key — they fire from deep inside services). Backed by a dedicated AsyncLocalStorage
 * instance — independent of the existing plugin/hook ALS instances (multiple ALS instances coexist fine).
 */
const node_async_hooks_1 = require("node:async_hooks");
const requestContextStorage = new node_async_hooks_1.AsyncLocalStorage();
/** Run `fn` (and every async continuation it starts) with `requestId` as the active context. */
function runWithRequestId(requestId, fn) {
    return requestContextStorage.run({ requestId }, fn);
}
/** Run `fn`, and what it schedules, with no request context: work a request started that is not part of it. */
function outsideRequest(fn) {
    return requestContextStorage.exit(fn);
}
/** The active request id, or `undefined` when not running inside a request scope. */
function getRequestId() {
    return requestContextStorage.getStore()?.requestId;
}
/**
 * Stamp the resolved API key + client IP into the active request context so downstream audit log
 * writes (which typically happen inside services without DI access to the key) can attribute the
 * action. No-op outside a request scope (e.g. worker/cron), so callers don't need to guard. The
 * guard/middleware call this once they've resolved the key; services never need to.
 */
function setRequestActor(actor) {
    const store = requestContextStorage.getStore();
    if (!store)
        return; // not in a request scope — nothing to stamp
    if (actor.apiKeyId !== undefined)
        store.apiKeyId = actor.apiKeyId;
    if (actor.apiKeyName !== undefined)
        store.apiKeyName = actor.apiKeyName;
    if (actor.ipAddress !== undefined)
        store.ipAddress = actor.ipAddress;
}
/** The active request's resolved actor (API key + IP), or `undefined` outside a request scope. */
function getRequestActor() {
    const store = requestContextStorage.getStore();
    if (!store)
        return undefined;
    return { apiKeyId: store.apiKeyId, apiKeyName: store.apiKeyName, ipAddress: store.ipAddress };
}
