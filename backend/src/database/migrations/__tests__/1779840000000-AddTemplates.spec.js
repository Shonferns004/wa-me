"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1779840000000_AddTemplates_1 = require("../1779840000000-AddTemplates");
describe('AddTemplates migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        // up() declares a CASCADE FK to sessions; create a minimal stand-in (mirrors the sibling specs).
        await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL)`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const tableExists = async () => {
        const rows = await ds.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='templates'`);
        return rows.length === 1;
    };
    it('creates the table and its index, is idempotent, and down() reverses it', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1779840000000_AddTemplates_1.AddTemplates1779840000000();
        await migration.up(runner);
        expect(await tableExists()).toBe(true);
        const index = (await runner.query(`SELECT name FROM sqlite_master WHERE type='index' AND name='IDX_templates_sessionId'`));
        expect(index).toHaveLength(1);
        await expect(migration.up(runner)).resolves.toBeUndefined(); // re-run: hasTable early-return
        await migration.down(runner);
        expect(await tableExists()).toBe(false);
        await runner.release();
    });
    it('down() does not throw when the migration-only index was never created (synchronize-bootstrapped DB)', async () => {
        // Simulate a schema built by synchronize: the templates table exists with the ENTITY index, but the
        // migration-only IDX_templates_sessionId was never created and up() was never run.
        await ds.query(`CREATE TABLE "templates" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
            `"name" varchar(100) NOT NULL, "body" text NOT NULL, "header" text, "footer" text, ` +
            `"createdAt" datetime NOT NULL, "updatedAt" datetime NOT NULL)`);
        await ds.query(`CREATE UNIQUE INDEX "IDX_templates_session_name" ON "templates" ("sessionId", "name")`);
        const runner = ds.createQueryRunner();
        await expect(new _1779840000000_AddTemplates_1.AddTemplates1779840000000().down(runner)).resolves.toBeUndefined();
        expect(await tableExists()).toBe(false);
        await runner.release();
    });
});
