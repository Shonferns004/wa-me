"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineNotSentError = void 0;
exports.markNothingSent = markNothingSent;
exports.provesNothingSent = provesNothingSent;
const engine_transport_error_1 = require("./engine-transport.error");
/**
 * An {@link EngineTransportError} (HTTP 503) for a send that failed in transport before the message was
 * handed to WhatsApp, such as a lookup the send depends on timing out. Like a throttled request, nothing
 * went out, while a plain EngineTransportError leaves the outcome unknown, so a paced send can give its
 * admission back.
 */
class EngineNotSentError extends engine_transport_error_1.EngineTransportError {
}
exports.EngineNotSentError = EngineNotSentError;
/** Errors raised before anything was handed to WhatsApp, whatever their HTTP status. */
const raisedBeforeSend = new WeakSet();
/**
 * Record that an error was raised before anything was handed to WhatsApp, keeping its own status and body:
 * media that could not be fetched or read is the caller's 400 or 413, yet proves what EngineNotSentError
 * proves, so a keyed send frees its `Idempotency-Key` for it the same way.
 */
function markNothingSent(error) {
    if (error !== null && typeof error === 'object')
        raisedBeforeSend.add(error);
    return error;
}
/** Whether an error proves nothing was handed to WhatsApp: an EngineNotSentError, or one markNothingSent recorded. */
function provesNothingSent(error) {
    return (error instanceof EngineNotSentError || (error !== null && typeof error === 'object' && raisedBeforeSend.has(error)));
}
