"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1781300000000_AddMessagesWaMessageIdUnique_1 = require("../1781300000000-AddMessagesWaMessageIdUnique");
describe('AddMessagesWaMessageIdUnique migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        await ds.query(`CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
            `"waMessageId" varchar, "chatId" varchar NOT NULL, "from" varchar NOT NULL, "to" varchar NOT NULL, ` +
            `"body" text, "type" varchar NOT NULL DEFAULT ('text'), "direction" varchar NOT NULL DEFAULT ('outgoing'), ` +
            `"timestamp" bigint, "metadata" text, "status" varchar NOT NULL DEFAULT ('sent'), ` +
            `"createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await ds.query(`CREATE INDEX "IDX_messages_sessionId_waMessageId" ON "messages" ("sessionId", "waMessageId")`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const insert = (id, sessionId, waMessageId, createdAt) => ds.query(`INSERT INTO "messages" ("id","sessionId","waMessageId","chatId","from","to","body","type","direction","timestamp","status","createdAt") ` +
        `VALUES (?,?,?,'c@c.us','c@c.us','me@c.us','hi','text','incoming',1,'sent',?)`, [id, sessionId, waMessageId, createdAt]);
    it('deletes duplicate (sessionId, waMessageId) rows keeping the earliest, then enforces uniqueness', async () => {
        // The earlier row has the id that sorts last and is inserted second, so only createdAt can pick it.
        await insert('id-a-late', 'sess-1', 'wa-1', '2026-02-01T00:00:00.000Z');
        await insert('id-z-early', 'sess-1', 'wa-1', '2026-01-01T00:00:00.000Z');
        await insert('id-other', 'sess-1', 'wa-2', '2026-01-01T00:00:00.000Z');
        const runner = ds.createQueryRunner();
        await new _1781300000000_AddMessagesWaMessageIdUnique_1.AddMessagesWaMessageIdUnique1781300000000().up(runner);
        const rows = (await runner.query(`SELECT id FROM "messages" ORDER BY id`));
        expect(rows.map(r => r.id).sort()).toEqual(['id-other', 'id-z-early']); // later dup deleted, earliest kept
        await expect(insert('id-new', 'sess-1', 'wa-1', '2026-03-01T00:00:00.000Z')).rejects.toThrow();
        await runner.release();
    });
    it('keeps multiple NULL-waMessageId rows (NULLs are distinct under the unique index)', async () => {
        await insert('p1', 'sess-1', null, '2026-01-01T00:00:00.000Z');
        await insert('p2', 'sess-1', null, '2026-01-01T00:00:01.000Z');
        const runner = ds.createQueryRunner();
        await new _1781300000000_AddMessagesWaMessageIdUnique_1.AddMessagesWaMessageIdUnique1781300000000().up(runner);
        const rows = (await runner.query(`SELECT id FROM "messages" WHERE "waMessageId" IS NULL`));
        expect(rows).toHaveLength(2);
        await runner.release();
    });
    it('is idempotent and a no-op when the table is absent', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1781300000000_AddMessagesWaMessageIdUnique_1.AddMessagesWaMessageIdUnique1781300000000();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined(); // re-run: index already exists
        await ds.query(`DROP TABLE "messages"`);
        await expect(migration.up(runner)).resolves.toBeUndefined(); // absent table
        await runner.release();
    });
    it('clears statement_timeout for the migration transaction on Postgres', async () => {
        // The migration pool carries no runtime statement_timeout, but a role- or database-level default
        // could still abort this DELETE / CREATE UNIQUE INDEX over the hot messages table mid-flight.
        const queries = [];
        const pgRunner = {
            dataSource: { options: { type: 'postgres' } },
            hasTable: jest.fn().mockResolvedValue(true),
            query: jest.fn((sql) => {
                queries.push(sql);
                return Promise.resolve([]);
            }),
        };
        await new _1781300000000_AddMessagesWaMessageIdUnique_1.AddMessagesWaMessageIdUnique1781300000000().up(pgRunner);
        expect(queries[0]).toBe('SET LOCAL statement_timeout = 0');
    });
});
