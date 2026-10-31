"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const _1779235200000_AddUuidDefaultsForPostgres_1 = require("./migrations/1779235200000-AddUuidDefaultsForPostgres");
const ALL_TABLES = ['sessions', 'webhooks', 'messages', 'message_batches'];
function makeQueryRunner(type, existingTables, opts = {}) {
    const { versionNum = 150000, extInstalled = false, createExtensionThrows = false } = opts;
    const query = jest.fn((sql) => {
        const s = String(sql);
        if (/server_version_num/i.test(s))
            return Promise.resolve([{ num: versionNum }]);
        if (/pg_extension/i.test(s))
            return Promise.resolve(extInstalled ? [{ ok: 1 }] : []);
        if (/CREATE EXTENSION/i.test(s) && createExtensionThrows) {
            return Promise.reject(new Error('permission denied to create extension "pgcrypto"'));
        }
        return Promise.resolve(undefined);
    });
    return {
        dataSource: { options: { type } },
        hasTable: jest.fn((t) => Promise.resolve(existingTables.has(t))),
        query,
    };
}
const sqlOf = (qr) => qr.query.mock.calls.map(call => String(call[0]));
describe('AddUuidDefaultsForPostgres migration', () => {
    const migration = new _1779235200000_AddUuidDefaultsForPostgres_1.AddUuidDefaultsForPostgres1779235200000();
    it('is a no-op on SQLite — issues no query and never probes tables', async () => {
        const qr = makeQueryRunner('sqlite', new Set(ALL_TABLES));
        await migration.up(qr);
        await migration.down(qr);
        expect(qr.query).not.toHaveBeenCalled();
        expect(qr.hasTable).not.toHaveBeenCalled();
    });
    it('on PG 13+ does NOT touch pgcrypto (core gen_random_uuid), only sets the DEFAULTs', async () => {
        const qr = makeQueryRunner('postgres', new Set(ALL_TABLES), { versionNum: 150000 });
        await migration.up(qr);
        const calls = sqlOf(qr);
        expect(calls.some(q => /CREATE EXTENSION/i.test(q))).toBe(false);
        expect(calls.some(q => /pg_extension/i.test(q))).toBe(false); // no need to probe the catalog on 13+
        // version probe + one ALTER per existing table.
        expect(qr.query).toHaveBeenCalledTimes(1 + ALL_TABLES.length);
        expect(qr.query).toHaveBeenCalledWith('ALTER TABLE "sessions" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()::varchar');
    });
    it('on PG <= 12 with pgcrypto missing, creates it BEFORE any gen_random_uuid() default', async () => {
        const qr = makeQueryRunner('postgres', new Set(ALL_TABLES), { versionNum: 120000, extInstalled: false });
        await migration.up(qr);
        const calls = sqlOf(qr);
        const extIdx = calls.findIndex(q => /CREATE EXTENSION IF NOT EXISTS pgcrypto/i.test(q));
        const firstAlterIdx = calls.findIndex(q => /gen_random_uuid\(\)/i.test(q));
        expect(extIdx).toBeGreaterThanOrEqual(0);
        expect(extIdx).toBeLessThan(firstAlterIdx);
    });
    it('on PG <= 12 with pgcrypto already installed, does NOT attempt CREATE EXTENSION', async () => {
        const qr = makeQueryRunner('postgres', new Set(ALL_TABLES), { versionNum: 120000, extInstalled: true });
        await migration.up(qr);
        const calls = sqlOf(qr);
        expect(calls.some(q => /CREATE EXTENSION/i.test(q))).toBe(false);
        expect(calls.some(q => /gen_random_uuid/i.test(q))).toBe(true); // DEFAULTs still applied
    });
    it('on PG <= 12 where the role cannot create pgcrypto, throws a clear error and sets no DEFAULT', async () => {
        const qr = makeQueryRunner('postgres', new Set(ALL_TABLES), {
            versionNum: 120000,
            extInstalled: false,
            createExtensionThrows: true,
        });
        await expect(migration.up(qr)).rejects.toThrow(/pgcrypto/i);
        // Aborted before any ALTER — no half-applied default.
        expect(sqlOf(qr).some(q => /gen_random_uuid/i.test(q))).toBe(false);
    });
    it('skips tables that do not exist', async () => {
        const qr = makeQueryRunner('postgres', new Set(['sessions', 'messages']), { versionNum: 150000 });
        await migration.up(qr);
        // version probe + 2 ALTERs (only the two existing tables).
        expect(qr.query).toHaveBeenCalledTimes(1 + 2);
    });
    it('on Postgres down() drops the DEFAULT on every existing table', async () => {
        const qr = makeQueryRunner('postgres', new Set(ALL_TABLES));
        await migration.down(qr);
        expect(qr.query).toHaveBeenCalledTimes(ALL_TABLES.length);
        expect(qr.query).toHaveBeenCalledWith('ALTER TABLE "message_batches" ALTER COLUMN "id" DROP DEFAULT');
    });
});
