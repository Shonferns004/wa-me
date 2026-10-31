"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DropRedundantMessagesSessionIdIndex1781600000000 = void 0;
/**
 * Drop the redundant single-column index on messages(sessionId). Every lookup it can serve is
 * already covered by a composite index that leads with sessionId — IDX_399833…(sessionId,
 * createdAt) and the unique (sessionId, waMessageId) — so the standalone index adds only
 * write-time maintenance on a hot, high-volume table.
 *
 * Runs on the `data` connection. `IF EXISTS` keeps it idempotent and portable across SQLite and
 * Postgres (and safe on a synchronize-built schema). The name is the one TypeORM generated for the
 * `@Index()` on the sessionId column — hardcoded in the baseline migration (1770108659848).
 */
class DropRedundantMessagesSessionIdIndex1781600000000 {
    name = 'DropRedundantMessagesSessionIdIndex1781600000000';
    async up(queryRunner) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_066163c46cda7e8187f96bc87a"`);
    }
    async down(queryRunner) {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_066163c46cda7e8187f96bc87a" ON "messages" ("sessionId")`);
    }
}
exports.DropRedundantMessagesSessionIdIndex1781600000000 = DropRedundantMessagesSessionIdIndex1781600000000;
