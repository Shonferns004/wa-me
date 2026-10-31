"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineNotReadyError = void 0;
const common_1 = require("@nestjs/common");
/**
 * Thrown by the engine layer when an operation requires a connected, READY
 * WhatsApp client but the session is not in that state — e.g. it was just
 * disconnected from the phone, is still initializing, or is reconnecting.
 *
 * Extends NestJS `ConflictException` so it maps to **HTTP 409** through NestJS's
 * built-in exception handler — i.e. it does NOT depend on a custom global filter
 * being registered. API callers (and the dashboard) get a clear, retryable
 * "session not connected" error instead of a generic 500 Internal Server Error.
 */
class EngineNotReadyError extends common_1.ConflictException {
    constructor(message = 'Session is not connected. The WhatsApp client is not ready.') {
        super(message);
    }
}
exports.EngineNotReadyError = EngineNotReadyError;
