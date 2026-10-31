"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddMessageSessionWaIndex1779900100000 = void 0;
/**
 * Composite index on messages(sessionId, waMessageId) for the ack-driven status UPDATE.
 * Without it, every WhatsApp ack scans the entire (hot) messages table.
 *
 * Runs on the `data` connection. `IF NOT EXISTS` keeps it portable + idempotent across
 * SQLite and Postgres, and safe on a DB where `synchronize` already created the index.
 */
class AddMessageSessionWaIndex1779900100000 {
    name = 'AddMessageSessionWaIndex1779900100000';
    async up(queryRunner) {
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_sessionId_waMessageId" ON "messages" ("sessionId", "waMessageId")`);
    }
    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_sessionId_waMessageId"`);
    }
}
exports.AddMessageSessionWaIndex1779900100000 = AddMessageSessionWaIndex1779900100000;
