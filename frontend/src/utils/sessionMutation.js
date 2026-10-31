// Pure cache helpers that reconcile a page-local Session mutation with the shared TanStack Query
// cache. Kept dependency-light on purpose: only type-only imports of Session/QueryClient/QueryKey so
// the Node test runner (no browser `import.meta.env`) can load this module without pulling api.js.
import { replaceSession } from './sessionActions.js';
/**
 * Write the authoritative `updated` Session into the seeded `queryKey` cache and mark the whole
 * `['sessions']` prefix stale so sibling views (Dashboard stats, groups, chats, templates) refetch.
 *
 * Does NOT seed an absent cache: if nothing has populated `queryKey` yet, the page holds no observer
 * on it and seeding a one-row stub would shadow the real list query. The update is a verbatim
 * replace (see {@link replaceSession}) so server-owned fields like `phone:null` survive.
 */
export async function reconcileSessionCache(queryClient, queryKey, updated) {
    queryClient.setQueryData(queryKey, cached => (cached ? replaceSession(cached, updated) : cached));
    await invalidateSessionQueries(queryClient, queryKey);
}
/**
 * Mark the `['sessions']` prefix stale so create/delete/status transitions don't leave the shared
 * session queries (list, stats, per-session groups/chats/templates) showing pre-mutation data.
 */
export async function invalidateSessionQueries(queryClient, queryKey) {
    await queryClient.invalidateQueries({ queryKey });
}
