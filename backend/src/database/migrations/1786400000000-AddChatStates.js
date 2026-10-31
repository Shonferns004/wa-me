"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddChatStates1786400000000 = void 0;
/**
 * Creates `chat_states`, the persisted per-session mute/archive/pin table on the `data` connection.
 * Baileys cannot re-deliver these on a reconnect, so they are persisted and rehydrated on boot. Hand
 * authored because `synchronize` is off for `data` on Postgres (and optional on SQLite); the `hasTable`
 * guard keeps it idempotent on a DB where synchronize already created it.
 */
class AddChatStates1786400000000 {
    name = 'AddChatStates1786400000000';
    async up(queryRunner) {
        if (await queryRunner.hasTable('chat_states'))
            return;
        const isPostgres = queryRunner.dataSource.options.type === 'postgres';
        // The DDL matches what TypeORM synchronize would generate from the ChatState entity byte for byte,
        // so the migration-drift gate sees no difference (bare inline PRIMARY KEY, boolean columns, the
        // DEFAULT forms each dialect emits).
        if (isPostgres) {
            await queryRunner.query(`CREATE TABLE "chat_states" ("sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, "muteEndTime" bigint, "archived" boolean NOT NULL DEFAULT false, "pinned" boolean NOT NULL DEFAULT false, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), PRIMARY KEY ("sessionId", "chatId"))`);
        }
        else {
            await queryRunner.query(`CREATE TABLE "chat_states" ("sessionId" varchar NOT NULL, "chatId" varchar NOT NULL, "muteEndTime" bigint, "archived" boolean NOT NULL DEFAULT (0), "pinned" boolean NOT NULL DEFAULT (0), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), PRIMARY KEY ("sessionId", "chatId"))`);
        }
    }
    async down(queryRunner) {
        await queryRunner.query(`DROP TABLE IF EXISTS "chat_states"`);
    }
}
exports.AddChatStates1786400000000 = AddChatStates1786400000000;
