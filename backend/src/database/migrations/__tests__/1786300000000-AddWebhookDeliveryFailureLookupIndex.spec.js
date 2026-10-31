"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786300000000_AddWebhookDeliveryFailureLookupIndex_1 = require("../1786300000000-AddWebhookDeliveryFailureLookupIndex");
describe('AddWebhookDeliveryFailureLookupIndex migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        // Post-AddWebhookDeliveryFailures shape, reduced to the columns this index covers.
        await ds.query(`CREATE TABLE "webhook_delivery_failures" ("id" varchar PRIMARY KEY NOT NULL, ` +
            `"webhookId" varchar NOT NULL, "sessionId" varchar NOT NULL, "idempotencyKey" varchar NULL)`);
        // Enough rows that the planner has a reason to prefer the index over a scan.
        const rows = [];
        for (let i = 0; i < 200; i++) {
            rows.push(`('id${i}', 'wh-${i % 5}', 's1', 'key-${i}')`);
        }
        await ds.query(`INSERT INTO "webhook_delivery_failures" ("id","webhookId","sessionId","idempotencyKey") VALUES ${rows.join(',')}`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const indexNames = async () => {
        const rows = await ds.query(`PRAGMA index_list("webhook_delivery_failures")`);
        return rows.map(r => r.name).sort();
    };
    it('creates the delivery lookup index', async () => {
        const runner = ds.createQueryRunner();
        await new _1786300000000_AddWebhookDeliveryFailureLookupIndex_1.AddWebhookDeliveryFailureLookupIndex1786300000000().up(runner);
        expect(await indexNames()).toContain('IDX_webhook_delivery_failures_delivery');
    });
    it('is idempotent (re-running up is a no-op) and down() drops the index', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1786300000000_AddWebhookDeliveryFailureLookupIndex_1.AddWebhookDeliveryFailureLookupIndex1786300000000();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        expect(await indexNames()).toContain('IDX_webhook_delivery_failures_delivery');
        await migration.down(runner);
        expect(await indexNames()).not.toContain('IDX_webhook_delivery_failures_delivery');
    });
    it('the duplicate-record lookup is served by the index, not a table scan', async () => {
        const runner = ds.createQueryRunner();
        const countQuery = `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM "webhook_delivery_failures" ` +
            `WHERE "webhookId" = 'wh-1' AND "idempotencyKey" = 'key-6'`;
        // Baseline first: without the index this really is a scan, so the assertion below is measuring
        // the index rather than a plan that was already index-served for some other reason.
        const before = (await ds.query(countQuery)).map(r => r.detail).join(' ');
        expect(before).toContain('SCAN');
        await new _1786300000000_AddWebhookDeliveryFailureLookupIndex_1.AddWebhookDeliveryFailureLookupIndex1786300000000().up(runner);
        const after = (await ds.query(countQuery)).map(r => r.detail).join(' ');
        expect(after).toContain('IDX_webhook_delivery_failures_delivery');
        expect(after).not.toContain('SCAN');
    });
});
