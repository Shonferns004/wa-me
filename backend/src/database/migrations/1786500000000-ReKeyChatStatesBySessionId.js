"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReKeyChatStatesBySessionId1786500000000 = void 0;
/**
 * Re-key `chat_states` from `Session.name` to `Session.id`.
 *
 * The Baileys adapter stamps its per-session rows with the same key that names its auth directory.
 * That key moved from the session name to the session id, so without this the persisted mute,
 * archive and pin state of every existing session is orphaned: the chat list would report the
 * defaults until WhatsApp's next app-state sync re-delivers them, and the old rows would never be
 * read again.
 *
 * Idempotent: after a successful run no `sessionId` matches a session name, so a re-run updates
 * nothing. Rows whose key matches no session are left alone (they belong to a deleted session and
 * nothing reads them either way), and a row whose target key is already taken is skipped rather than
 * violating the (sessionId, chatId) primary key. A key that already is a session's id is left alone
 * even when another session is named after it: a database built by synchronize holds id-keyed rows
 * before this migration first runs.
 */
class ReKeyChatStatesBySessionId1786500000000 {
    name = 'ReKeyChatStatesBySessionId1786500000000';
    async up(queryRunner) {
        if (!(await queryRunner.hasTable('chat_states')))
            return;
        await queryRunner.query(ReKeyChatStatesBySessionId1786500000000.rekey('name', 'id', { skipAlreadyKeyed: true }));
    }
    async down(queryRunner) {
        if (!(await queryRunner.hasTable('chat_states')))
            return;
        await queryRunner.query(ReKeyChatStatesBySessionId1786500000000.rekey('id', 'name'));
    }
    /**
     * Correlated-subquery UPDATE rather than `UPDATE ... FROM`, which SQLite and PostgreSQL spell
     * differently.
     *
     * Static, not a module-level export: TypeORM loads every exported function in this directory as a
     * migration class. Also run by import-data, whose archive may predate this re-key; that caller sets
     * `skipAlreadyKeyed` so a row already keyed by an existing session's `to` value is left alone even
     * when some other session's `from` value happens to equal it. That caller also casts the session
     * columns to varchar: a PostgreSQL schema built by synchronize has a native uuid `sessions.id`, which
     * has no `=` operator against the varchar `chat_states.sessionId`. The migration's own SQL is left
     * unchanged, since the migration chain keeps `sessions.id` varchar.
     */
    static rekey(from, to, opts = {}) {
        const col = (alias, name) => opts.skipAlreadyKeyed ? `CAST(${alias}."${name}" AS varchar)` : `${alias}."${name}"`;
        const target = `(SELECT ${col('s', to)} FROM sessions s WHERE ${col('s', from)} = chat_states."sessionId")`;
        const alreadyKeyed = opts.skipAlreadyKeyed
            ? `
        AND NOT EXISTS (SELECT 1 FROM sessions s2 WHERE ${col('s2', to)} = chat_states."sessionId")`
            : '';
        return `UPDATE chat_states SET "sessionId" = ${target}
      WHERE EXISTS (SELECT 1 FROM sessions s WHERE ${col('s', from)} = chat_states."sessionId")
        AND NOT EXISTS (
          SELECT 1 FROM chat_states c WHERE c."chatId" = chat_states."chatId" AND c."sessionId" = ${target}
        )${alreadyKeyed}`;
    }
}
exports.ReKeyChatStatesBySessionId1786500000000 = ReKeyChatStatesBySessionId1786500000000;
