"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddMessagesCreatedAtIndex1785123853000 = void 0;
/**
 * Standalone index on messages(createdAt) for the dashboard stats aggregates. Their timeline
 * predicates are createdAt-only range scans (`WHERE m.createdAt >= :since`, no sessionId), which
 * the existing composite (sessionId, createdAt) cannot serve — sessionId leads it, so without
 * ANALYZE stats SQLite full-scans the table, and PostgreSQL has no skip-scan at all. On the
 * default SQLite backend that scan runs synchronously on the event loop.
 *
 * Runs on the `data` connection. `IF NOT EXISTS` is valid on both dialects (no branch needed,
 * same as AddMessageSessionWaIndex) and keeps the migration idempotent + safe on a DB where
 * `synchronize` already created the same-named index declared on the Message entity.
 *
 * The `messages` table is the hottest data table (every inbound/outbound row), so on Postgres a
 * CREATE INDEX over a large table can run long. Boot and CLI migrations run on a pool without the
 * runtime statement_timeout (pg-boot-migrations.ts); lifting it for THIS transaction only guards
 * against a role- or database-level default cancelling the build (SET LOCAL auto-reverts at COMMIT;
 * SQLite rejects it syntactically, hence the guard), the same discipline AddWebhooksSessionIdIndex
 * and AddMessagesWaMessageIdUnique already use. `CONCURRENTLY` would avoid the SHARE lock (writes to
 * messages wait for the build, reads do not) but cannot run inside a transaction, so it is
 * deliberately NOT used here (the boot-time blocking window is acceptable for a self-hosted gateway;
 * consistency with the sibling index migrations outweighs it).
 */
class AddMessagesCreatedAtIndex1785123853000 {
    name = 'AddMessagesCreatedAtIndex1785123853000';
    async up(queryRunner) {
        if (queryRunner.dataSource.options.type === 'postgres') {
            await queryRunner.query('SET LOCAL statement_timeout = 0');
        }
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_messages_createdAt" ON "messages" ("createdAt")`);
    }
    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_messages_createdAt"`);
    }
}
exports.AddMessagesCreatedAtIndex1785123853000 = AddMessagesCreatedAtIndex1785123853000;
