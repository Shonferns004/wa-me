"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddWebhookDeliveryFailureLookupIndex1786300000000 = void 0;
/**
 * Composite index on `webhook_delivery_failures (webhookId, idempotencyKey)`, backing the
 * before-insert lookup in `recordWebhookDeliveryFailure` that keeps one row per lost delivery
 * rather than one per replay attempt. The table is append-only and never pruned, so without an
 * index that lookup scans it once per terminal failure: during exactly the receiver outage the
 * table exists to record, the scan grows with the rows the outage is adding.
 *
 * Hand-authored because `synchronize` is off for the data connection on PostgreSQL (and optional on
 * SQLite). The explicit name matches the entity's @Index, so the synchronize and migration schema
 * paths converge on one index. Idempotent via IF NOT EXISTS (supported by both dialects).
 */
class AddWebhookDeliveryFailureLookupIndex1786300000000 {
    name = 'AddWebhookDeliveryFailureLookupIndex1786300000000';
    async up(queryRunner) {
        // Boot and CLI migrations run on a pool without the runtime statement_timeout (pg-boot-migrations.ts),
        // and MigrationExecutor wraps a lone pending migration in its own transaction, so lift any role- or
        // database-level default for this transaction only, exactly like AddMessageMediaPathIndex.
        if (queryRunner.dataSource.options.type === 'postgres') {
            await queryRunner.query('SET LOCAL statement_timeout = 0');
        }
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhook_delivery_failures_delivery" ON "webhook_delivery_failures" ("webhookId", "idempotencyKey")`);
    }
    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhook_delivery_failures_delivery"`);
    }
}
exports.AddWebhookDeliveryFailureLookupIndex1786300000000 = AddWebhookDeliveryFailureLookupIndex1786300000000;
