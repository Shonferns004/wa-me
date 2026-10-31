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
exports.wwjsAuthDir = wwjsAuthDir;
exports.baileysAuthDir = baileysAuthDir;
exports.readAuthDirEntries = readAuthDirEntries;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/**
 * The on-disk engine auth directories, keyed by the session's UUID (`Session.id`).
 *
 * They used to be keyed by `Session.name`. Names are unique case-sensitively, so `my-bot` and
 * `My-Bot` are two rows, but on a case-insensitive filesystem (macOS APFS, Windows, and Docker
 * Desktop bind mounts of a host directory on either) they resolved to ONE directory: the second
 * session loaded the first one's WhatsApp login, and deleting either wiped both (#1597). A UUID has
 * no case variants, so the key is unambiguous on every filesystem.
 *
 * These two builders are the single source of truth for the paths: the adapters build them to write
 * credentials, EngineFactory to pre-create and purge them, and the boot migration to rename the
 * legacy name-keyed directories onto them.
 */
/** whatsapp-web.js LocalAuth profile dir: `sessionDataPath` resolved, then `session-<id>` appended. */
function wwjsAuthDir(sessionDataPath, sessionId) {
    return path.join(path.resolve(sessionDataPath), `session-${sessionId}`);
}
/** Baileys multi-file auth dir: `authDir/<id>`, with `authDir` left unresolved, as the adapter does. */
function baileysAuthDir(authDir, sessionId) {
    return path.join(authDir, sessionId);
}
/**
 * The auth-directory entries directly under `base`, by exact name. Throws whatever `readdir` throws,
 * so a caller can tell a missing base directory (ENOENT) from one it may not read.
 *
 * Every caller that acts on a legacy name-keyed directory matches it against this listing instead of
 * asking `fs.existsSync`: on a case-insensitive filesystem `existsSync` answers yes for
 * `session-My-Bot` when only `session-my-bot` is stored, so the rename or the rm would hit another
 * session's credentials, which is the very bug the id key exists to fix (#1597).
 *
 * A symlink counts as an entry: relocating a large profile onto another volume with one worked while
 * the paths were only ever opened, so renaming or removing the link is what keeps those installs
 * behaving as they did.
 */
function readAuthDirEntries(base) {
    return new Set(fs
        .readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
        .map(entry => entry.name));
}
