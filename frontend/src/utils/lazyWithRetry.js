import { lazy } from 'react';
import { loadChunkWithReload } from './chunkReload';
/**
 * Drop-in replacement for React.lazy that survives a stale-chunk failure after a redeploy: a failed
 * dynamic import() triggers a one-time full reload (fresh index.html + chunks) instead of bubbling to
 * the top-level ErrorBoundary and blanking the whole dashboard. See chunkReload.js for the guard logic.
 */
export function lazyWithRetry(factory) {
    return lazy(() => loadChunkWithReload(factory, {
        reload: () => window.location.reload(),
        storage: window.sessionStorage,
    }));
}
