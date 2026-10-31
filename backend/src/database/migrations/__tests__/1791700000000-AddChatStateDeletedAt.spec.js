"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786400000000_AddChatStates_1 = require("../1786400000000-AddChatStates");
const _1791700000000_AddChatStateDeletedAt_1 = require("../1791700000000-AddChatStateDeletedAt");
describe('AddChatStateDeletedAt migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('adds the column, keeps existing rows as null, and drops it with the rows it marked', async () => {
        const runner = ds.createQueryRunner();
        await new _1786400000000_AddChatStates_1.AddChatStates1786400000000().up(runner);
        await runner.query(`INSERT INTO "chat_states" ("sessionId", "chatId", "pinned") VALUES ('s1', '628@g.us', 1)`);
        const migration = new _1791700000000_AddChatStateDeletedAt_1.AddChatStateDeletedAt1791700000000();
        await migration.up(runner);
        await migration.up(runner); // idempotent
        expect(await runner.query(`SELECT "deletedAt", "pinned" FROM "chat_states"`)).toEqual([
            { deletedAt: null, pinned: 1 },
        ]);
        await runner.query(`INSERT INTO "chat_states" ("sessionId", "chatId", "deletedAt") VALUES ('s1', '628111@s.whatsapp.net', 1790000000000)`);
        await migration.down(runner);
        expect(await runner.hasColumn('chat_states', 'deletedAt')).toBe(false);
        expect(await runner.query(`SELECT "chatId" FROM "chat_states"`)).toEqual([{ chatId: '628@g.us' }]);
        await runner.release();
    });
    it('is a no-op without the table', async () => {
        const runner = ds.createQueryRunner();
        await expect(new _1791700000000_AddChatStateDeletedAt_1.AddChatStateDeletedAt1791700000000().up(runner)).resolves.toBeUndefined();
        await expect(new _1791700000000_AddChatStateDeletedAt_1.AddChatStateDeletedAt1791700000000().down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
