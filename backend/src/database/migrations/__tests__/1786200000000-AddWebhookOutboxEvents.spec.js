"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786200000000_AddWebhookOutboxEvents_1 = require("../1786200000000-AddWebhookOutboxEvents");
describe('AddWebhookOutboxEvents migration', () => {
    let ds;
    const migration = new _1786200000000_AddWebhookOutboxEvents_1.AddWebhookOutboxEvents1786200000000();
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
    });
    afterEach(async () => {
        if (ds.isInitialized)
            await ds.destroy();
    });
    it('creates the table with both indexes', async () => {
        await migration.up(ds.createQueryRunner());
        const cols = await ds.query(`PRAGMA table_info("webhook_outbox_events")`);
        expect(cols.map(c => c.name).sort()).toEqual([
            'attempts',
            'createdAt',
            'deliveryId',
            'event',
            'id',
            'idempotencyKey',
            'lastAttemptAt',
            'payload',
            'sessionId',
            'state',
            'webhookId',
        ].sort());
        const indexes = await ds.query(`PRAGMA index_list("webhook_outbox_events")`);
        expect(indexes.map(i => i.name).sort()).toContain('UQ_webhook_outbox_events_webhook_key');
        expect(indexes.map(i => i.name)).toContain('IDX_webhook_outbox_events_state_createdAt');
    });
    it('refuses a second row for the same webhook and idempotency key', async () => {
        await migration.up(ds.createQueryRunner());
        const insert = (id) => ds.query(`INSERT INTO "webhook_outbox_events" ("id","webhookId","sessionId","event","idempotencyKey","deliveryId","attempts") ` +
            `VALUES ('${id}','wh-1','sess-1','message.received','key-1','del-1',0)`);
        await insert('row-1');
        // The unique key is what makes open() idempotent: a replay must reuse the row, not add one.
        await expect(insert('row-2')).rejects.toThrow();
    });
    it('is a no-op when the table already exists, and reverts idempotently', async () => {
        await migration.up(ds.createQueryRunner());
        await expect(migration.up(ds.createQueryRunner())).resolves.toBeUndefined();
        await migration.down(ds.createQueryRunner());
        const tables = await ds.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_outbox_events'`);
        expect(tables).toHaveLength(0);
        // Reverting a database where up() took the early return must not throw on a missing index.
        await expect(migration.down(ds.createQueryRunner())).resolves.toBeUndefined();
    });
});
