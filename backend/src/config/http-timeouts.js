"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveRequestTimeoutMs = resolveRequestTimeoutMs;
exports.applyHttpTimeouts = applyHttpTimeouts;
/**
 * REQUEST_TIMEOUT_MS as configured, defaulting to Node's 300 s. Shared by the server config and the
 * in-flight body budget, which paces declared bodies against the same timeout.
 */
function resolveRequestTimeoutMs(raw) {
    return parseInt(raw || '300000', 10);
}
/**
 * Write the configured timeouts onto the server and return the resolved values (which may differ
 * from the request when headersTimeout had to be bumped above keepAliveTimeout). Boot logs the
 * returned report so the applied values are observable.
 */
function applyHttpTimeouts(server, cfg) {
    const requestTimeoutMs = Math.floor(cfg.requestTimeoutMs);
    const keepAliveTimeoutMs = Math.floor(cfg.keepAliveTimeoutMs);
    const requestedHeadersMs = Math.floor(cfg.headersTimeoutMs);
    // Node requires headersTimeout > keepAliveTimeout (it logs a warning and self-corrects otherwise,
    // which is invisible to the operator). Bump by a second rather than failing boot — the point is to
    // make the applied values correct and observable.
    const headersTimeoutMs = requestedHeadersMs > keepAliveTimeoutMs ? requestedHeadersMs : keepAliveTimeoutMs + 1000;
    server.requestTimeout = requestTimeoutMs;
    server.headersTimeout = headersTimeoutMs;
    server.keepAliveTimeout = keepAliveTimeoutMs;
    return { requestTimeoutMs, headersTimeoutMs, keepAliveTimeoutMs };
}
