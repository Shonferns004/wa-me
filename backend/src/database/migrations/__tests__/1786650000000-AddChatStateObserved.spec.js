"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786400000000_AddChatStates_1 = require("../1786400000000-AddChatStates");
const _1786650000000_AddChatStateObserved_1 = require("../1786650000000-AddChatStateObserved");
describe('AddChatStateObserved migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('adds the column, keeps existing rows as null, and drops it again', async () => {
        const runner = ds.createQueryRunner();
        await new _1786400000000_AddChatStates_1.AddChatStates1786400000000().up(runner);
        await runner.query(`INSERT INTO "chat_states" ("sessionId", "chatId", "pinned") VALUES ('s1', '628@g.us', 1)`);
        const migration = new _1786650000000_AddChatStateObserved_1.AddChatStateObserved1786650000000();
        await migration.up(runner);
        await migration.up(runner); // idempotent
        expect(await runner.query(`SELECT "observed", "pinned" FROM "chat_states"`)).toEqual([
            { observed: null, pinned: 1 },
        ]);
        await migration.down(runner);
        expect(await runner.hasColumn('chat_states', 'observed')).toBe(false);
        await runner.release();
    });
    it('is a no-op without the table', async () => {
        const runner = ds.createQueryRunner();
        await expect(new _1786650000000_AddChatStateObserved_1.AddChatStateObserved1786650000000().up(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
