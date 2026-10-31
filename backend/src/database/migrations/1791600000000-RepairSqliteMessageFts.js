"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepairSqliteMessageFts1791600000000 = void 0;
const sqlite_message_fts_1 = require("../sqlite-message-fts");
/**
 * Rebuild the SQLite full-text index when it no longer matches `messages`. Rows that predate
 * 1782400000000 with a NULL body, a synchronize-built index adopted by that migration's second backfill,
 * and a table rebuild that renumbered rowids all leave an index that still answers, but for the wrong
 * messages. A healthy index is left alone, so a fresh database pays one integrity check and nothing else.
 * PostgreSQL maintains its `tsvector` column itself.
 */
class RepairSqliteMessageFts1791600000000 {
    name = 'RepairSqliteMessageFts1791600000000';
    async up(runner) {
        if (runner.dataSource.options.type !== 'better-sqlite3')
            return;
        await (0, sqlite_message_fts_1.repairSqliteMessageFts)(runner);
    }
    async down() {
        // The previous inconsistent index is not restored.
    }
}
exports.RepairSqliteMessageFts1791600000000 = RepairSqliteMessageFts1791600000000;
