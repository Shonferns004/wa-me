"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requireClient = requireClient;
exports.rethrowIfNavigation = rethrowIfNavigation;
exports.withPage = withPage;
exports.reportPageDeath = reportPageDeath;
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
/**
 * The client of a send or status path, read after ensureReady() and any awaits since (a recipient lookup, a
 * media fetch). The adapter's getClient already refuses a session that is not ready; this keeps a host that
 * still has no client from handing the send a null typed as a Client, which would die as a TypeError 500 and
 * count toward the send breaker.
 */
function requireClient(host) {
    const client = host.getClient();
    if (!client)
        throw new engine_not_ready_error_1.EngineNotReadyError();
    return client;
}
/**
 * Answer the retryable 409 the adapter gives inside the navigation window when the error says the page
 * navigated under the call, and return for any other error. A call already in flight when WhatsApp Web
 * reloads dies with Puppeteer's navigation error before the window is stamped, so it would otherwise be a
 * bare 500, or, where a catch folds a failed lookup into "not found", a 404 for a group, contact or label
 * that exists. A navigation is not a death: nothing is reported.
 */
function rethrowIfNavigation(host, error) {
    // A page the host already reads as dead is reported as dead, whatever the message says.
    if ((0, wwebjs_lifecycle_1.isNavigationError)(error) && !host.isPageTransportError(error))
        throw new engine_not_ready_error_1.EngineNotReadyError(wwebjs_lifecycle_1.PAGE_RELOADING_MESSAGE);
}
/**
 * Run a client operation, classifying a dead page/transport as the documented 503 plus an early
 * death signal instead of an opaque 500 under a status that still says READY - the split every
 * chats read already makes (#1081), and a page that navigated under the call as the 409 of
 * {@link rethrowIfNavigation}. Other errors propagate unchanged.
 *
 * Lives here rather than per delegate: ./wwebjs-channels, ./wwebjs-profile and ./wwebjs-status each
 * held a byte-identical private copy, and ./wwebjs-contacts needed a fourth.
 */
async function withPage(host, context, op) {
    try {
        return await op();
    }
    catch (error) {
        rethrowIfNavigation(host, error);
        if (host.isPageTransportError(error)) {
            host.reportIfPageTransportError(error, context);
            throw new engine_transport_error_1.EngineTransportError(`Transport died during ${context}`);
        }
        throw error;
    }
}
/**
 * The NON-IDEMPOTENT counterpart of {@link withPage}: report a dead page as the same early death
 * signal, then rethrow the error with the caller's status unchanged (a failure WhatsApp Web threw in
 * the page keeps its 500 and only gains its reason, see toCapturedPageError).
 *
 * whatsapp-web.js can throw AFTER the request is already on the wire (see `sendResolved` in
 * ./wwebjs-messaging, which reports and rethrows for exactly this reason), so a transport failure
 * here does NOT prove the status was not posted or the channel not created. `503` is the one status
 * the clients read as proof the gateway declined before acting, and the Go client replays a POST on
 * it, so answering it would have a retrying caller publish the status twice.
 *
 * ./baileys-channels leaves `createChannel` unbounded on the same reasoning, and the message sends
 * keep their `500` rather than a replayable `503`. Use {@link withPage} for reads and for
 * operations that converge when repeated, including DELETE.
 */
async function reportPageDeath(host, context, op) {
    try {
        return await op();
    }
    catch (error) {
        host.reportIfPageTransportError(error, context);
        // A status post runs the same patched Client.sendMessage as a message send, so a failure WhatsApp
        // Web threw in the page reaches the caller with its reason. A no-op for every other error.
        const mapped = (0, wwebjs_lifecycle_1.toCapturedPageError)(error);
        if (mapped !== error) {
            // The mapped error is an HttpException, which Nest does not log, and a status post's own log line
            // (StatusService.recordedPost) carries only the session and kind: this is the line that keeps the
            // full in-page summary.
            host.logger.warn(`WhatsApp Web threw during ${context}`, {
                sessionId: host.config.sessionId,
                cause: error.message,
            });
        }
        throw mapped;
    }
}
