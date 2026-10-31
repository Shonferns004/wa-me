"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineTransportError = void 0;
const common_1 = require("@nestjs/common");
/**
 * Thrown by an engine adapter when an operation fails at the TRANSPORT rather than because the
 * requested resource does not exist: the Chromium page/CDP connection is gone (whatsapp-web.js),
 * the WebSocket dropped (Baileys), or the socket is up but WhatsApp left our query unanswered
 * past a deadline we own. A broad catch that folds this into a not-found result makes a crashed
 * session look like a missing group/channel (404) or a refused invite (400), which is how
 * operators end up debugging the wrong layer.
 *
 * Extends NestJS `ServiceUnavailableException` so it maps to **HTTP 503** through the built-in
 * exception handler — no custom global filter required. Mirrors {@link EngineNotReadyError} (409).
 */
class EngineTransportError extends common_1.ServiceUnavailableException {
    constructor(detail) {
        super(detail);
    }
}
exports.EngineTransportError = EngineTransportError;
