"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1781000000000_AddBaileysStoredMessages_1 = require("../1781000000000-AddBaileysStoredMessages");
describe('AddBaileysStoredMessages migration', () => {
    let ds;
    beforeEach(async () => {
        // A `sessions` table must exist for the FK; create a minimal stand-in.
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        await ds.query(`CREATE TABLE "sessions" ("id" varchar PRIMARY KEY NOT NULL)`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('creates and drops the table + indexes', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1781000000000_AddBaileysStoredMessages_1.AddBaileysStoredMessages1781000000000();
        await migration.up(runner);
        expect(await runner.hasTable('baileys_stored_messages')).toBe(true);
        await migration.down(runner);
        expect(await runner.hasTable('baileys_stored_messages')).toBe(false);
        await runner.release();
    });
    it('down() does not throw when the named indexes were never created (synchronize-bootstrapped DB)', async () => {
        const runner = ds.createQueryRunner();
        // No up(): the named indexes never existed (a synchronize-built schema uses hash-named ones).
        await expect(new _1781000000000_AddBaileysStoredMessages_1.AddBaileysStoredMessages1781000000000().down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
