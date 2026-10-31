"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.bootstrapKeyFilePath = bootstrapKeyFilePath;
exports.readBootstrapKey = readBootstrapKey;
exports.writeBootstrapKey = writeBootstrapKey;
exports.removeBootstrapKey = removeBootstrapKey;
const fs_1 = require("fs");
const path_1 = require("path");
const secret_file_1 = require("../../common/utils/secret-file");
/**
 * `data/.api-key` — the bootstrap key file.
 *
 * It is an operator convenience: the first-boot banner quotes it, and backup scripts read it. It is
 * never read for seeding or for authentication, so removing it can never lock anyone out.
 *
 * The point of gathering the four file operations here is that the file is a single resource touched
 * by two concerns that otherwise share nothing — first-boot seeding writes it, and admin key
 * lifecycle unlinks it when the key it holds is revoked or deleted. As a module const reached from
 * both, it was the coupling; as a resource with one owner, each concern asks for what it needs.
 *
 * The path resolves PER CALL, and honours `BOOTSTRAP_KEY_FILE`. Both matter: it used to be a const
 * evaluated at import from `process.cwd()`, so nothing could redirect it — which is why an e2e boot
 * (whose setup redirects both databases) still wrote and unlinked the developer's real repo-root
 * `data/.api-key`.
 */
function bootstrapKeyFilePath() {
    return process.env.BOOTSTRAP_KEY_FILE || (0, path_1.join)(process.cwd(), 'data', '.api-key');
}
/** The raw key the file holds, or null when absent, unreadable or empty. Never throws. */
function readBootstrapKey(logger) {
    const file = bootstrapKeyFilePath();
    if (!(0, fs_1.existsSync)(file))
        return null;
    try {
        return (0, fs_1.readFileSync)(file, 'utf-8').trim() || null;
    }
    catch (error) {
        logger.warn(`Failed to read API key file: ${file}`, { error: String(error) });
        return null;
    }
}
/** Write the key owner-only (0600) — it is a live credential until the operator rotates it. */
function writeBootstrapKey(displayKey) {
    (0, secret_file_1.writeSecretFile)(bootstrapKeyFilePath(), displayKey);
}
/** Remove the file. Absent is success, not a failure — the caller's intent is "make it gone". */
function removeBootstrapKey(reason, logger) {
    const file = bootstrapKeyFilePath();
    try {
        (0, fs_1.unlinkSync)(file);
        logger.log(`Removed stale bootstrap API key file (${reason}): ${file}`);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return; // already gone
        logger.warn(`Failed to remove stale API key file: ${file}`, { error: String(error) });
    }
}
