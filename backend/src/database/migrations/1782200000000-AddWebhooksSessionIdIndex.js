"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddWebhooksSessionIdIndex1782200000000 = void 0;
/**
 * Index `webhooks.sessionId`. The webhook dispatch path looks up a session's active webhooks by
 * sessionId on EVERY emitted event (WebhookService.findBySession → `find({ where: { sessionId } })`),
 * so without this index each dispatch was a full scan of the webhooks table. The FK column carried no
 * index — the entity's `@ManyToOne`/`@JoinColumn` does not create one.
 *
 * Hand-authored because `synchronize` is off for the 'data' connection. Idempotent + cross-dialect.
 */
class AddWebhooksSessionIdIndex1782200000000 {
    name = 'AddWebhooksSessionIdIndex1782200000000';
    async up(queryRunner) {
        if (queryRunner.dataSource.options.type === 'postgres') {
            // Boot and CLI migrations run on a pool without the runtime statement_timeout (pg-boot-migrations.ts);
            // this guards a CREATE INDEX over a large webhooks table against a role- or database-level default.
            // SET LOCAL auto-reverts at COMMIT; SQLite rejects it syntactically, hence the guard.
            await queryRunner.query('SET LOCAL statement_timeout = 0');
        }
        if (!(await queryRunner.hasTable('webhooks')))
            return;
        await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_webhooks_sessionId" ON "webhooks" ("sessionId")`);
    }
    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhooks_sessionId"`);
    }
}
exports.AddWebhooksSessionIdIndex1782200000000 = AddWebhooksSessionIdIndex1782200000000;
