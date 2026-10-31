"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScrubRevokedMessageContent1786900000000 = void 0;
/**
 * Clear what earlier releases kept on a revoked message's row.
 *
 * A revoke used to empty only `body`, leaving the inline media, quote and reactions in `metadata` and
 * the archived-media pointer in `mediaPath`/`mediaMimetype`, so the list and media endpoints kept
 * serving content the sender deleted. New revokes clear all of it; this brings the rows revoked
 * before that in line. The archived files those pointers referenced become unreferenced, and the
 * chat-media orphan sweep reaps them after its grace window.
 *
 * Idempotent, and `down` is a no-op: the cleared content is not recoverable. `scrub` is shared with
 * import-data, which restores rows from archives taken before this migration ran.
 */
class ScrubRevokedMessageContent1786900000000 {
    name = 'ScrubRevokedMessageContent1786900000000';
    static async scrub(queryRunner) {
        if (!(await queryRunner.hasTable('messages')))
            return;
        await queryRunner.query(`UPDATE "messages" SET "body" = '', "metadata" = NULL, "mediaPath" = NULL, "mediaMimetype" = NULL WHERE "type" = 'revoked'`);
    }
    async up(queryRunner) {
        await ScrubRevokedMessageContent1786900000000.scrub(queryRunner);
    }
    async down() {
        // Nothing to restore.
    }
}
exports.ScrubRevokedMessageContent1786900000000 = ScrubRevokedMessageContent1786900000000;
