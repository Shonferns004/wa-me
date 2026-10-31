import { mergeOrAppend } from './chatMessages.js';
/**
 * Optimistic-send placeholders (ChatComposer's `temp_${Date.now()}` id) never reached the DB. One
 * that failed stays in `page.db` with `status: 'failed'` and nothing ever removes it, so counting
 * it as a fetched row would offset every later page by one and strand a real row unreachable.
 * Matched on the id prefix specifically — not on a missing `waMessageId`, which is nullable on a
 * genuine DB row too.
 */
const isOptimisticPlaceholder = (m) => m.id.startsWith('temp_');
/** DB rows fetched across every page so far — the offset the next page asks for. */
export function dbRowsFetched(pages) {
    return pages.reduce((count, page) => count + page.db.filter(m => !isOptimisticPlaceholder(m)).length, 0);
}
/**
 * Offset of the next older page, or undefined once the oldest page came back short.
 *
 * The offset counts DB rows including live arrivals — each server insert shifts the window by one,
 * and rendered length would count engine-history items the DB never returned. Termination cannot
 * use that same growing count against the chat's frozen row total, which meets it a few live
 * messages early and strands the oldest rows.
 */
export function nextMessagePageParam(pages, pageSize) {
    const oldest = pages[pages.length - 1];
    if (oldest === undefined || oldest.fetched < pageSize)
        return undefined;
    return dbRowsFetched(pages);
}
const messageKey = (m) => m.waMessageId ?? m.id;
/**
 * Insert or merge one message, optionally dropping an optimistic placeholder by id.
 *
 * Which page receives it matters: a plain append (finding no match) would add a copy to every page
 * run this way, so the message is merged into the page that already holds it, landing on the newest
 * page only when no page does. mergeOrAppend's payload cap applies per page here, since page.db is
 * ascending — this is what bounds page 0's raw base64 as live media arrives; the final cap in
 * `select` bounds the rendered set, which is a different array by then and needs its own.
 */
export function upsertIntoPages(pages, incoming, dropId) {
    const trimmed = dropId
        ? pages.map(page => ({
            ...page,
            db: page.db.filter(m => m.id !== dropId),
            history: page.history.filter(m => m.id !== dropId),
        }))
        : pages;
    const target = trimmed.findIndex(page => page.db.some(m => messageKey(m) === messageKey(incoming)));
    const index = target === -1 ? 0 : target;
    return trimmed.map((page, i) => (i === index ? { ...page, db: mergeOrAppend(page.db, incoming) } : page));
}
