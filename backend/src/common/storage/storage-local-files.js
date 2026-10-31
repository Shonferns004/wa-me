"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.StorageWalkRefusedError = void 0;
exports.iterateLocalFiles = iterateLocalFiles;
exports.getLocalFile = getLocalFile;
exports.openLocalFile = openLocalFile;
exports.putLocalFile = putLocalFile;
exports.deleteLocalFile = deleteLocalFile;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const path_safety_1 = require("../utils/path-safety");
/** Max directory depth a local traversal descends. Prevents a pathological tree from running unbounded. */
const LOCAL_TRAVERSAL_MAX_DEPTH = 20;
/**
 * The walk refuses to go on because it cannot enumerate part of the store completely: a directory the app cannot
 * read, a symbolic link it does not follow, a directory nested past the depth limit. A count or an export that went
 * on would leave files out without a word. The message reaches the API caller, so it names the path relative to
 * the storage root and the cause, never the host path; the error the host raised, with its path, is on `cause`.
 */
class StorageWalkRefusedError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'StorageWalkRefusedError';
    }
}
exports.StorageWalkRefusedError = StorageWalkRefusedError;
/** Created by mkfs at the top of a volume; root-owned and mode 0700, so an unprivileged app cannot read it. */
const LOST_AND_FOUND = 'lost+found';
/**
 * Local enumeration as a stream. Async + iterative (a work queue, not recursion) so a deep/wide
 * media tree can't block the event loop or stack-overflow; still bounded by the max directory
 * depth. An incomplete traversal fails instead of hiding files, unless the caller opts out.
 */
async function* iterateLocalFiles(localPath, prefix = '', options = {}) {
    /** A path the walk cannot enumerate: fail the walk, or skip it and say so when the caller allows it. */
    const unreadable = (entry, error) => {
        if (!options.skipUnreadable)
            throw error;
        // The log gets the host's own account of the failure, with its path.
        const detail = error instanceof StorageWalkRefusedError && error.cause instanceof Error ? error.cause : error;
        options.logger?.warn(`Skipping a storage path that cannot be enumerated: ${JSON.stringify(entry)} (${detail.message})`);
    };
    // Iterative BFS: a queue of [relativeDir, depth] avoids unbounded call-stack growth. A prefix
    // ending in '/' names a subtree, so start the walk there instead of filtering afterwards.
    const root = prefix.endsWith('/') ? prefix.slice(0, -1) : '';
    if (root && !(0, path_safety_1.isPathWithin)(localPath, root))
        return;
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
        const { dir, depth } = queue.shift();
        if (depth >= LOCAL_TRAVERSAL_MAX_DEPTH) {
            unreadable(dir, new StorageWalkRefusedError(`Storage directory exceeds the maximum traversal depth: ${dir}`));
            continue;
        }
        const fullPath = path.join(localPath, dir);
        let entries;
        try {
            entries = await fs.promises.readdir(fullPath, { withFileTypes: true });
        }
        catch (error) {
            const code = error.code;
            // A directory removed during enumeration has no files left to export.
            if (code === 'ENOENT')
                continue;
            const permission = code === 'EACCES' || code === 'EPERM';
            if (dir === LOST_AND_FOUND && permission) {
                options.logger?.log(`Skipping the unreadable ${LOST_AND_FOUND} directory at the storage root`);
                continue;
            }
            // Only a permission failure is one the operator can fix, so only it is refused with a cause the caller can
            // read. Any other failure (an I/O error, say) goes on as it came, and is an internal error.
            unreadable(dir, permission
                ? new StorageWalkRefusedError(`Storage directory cannot be read: ${dir || '.'} (${code})`, { cause: error })
                : error);
            continue;
        }
        for (const entry of entries) {
            // Keys use "/" on every host: the archive carries them verbatim, and a key with a backslash would
            // restore as a different file on another host.
            const relativePath = dir ? path.posix.join(dir, entry.name) : entry.name;
            if (entry.isDirectory()) {
                queue.push({ dir: relativePath, depth: depth + 1 });
            }
            else if (entry.isFile()) {
                yield relativePath;
            }
            else if (entry.isSymbolicLink()) {
                // Not followed: a link can loop or leave the store, and what it points at would be missing from the
                // listing. getFile and a walk that starts below the link still reach it.
                unreadable(relativePath, new StorageWalkRefusedError(`Storage path is a symbolic link and is not followed: ${relativePath}`));
            }
        }
    }
}
function getLocalFile(localPath, filePath) {
    if (!(0, path_safety_1.isPathWithin)(localPath, filePath)) {
        throw new Error(`Refusing to read outside storage root: ${filePath}`);
    }
    const fullPath = path.join(localPath, filePath);
    // Async read so a media read yields the event loop instead of blocking it for the whole file.
    return fs.promises.readFile(fullPath);
}
/**
 * Open a local file for a streamed read. The handle is opened and stat'ed up front, so a missing or
 * unreadable file rejects here, before the caller commits to it, and the size is the one the open
 * handle sees. The stream closes the handle when it ends or is destroyed.
 */
async function openLocalFile(localPath, filePath) {
    if (!(0, path_safety_1.isPathWithin)(localPath, filePath)) {
        throw new Error(`Refusing to read outside storage root: ${filePath}`);
    }
    const handle = await fs.promises.open(path.join(localPath, filePath), 'r');
    try {
        const { size } = await handle.stat();
        return { stream: handle.createReadStream(), size };
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
async function putLocalFile(localPath, filePath, data) {
    if (!(0, path_safety_1.isPathWithin)(localPath, filePath)) {
        throw new Error(`Refusing to write outside storage root: ${filePath}`);
    }
    const fullPath = path.join(localPath, filePath);
    // Async, non-blocking: a synchronous write here stalls the event loop during an import.
    // mkdir recursive is idempotent, so it doubles as the existsSync check.
    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, data);
}
async function deleteLocalFile(localPath, filePath) {
    if (!(0, path_safety_1.isPathWithin)(localPath, filePath)) {
        throw new Error(`Refusing to delete outside storage root: ${filePath}`);
    }
    const fullPath = path.join(localPath, filePath);
    try {
        await fs.promises.unlink(fullPath);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
}
