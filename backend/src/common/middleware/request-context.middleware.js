"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestContextMiddleware = requestContextMiddleware;
const node_crypto_1 = require("node:crypto");
const request_context_1 = require("../services/request-context");
/**
 * Functional Express middleware: assign a request id to every inbound request, echo it on the
 * `X-Request-ID` response header, and run the entire downstream chain inside the request scope so
 * every log line and audit record can carry it (see LoggerService / AuditService).
 *
 * Accepts a sane client-supplied id (alphanumeric + dash, ≤128 chars); anything else — including a
 * CRLF header-injection attempt — is ignored and a fresh UUID is generated instead.
 */
const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;
function requestContextMiddleware(req, res, next) {
    const incoming = req.header('x-request-id');
    const requestId = incoming && CLIENT_REQUEST_ID_PATTERN.test(incoming) ? incoming : (0, node_crypto_1.randomUUID)();
    res.setHeader('X-Request-ID', requestId);
    (0, request_context_1.runWithRequestId)(requestId, next);
}
