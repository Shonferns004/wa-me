"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DateTransformer = void 0;
/**
 * Cross-database date transformer.
 * - SQLite stores as ISO string TEXT, transformer converts to/from Date
 * - PostgreSQL stores as native timestamp, driver returns Date directly
 *
 * DATA CONNECTION ONLY. `to()` resolves the dialect from the global `DATABASE_TYPE`. Pair it
 * only with data-connection entities; the always-SQLite MAIN connection (auth, audit) must not use
 * it (see column-types.ts for the full rationale).
 */
exports.DateTransformer = {
    from: (value) => {
        if (!value)
            return null;
        if (value instanceof Date)
            return value;
        return new Date(value);
    },
    to: (value) => {
        if (!value)
            return null;
        if (value instanceof Date) {
            return process.env.DATABASE_TYPE === 'postgres' ? value : value.toISOString();
        }
        return value;
    },
};
