"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweepOrphanedFiles = sweepOrphanedFiles;
/**
 * One reconciliation pass over a storage prefix: delete files no row references, but only after the
 * sweep has seen them unreferenced for at least the grace window. Shared by the stores that keep
 * media blobs alongside DB rows (status store, chat-media archive) and share one bucket — each
 * caller scopes itself to its own prefix and never touches the other's files.
 *
 * First-seen is tracked in the caller-owned `firstSeenAt` map (epoch ms per unreferenced key), so a
 * restart simply restarts the grace clock (fails safe) and a file mid-write is never reaped. The map
 * is pruned to the keys still orphaned at the end of the pass, so it cannot grow unbounded.
 *
 * Files are streamed from iterateFiles() under the sweep's prefix, so an orphan is found however
 * large the store is.
 *
 * Returns the number of files deleted. The summary log stays with the caller (each sweep reports in
 * its own wording); a failed delete is reported through `onDeleteFailed` and retried on a later pass.
 */
async function sweepOrphanedFiles(options) {
    const { storage, prefix, graceMs, now, firstSeenAt, referencedAmong, onDeleteFailed } = options;
    let removed = 0;
    // Keys still unreferenced at the end of THIS pass; drives the bookkeeping prune below. Bounded by
    // the orphan count (normally ~0), not by the size of the store.
    const stillOrphaned = new Set();
    let chunk = [];
    const flush = async () => {
        if (chunk.length === 0)
            return;
        const referenced = await referencedAmong(chunk);
        for (const file of chunk) {
            if (referenced.has(file)) {
                firstSeenAt.delete(file);
                continue;
            }
            stillOrphaned.add(file);
            const firstSeen = firstSeenAt.get(file) ?? now;
            firstSeenAt.set(file, firstSeen);
            if (now - firstSeen < graceMs)
                continue;
            try {
                await storage.deleteFile(file);
                firstSeenAt.delete(file);
                stillOrphaned.delete(file);
                removed += 1;
            }
            catch (err) {
                onDeleteFailed(file, err);
            }
        }
        chunk = [];
    };
    // A directory the walk cannot read is left alone: this pass deletes only files it was shown.
    for await (const file of storage.iterateFiles(prefix, { skipUnreadable: true })) {
        if (!file.startsWith(prefix))
            continue;
        chunk.push(file);
        if (options.chunkSize !== undefined && chunk.length >= options.chunkSize)
            await flush();
    }
    await flush();
    // Drop bookkeeping for anything not still orphaned this pass — the file is gone, or a row now
    // references it. Keyed off the orphan set rather than a full listing so this stays bounded too.
    for (const key of [...firstSeenAt.keys()]) {
        if (!stillOrphaned.has(key))
            firstSeenAt.delete(key);
    }
    return removed;
}
