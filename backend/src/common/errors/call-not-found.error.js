"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallNotFoundError = void 0;
const common_1 = require("@nestjs/common");
/**
 * Thrown by the engine layer when a call referenced by id can't be rejected — it is not (or no
 * longer) ringing: the id was never seen, the call already ended, or the adapter's live-call
 * cache entry expired (calls ring for roughly a minute).
 *
 * Extends NestJS `NotFoundException` so it maps to **HTTP 404** through the built-in exception
 * handler — no custom global filter required. Mirrors {@link MessageNotFoundError}.
 */
class CallNotFoundError extends common_1.NotFoundException {
    constructor(callId) {
        super(`Call ${callId} not found or no longer ringing`);
    }
}
exports.CallNotFoundError = CallNotFoundError;
