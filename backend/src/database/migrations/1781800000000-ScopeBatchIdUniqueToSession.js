"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ScopeBatchIdUniqueToSession1781800000000 = void 0;
const typeorm_1 = require("typeorm");
/**
 * Scope `message_batches` uniqueness from a global `UNIQUE(batch_id)` to `UNIQUE(session_id, batch_id)`.
 *
 * The baseline (1770108659848) made `batch_id` globally unique, so one session claiming a batch id
 * denied it to every other session. After the application-level existence check was scoped to the
 * session, that DB-level denial no longer matched the app logic: an explicit cross-session reuse
 * passed the scoped pre-check and then violated the global constraint, surfacing as an unhandled 500
 * (the project registers no exception enveloper). Making the constraint composite aligns the schema
 * with the intended `(session_id, batch_id)` namespace — cross-session reuse is allowed, same-session
 * reuse stays a violation (a DB backstop behind the app's clean 400).
 *
 * Uses the TypeORM schema API rather than raw SQL so the SQLite path (which cannot `ALTER TABLE DROP
 * CONSTRAINT`) is handled by TypeORM's table rebuild, while Postgres gets plain `ALTER TABLE`. Both
 * the lookup and the guards make it idempotent. Hand-authored because `synchronize` is off for the
 * `data` connection.
 */
class ScopeBatchIdUniqueToSession1781800000000 {
    name = 'ScopeBatchIdUniqueToSession1781800000000';
    static TABLE = 'message_batches';
    static COMPOSITE = 'UQ_message_batches_session_id_batch_id';
    static GLOBAL = 'UQ_ff274470c0dbaff6c7d1f9795f5'; // baseline-generated name
    isGlobal(u) {
        return u.columnNames.length === 1 && u.columnNames[0] === 'batch_id';
    }
    isComposite(u) {
        return u.columnNames.length === 2 && u.columnNames.includes('session_id') && u.columnNames.includes('batch_id');
    }
    async up(queryRunner) {
        const table = await queryRunner.getTable(ScopeBatchIdUniqueToSession1781800000000.TABLE);
        if (!table)
            return;
        const global = table.uniques.find(u => this.isGlobal(u));
        if (global) {
            await queryRunner.dropUniqueConstraint(ScopeBatchIdUniqueToSession1781800000000.TABLE, global);
        }
        if (!table.uniques.some(u => this.isComposite(u))) {
            await queryRunner.createUniqueConstraint(ScopeBatchIdUniqueToSession1781800000000.TABLE, new typeorm_1.TableUnique({
                name: ScopeBatchIdUniqueToSession1781800000000.COMPOSITE,
                columnNames: ['session_id', 'batch_id'],
            }));
        }
    }
    async down(queryRunner) {
        const table = await queryRunner.getTable(ScopeBatchIdUniqueToSession1781800000000.TABLE);
        if (!table)
            return;
        const composite = table.uniques.find(u => this.isComposite(u));
        if (composite) {
            await queryRunner.dropUniqueConstraint(ScopeBatchIdUniqueToSession1781800000000.TABLE, composite);
        }
        if (!table.uniques.some(u => this.isGlobal(u))) {
            await queryRunner.createUniqueConstraint(ScopeBatchIdUniqueToSession1781800000000.TABLE, new typeorm_1.TableUnique({ name: ScopeBatchIdUniqueToSession1781800000000.GLOBAL, columnNames: ['batch_id'] }));
        }
    }
}
exports.ScopeBatchIdUniqueToSession1781800000000 = ScopeBatchIdUniqueToSession1781800000000;
