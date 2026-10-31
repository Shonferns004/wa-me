"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786200000000_AddWebhookOutboxEvents_1 = require("../1786200000000-AddWebhookOutboxEvents");
const _1791200000000_AddWebhookOutboxSessionIndex_1 = require("../1791200000000-AddWebhookOutboxSessionIndex");
const INDEX = 'IDX_webhook_outbox_events_sessionId';
describe('AddWebhookOutboxSessionIndex migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        const runner = ds.createQueryRunner();
        await new _1786200000000_AddWebhookOutboxEvents_1.AddWebhookOutboxEvents1786200000000().up(runner);
        await runner.release();
        // Many sessions' rows, as a long retention window of a busy event leaves behind.
        const rows = [];
        for (let i = 0; i < 300; i++) {
            rows.push(`('id${i}', 'wh${i % 7}', 'sess-${i % 3}', 'message.receipt', 'key${i}', 'd${i}', 0)`);
        }
        await ds.query(`INSERT INTO "webhook_outbox_events" ("id","webhookId","sessionId","event","idempotencyKey","deliveryId","attempts") VALUES ${rows.join(',')}`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const indexNames = async () => {
        const rows = await ds.query(`PRAGMA index_list("webhook_outbox_events")`);
        return rows.map(r => r.name).sort();
    };
    it('adds the session index next to the existing two', async () => {
        const runner = ds.createQueryRunner();
        await new _1791200000000_AddWebhookOutboxSessionIndex_1.AddWebhookOutboxSessionIndex1791200000000().up(runner);
        expect(await indexNames()).toEqual(expect.arrayContaining([
            INDEX,
            'IDX_webhook_outbox_events_state_createdAt',
            'UQ_webhook_outbox_events_webhook_key',
        ]));
    });
    it('is idempotent (re-running up is a no-op) and down() drops only its own index', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1791200000000_AddWebhookOutboxSessionIndex_1.AddWebhookOutboxSessionIndex1791200000000();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        expect(await indexNames()).toContain(INDEX);
        await migration.down(runner);
        const after = await indexNames();
        expect(after).not.toContain(INDEX);
        expect(after).toContain('IDX_webhook_outbox_events_state_createdAt');
    });
    it('serves the per-session lookup of a session delete', async () => {
        const lookup = `EXPLAIN QUERY PLAN SELECT "id" FROM "webhook_outbox_events" WHERE "sessionId" = 'sess-1' LIMIT 500`;
        // Baseline: with no index on sessionId the lookup reads the whole table.
        const before = (await ds.query(lookup)).map(r => r.detail).join(' ');
        expect(before).not.toContain(INDEX);
        await new _1791200000000_AddWebhookOutboxSessionIndex_1.AddWebhookOutboxSessionIndex1791200000000().up(ds.createQueryRunner());
        const after = (await ds.query(lookup)).map(r => r.detail).join(' ');
        expect(after).toContain(INDEX);
    });
});
