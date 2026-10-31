"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IdempotentSend = exports.IDEMPOTENCY_KEY_HEADER_DESCRIPTION = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const send_idempotency_interceptor_1 = require("./send-idempotency.interceptor");
exports.IDEMPOTENCY_KEY_HEADER_DESCRIPTION = 'Optional. Makes the send safe to retry: within 24 hours, a retry with the same key and body replays ' +
    'the first response (marked `Idempotent-Replayed: true`) instead of sending again. 1-255 visible ' +
    'ASCII characters, unique per session. While the first request runs a retry gets 409 ' +
    '`IDEMPOTENCY_KEY_IN_PROGRESS`; after a failure that may have sent the message it gets 409 ' +
    '`IDEMPOTENCY_OUTCOME_UNKNOWN`. A 4xx or 501 refusal before the engine call frees the key. ' +
    'Errors from an engine send keep it taken whatever their HTTP status, including 409, unless the engine ' +
    'proves that nothing was sent: a transport failure before the message was handed over, a WhatsApp rate ' +
    'limit, media it could not fetch, or, on Baileys, a sticker or preview image it could not read, a ' +
    'recipient WhatsApp reports as not registered, a quoted or forwarded message it does not hold or holds ' +
    'under another chat, or a connection replaced before the message was written.';
/**
 * Marks a send route as accepting the opt-in `Idempotency-Key` header: wires the interceptor and
 * documents the header and the 422 it can add. The 409 codes share the route's existing 409 entry,
 * since the contract keeps one entry per status.
 */
const IdempotentSend = () => (0, common_1.applyDecorators)((0, common_1.UseInterceptors)(send_idempotency_interceptor_1.SendIdempotencyInterceptor), (0, swagger_1.ApiHeader)({ name: 'Idempotency-Key', required: false, description: exports.IDEMPOTENCY_KEY_HEADER_DESCRIPTION }), (0, swagger_1.ApiResponse)({
    status: 422,
    description: '`IDEMPOTENCY_KEY_REUSED`: the Idempotency-Key was already used with a different route or body.',
}));
exports.IdempotentSend = IdempotentSend;
