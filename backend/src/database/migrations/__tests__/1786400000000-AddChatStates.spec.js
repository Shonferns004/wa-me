"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786400000000_AddChatStates_1 = require("../1786400000000-AddChatStates");
describe('AddChatStates migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('creates and drops the table', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1786400000000_AddChatStates_1.AddChatStates1786400000000();
        await migration.up(runner);
        expect(await runner.hasTable('chat_states')).toBe(true);
        await migration.down(runner);
        expect(await runner.hasTable('chat_states')).toBe(false);
        await runner.release();
    });
    it('up() is idempotent when the table already exists (hasTable guard)', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1786400000000_AddChatStates_1.AddChatStates1786400000000();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.not.toThrow();
        expect(await runner.hasTable('chat_states')).toBe(true);
        await runner.release();
    });
    it('stores a row keyed by (sessionId, chatId)', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1786400000000_AddChatStates_1.AddChatStates1786400000000();
        await migration.up(runner);
        await runner.query(`INSERT INTO "chat_states" ("sessionId", "chatId", "muteEndTime", "archived", "pinned") VALUES ('s1', '628@g.us', 1788000000000, 0, 1)`);
        const rows = (await runner.query(`SELECT "muteEndTime", "pinned" FROM "chat_states" WHERE "sessionId" = 's1'`));
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].muteEndTime)).toBe(1788000000000);
        await runner.release();
    });
});
