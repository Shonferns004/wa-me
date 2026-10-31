"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LIST_LIMIT = void 0;
exports.resolveListWindow = resolveListWindow;
exports.paginate = paginate;
/** Default and maximum number of items returned by a paginated list endpoint. */
exports.DEFAULT_LIST_LIMIT = 1000;
/** Normalize a query/list window for both in-memory slicing and database skip/take. */
function resolveListWindow(limit, offset) {
    // Capped at the largest safe integer: a driver refuses an OFFSET of 2^63 or more, and any offset that
    // large is past the last row anyway.
    const normalizedOffset = typeof offset === 'number' && Number.isFinite(offset)
        ? Math.min(Math.max(Math.trunc(offset), 0), Number.MAX_SAFE_INTEGER)
        : 0;
    const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit)
        ? Math.min(Math.max(Math.trunc(limit), 1), exports.DEFAULT_LIST_LIMIT)
        : exports.DEFAULT_LIST_LIMIT;
    return { limit: normalizedLimit, offset: normalizedOffset };
}
/**
 * Bound an in-memory list for an HTTP response.
 *
 * Engine-backed list endpoints (contacts, groups, chats) can return the operator's entire address
 * book / chat set; serializing tens of thousands of items into one JSON body is a heap/GC hazard.
 * This clamps the response window:
 *   - an omitted or non-finite `limit` falls back to {@link DEFAULT_LIST_LIMIT} (the default cap),
 *   - an explicit `limit` is clamped to `[1, DEFAULT_LIST_LIMIT]`,
 *   - `offset` (non-finite -> 0) pages beyond the first window.
 *
 * Pagination is applied at the HTTP/service boundary only — the engine still returns the full set
 * to in-process callers (e.g. plugins), so this never narrows what those consumers see.
 */
function paginate(items, limit, offset) {
    const { limit: lim, offset: off } = resolveListWindow(limit, offset);
    return items.slice(off, off + lim);
}
