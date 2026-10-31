"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1786700000000_AddMessagesSessionChatCreatedAtIndex_1 = require("../1786700000000-AddMessagesSessionChatCreatedAtIndex");
describe('AddMessagesSessionChatCreatedAtIndex migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        // The messages columns this index touches, with the indexes the table already carries, so the
        // plan checks below choose among the real alternatives.
        await ds.query(`CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "sessionId" varchar NOT NULL, ` +
            `"chatId" varchar NOT NULL, "waMessageId" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`);
        await ds.query(`CREATE INDEX "IDX_sess_created" ON "messages" ("sessionId", "createdAt")`);
        await ds.query(`CREATE INDEX "IDX_chat" ON "messages" ("chatId")`);
        await ds.query(`CREATE UNIQUE INDEX "UQ_sess_wa" ON "messages" ("sessionId", "waMessageId")`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const indexNames = async () => {
        const rows = await ds.query(`PRAGMA index_list("messages")`);
        return rows.map(r => r.name).sort();
    };
    const plan = async (sql) => {
        const rows = await ds.query(`EXPLAIN QUERY PLAN ${sql}`, [
            's1',
            'a@c.us',
            'a@s.whatsapp.net',
        ]);
        return rows.map(r => r.detail).join(' | ');
    };
    it('creates the composite index', async () => {
        await new _1786700000000_AddMessagesSessionChatCreatedAtIndex_1.AddMessagesSessionChatCreatedAtIndex1786700000000().up(ds.createQueryRunner());
        expect(await indexNames()).toContain('IDX_messages_sessionId_chatId_createdAt');
    });
    it('is idempotent (re-running up is a no-op) and down() drops the index', async () => {
        const runner = ds.createQueryRunner();
        const migration = new _1786700000000_AddMessagesSessionChatCreatedAtIndex_1.AddMessagesSessionChatCreatedAtIndex1786700000000();
        await migration.up(runner);
        await expect(migration.up(runner)).resolves.toBeUndefined();
        expect(await indexNames()).toContain('IDX_messages_sessionId_chatId_createdAt');
        await migration.down(runner);
        expect(await indexNames()).not.toContain('IDX_messages_sessionId_chatId_createdAt');
    });
    it("serves a chat's total and its pacing-history probe from the index", async () => {
        await new _1786700000000_AddMessagesSessionChatCreatedAtIndex_1.AddMessagesSessionChatCreatedAtIndex1786700000000().up(ds.createQueryRunner());
        expect(await plan(`SELECT COUNT(1) FROM "messages" WHERE "sessionId" = ? AND "chatId" IN (?, ?)`)).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=?)');
        expect(await plan(`SELECT 1 FROM "messages" WHERE "sessionId" = ? AND "chatId" IN (?, ?) AND "createdAt" < datetime('now') LIMIT 1`)).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=? AND createdAt<?)');
    });
});
