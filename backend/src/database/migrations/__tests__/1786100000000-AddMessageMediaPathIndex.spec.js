"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786100000000_AddMessageMediaPathIndex_1 = require("../1786100000000-AddMessageMediaPathIndex");
describe('AddMessageMediaPathIndex migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        // Post-AddMessageMediaArchive shape of the messages table (only the columns this index needs).
        await ds.query(`CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
            `"mediaPath" varchar NULL)`);
        // Mostly-NULL mediaPath (the archive is opt-in) with a handful of archived rows.
        const rows = [];
        for (let i = 0; i < 200; i++) {
            rows.push(`('id${i}', 's1', ${i % 20 === 0 ? `'media/${i}.bin'` : 'NULL'})`);
        }
        await ds.query(`INSERT INTO "messages" ("id","sessionId","mediaPath") VALUES ${rows.join(',')}`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const indexNames = async () => {
        const rows = await ds.query(`PRAGMA index_list("messages")`);
        return rows.map(r => r.name).sort();
    };
    it('creates the partial mediaPath index', async () => {
        const runner = ds.createQueryRunner();
        await new _1786100000000_AddMessageMediaPathIndex_1.AddMessageMediaPathIndex1786100000000().up(runner);
        expect(await indexNames()).toContain('IDX_messages_mediaPath');
    });
    it('is idempotent (re-running up is a no-op) and down() drops the index', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1786100000000_AddMessageMediaPathIndex_1.AddMessageMediaPathIndex1786100000000();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        expect(await indexNames()).toContain('IDX_messages_mediaPath');
        await migration.down(runner);
        expect(await indexNames()).not.toContain('IDX_messages_mediaPath');
    });
    it('the orphan sweep mediaPath IN (...) predicate is served by the index, not a table scan', async () => {
        const runner = ds.createQueryRunner();
        await new _1786100000000_AddMessageMediaPathIndex_1.AddMessageMediaPathIndex1786100000000().up(runner);
        const plan = await ds.query(`EXPLAIN QUERY PLAN SELECT "mediaPath" FROM "messages" WHERE "mediaPath" IN ('media/0.bin', 'media/20.bin')`);
        const detail = plan.map(r => r.detail).join(' ');
        expect(detail).toContain('IDX_messages_mediaPath');
        expect(detail).not.toContain('SCAN');
    });
});
