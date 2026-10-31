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
exports.isPathWithin = isPathWithin;
exports.isSafeStorageKey = isSafeStorageKey;
exports.isSafeSessionName = isSafeSessionName;
const path = __importStar(require("path"));
/**
 * Returns true if `target` resolves to a location inside (or equal to) `root`.
 *
 * Guards against path traversal: untrusted input such as tar archive entry
 * names or user-supplied file paths can contain ".." or absolute paths that
 * escape the intended directory. Both arguments are resolved to absolute paths
 * before comparison, and the trailing separator check prevents a sibling
 * directory that merely shares the root's prefix (e.g. "/data-evil" vs "/data")
 * from being treated as inside the root.
 */
function isPathWithin(root, target) {
    const resolvedRoot = path.resolve(root);
    const resolvedTarget = path.resolve(resolvedRoot, target);
    return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
}
/**
 * Returns true if `key` is a safe, contained relative storage key: a non-empty relative path with no
 * `..` traversal segment. Used to validate untrusted archive entry names / object keys at the
 * backend-agnostic `putFile`/`getFile` boundary so an S3 key (which has no host filesystem root to
 * check against `isPathWithin`) still can't escape the configured S3 key root (`S3_KEY_PREFIX`,
 * default `media/`). Ordinary keys — including plugin/JID-style ones with `:`, `@`, `.`, `-` — are preserved.
 */
function isSafeStorageKey(key) {
    if (typeof key !== 'string' || key.length === 0)
        return false;
    // Reject NUL / control chars: harmless on the local FS but a NUL would reach the raw S3 object Key.
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(key))
        return false;
    if (path.isAbsolute(key))
        return false;
    return !key.split(/[/\\]/).includes('..');
}
/**
 * Returns true if `value` is a safe engine auth-directory key: the same conservative charset the
 * CreateSessionDto enforces on a session name (letters, digits, hyphen). The key reaching the sink is
 * a `Session.id`, and the boot migration also weighs a stored name against it; either becomes a path
 * (`path.join(authDir, key)` / `session-${key}`), so a '.', '/', or '\\' could traverse outside it
 * (arbitrary write, and `rm -rf` on teardown). This is the sink-side guard for every path that reaches
 * the auth dir: normal creation validates via the DTO, but data import / seed can carry a raw value.
 */
function isSafeSessionName(value) {
    return typeof value === 'string' && /^[a-zA-Z0-9-]+$/.test(value);
}
