"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineThrottledError = void 0;
const engine_transport_error_1 = require("./engine-transport.error");
/**
 * An {@link EngineTransportError} (HTTP 503) for a request WhatsApp throttled (its code 429) rather than
 * left unanswered. A throttled request was turned away before it ran, so nothing was applied and nobody
 * was contacted, while a plain EngineTransportError leaves the outcome unknown. Callers that charge a
 * budget up front can tell the two apart and give a throttled request's reservation back.
 */
class EngineThrottledError extends engine_transport_error_1.EngineTransportError {
}
exports.EngineThrottledError = EngineThrottledError;
