"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * `migration:generate` cannot repair a failed migration on this schema. On PostgreSQL it stops before it
 * writes anything: the FTS migration's STORED generated column `messages.body_ts` sends TypeORM to a
 * `typeorm_metadata` table no migration creates. On SQLite it writes the known chain drift (a rebuild of
 * most tables, pinned in migration-drift.spec.ts), in SQLite DDL that the PostgreSQL boot then runs.
 * The development guide's "Migration Fails" answer must not give it as a command to run; prose may still
 * name it with its limits.
 */
const root = (0, node_path_1.join)(__dirname, '..', '..');
describe('the failed-migration advice in the development guide', () => {
    it('does not regenerate a migration to repair a failed one', () => {
        const guide = (0, node_fs_1.readFileSync)((0, node_path_1.join)(root, 'docs', '08-development-guidelines.md'), 'utf8');
        const start = guide.indexOf('#### Migration Fails');
        expect(start).toBeGreaterThanOrEqual(0);
        const end = guide.indexOf('\n### ', start);
        expect(end).toBeGreaterThan(start);
        expect(guide.slice(start, end)).not.toMatch(/npm run migration:generate/);
    });
});
