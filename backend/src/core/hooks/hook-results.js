"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOOK_RESULT_ACCEPT = void 0;
exports.isMessagePayload = isMessagePayload;
exports.isWebhookBeforeResult = isWebhookBeforeResult;
const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A message:received / message:sent result the projector can store and dispatch: it keeps `id` and `chatId`. */
function isMessagePayload(data) {
    const candidate = data;
    return isPlainObject(candidate) && typeof candidate.id === 'string' && typeof candidate.chatId === 'string';
}
/** A webhook:before result whose `payload` can replace the one being sent. */
function isWebhookBeforeResult(data) {
    return isPlainObject(data) && isPlainObject(data.payload);
}
/**
 * The handler results each event can use. A chain skips a result that fails its check and keeps the
 * last usable value, so an earlier handler's rewrite (a redaction) survives a later handler returning
 * `null`: HookManager applies it between plugins, the sandbox worker between one plugin's handlers.
 */
exports.HOOK_RESULT_ACCEPT = {
    'message:received': isMessagePayload,
    'message:sent': isMessagePayload,
    'webhook:before': isWebhookBeforeResult,
};
