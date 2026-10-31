"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// NOTE: kept OUT of src/database/migrations/ on purpose — the TypeORM migrations glob
// (`migrations/*{.ts,.js}`) would otherwise load this spec as a migration and crash on `describe`.
const _1782300000000_AddIntegrationUuidDefaults_1 = require("./migrations/1782300000000-AddIntegrationUuidDefaults");
const TABLES = ['conversation_mappings', 'integration_delivery_failures'];
function makeQueryRunner(type, existingTables, versionNum = 150000, extInstalled = false) {
    const query = jest.fn((sql) => {
        const s = String(sql);
        if (/server_version_num/i.test(s))
            return Promise.resolve([{ num: versionNum }]);
        if (/pg_extension/i.test(s))
            return Promise.resolve(extInstalled ? [{ ok: 1 }] : []);
        return Promise.resolve(undefined);
    });
    return {
        dataSource: { options: { type } },
        hasTable: jest.fn((t) => Promise.resolve(existingTables.has(t))),
        query,
    };
}
const sqlOf = (qr) => qr.query.mock.calls.map(call => String(call[0]));
describe('AddIntegrationUuidDefaults migration', () => {
    const migration = new _1782300000000_AddIntegrationUuidDefaults_1.AddIntegrationUuidDefaults1782300000000();
    it('is a no-op on SQLite — issues no query and never probes tables', async () => {
        const qr = makeQueryRunner('sqlite', new Set(TABLES));
        await migration.up(qr);
        expect(qr.query).not.toHaveBeenCalled();
        expect(qr.hasTable).not.toHaveBeenCalled();
    });
    it('sets gen_random_uuid() DEFAULT on both integration tables on PG 13+ (no pgcrypto touched)', async () => {
        const qr = makeQueryRunner('postgres', new Set(TABLES), 150000);
        await migration.up(qr);
        const sql = sqlOf(qr).join('\n');
        for (const t of TABLES) {
            expect(sql).toContain(`ALTER TABLE "${t}" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar`);
        }
        expect(sql).not.toMatch(/CREATE EXTENSION/i); // core built-in on 13+
    });
    it('ensures pgcrypto on PG <= 12 before setting the defaults', async () => {
        const qr = makeQueryRunner('postgres', new Set(TABLES), 120000, /* extInstalled */ false);
        await migration.up(qr);
        expect(sqlOf(qr).some(s => /CREATE EXTENSION IF NOT EXISTS pgcrypto/i.test(s))).toBe(true);
    });
    it('skips a table that does not exist (partial schema)', async () => {
        const qr = makeQueryRunner('postgres', new Set(['conversation_mappings']), 150000);
        await migration.up(qr);
        const sql = sqlOf(qr).join('\n');
        expect(sql).toContain('ALTER TABLE "conversation_mappings"');
        expect(sql).not.toContain('ALTER TABLE "integration_delivery_failures"');
    });
    it('drops the defaults on down() (Postgres only)', async () => {
        const pg = makeQueryRunner('postgres', new Set(TABLES));
        await migration.down(pg);
        for (const t of TABLES) {
            expect(sqlOf(pg).join('\n')).toContain(`ALTER TABLE "${t}" ALTER COLUMN "id" DROP DEFAULT`);
        }
        const sqlite = makeQueryRunner('sqlite', new Set(TABLES));
        await migration.down(sqlite);
        expect(sqlite.query).not.toHaveBeenCalled();
    });
});
