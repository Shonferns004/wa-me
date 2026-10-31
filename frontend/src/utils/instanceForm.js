import { captionLength } from './bulkMedia.js';
export const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export function isValidInstanceId(id) {
    return INSTANCE_ID_PATTERN.test(id);
}
/** Blank means auto-generate; otherwise use the server DTO character count and its 16 to 512 bounds. */
export function isValidInstanceSecret(raw) {
    const secret = raw.trim();
    const length = captionLength(secret);
    return secret === '' || (length >= 16 && length <= 512);
}
/** Blank → no config (undefined). Otherwise must parse to a plain JSON object. */
export function parseInstanceConfig(raw) {
    if (raw.trim() === '')
        return { ok: true, value: undefined };
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
            return { ok: false };
        return { ok: true, value: parsed };
    }
    catch {
        return { ok: false };
    }
}
/**
 * The edit form's session scope. Blank means all sessions: omitted when the instance already serves
 * all sessions, and null when it is scoped, because PATCH reads an omitted field as unchanged.
 */
export function parseEditScope(current, raw) {
    const value = raw.trim();
    if (value)
        return value;
    return current ? null : undefined;
}
