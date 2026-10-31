"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AddSessionDesiredState1786600000000 = void 0;
/**
 * Adds `sessions.desiredState`: 'stopped' once an operator stops a session, cleared by an explicit
 * start. Boot auto-start and the takeover sweep skip stopped rows, so a deliberate stop is no
 * longer undone by the next restart. NULL for every existing row, which keeps today's behaviour.
 * Hand-authored because `synchronize` is off on the `data` connection for Postgres.
 */
class AddSessionDesiredState1786600000000 {
    name = 'AddSessionDesiredState1786600000000';
    async up(queryRunner) {
        if (await queryRunner.hasColumn('sessions', 'desiredState'))
            return;
        await queryRunner.query(`ALTER TABLE "sessions" ADD COLUMN "desiredState" varchar(20)`);
    }
    async down(queryRunner) {
        if (!(await queryRunner.hasColumn('sessions', 'desiredState')))
            return;
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "desiredState"`);
    }
}
exports.AddSessionDesiredState1786600000000 = AddSessionDesiredState1786600000000;
