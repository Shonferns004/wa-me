"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.writeSecretFile = writeSecretFile;
const fs_1 = require("fs");
const logger_service_1 = require("../services/logger.service");
const logger = (0, logger_service_1.createLogger)('SecretFile');
/**
 * Write a secret file (e.g. the generated `.env`, the raw admin key) with owner-only permissions.
 *
 * `writeFileSync`'s `mode` is honored only when the file is CREATED — on an overwrite it keeps the
 * existing permissions. So we chmod to 0o600 BEFORE writing too: if the file already exists with
 * looser perms, the new secret content is never briefly world-readable during the rewrite. The
 * post-write chmod is a backstop. Both chmods are best-effort (a mount that can't chmod, or an
 * absent file on the pre-write call, shouldn't break the write — create-mode covers new files).
 */
function writeSecretFile(filePath, content) {
    try {
        (0, fs_1.chmodSync)(filePath, 0o600);
    }
    catch (error) {
        // A file not present yet is expected: create-mode below covers it. Log any other failure so a
        // world-readable secret on a chmod-unsupported FS (or an unexpected error) is not silently left
        // world-readable after a rewrite.
        if (error.code !== 'ENOENT') {
            logger.warn(`pre-write chmod 0o600 failed for ${filePath}: ${error.message}`);
        }
    }
    (0, fs_1.writeFileSync)(filePath, content, { mode: 0o600 });
    try {
        (0, fs_1.chmodSync)(filePath, 0o600);
    }
    catch (error) {
        logger.warn(`post-write chmod 0o600 failed for ${filePath}: ${error.message}`);
    }
}
