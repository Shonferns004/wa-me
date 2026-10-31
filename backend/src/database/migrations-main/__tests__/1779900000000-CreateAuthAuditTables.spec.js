"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1779900000000_CreateAuthAuditTables_1 = require("../1779900000000-CreateAuthAuditTables");
/**
 * Regression lock: the main-connection migration must create the
 * api_keys + audit_logs schema so that running with MAIN_DATABASE_SYNCHRONIZE=false
 * does NOT leave a fresh install without an auth table (total auth failure at boot).
 */
describe('CreateAuthAuditTables migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
        await ds.initialize();
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('creates api_keys + audit_logs (so auth works without synchronize)', async () => {
        const qr = ds.createQueryRunner();
        await new _1779900000000_CreateAuthAuditTables_1.CreateAuthAuditTables1779900000000().up(qr);
        const tables = (await qr.query("SELECT name FROM sqlite_master WHERE type='table'"));
        const names = tables.map(t => t.name);
        expect(names).toContain('api_keys');
        expect(names).toContain('audit_logs');
        const indexes = (await qr.query("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='api_keys'"));
        expect(indexes.some(i => i.name === 'IDX_api_keys_keyHash')).toBe(true);
        // An API key row inserts and gets its column defaults — i.e. auth can read/write it.
        await qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('1', 'k', 'hash', 'pref')");
        const rows = (await qr.query("SELECT role, isActive, usageCount FROM api_keys WHERE id = '1'"));
        expect(rows[0].role).toBe('operator');
        expect(rows[0].usageCount).toBe(0);
        await qr.release();
    });
    it('is idempotent (safe to run on a DB that already has the tables)', async () => {
        const qr = ds.createQueryRunner();
        const migration = new _1779900000000_CreateAuthAuditTables_1.CreateAuthAuditTables1779900000000();
        await migration.up(qr);
        // running again must NOT throw (CREATE TABLE IF NOT EXISTS)
        await expect(migration.up(qr)).resolves.not.toThrow();
        await qr.release();
    });
    it('down() drops both tables', async () => {
        const qr = ds.createQueryRunner();
        const migration = new _1779900000000_CreateAuthAuditTables_1.CreateAuthAuditTables1779900000000();
        await migration.up(qr);
        await migration.down(qr);
        const tables = (await qr.query("SELECT name FROM sqlite_master WHERE type='table'"));
        const names = tables.map(t => t.name);
        expect(names).not.toContain('api_keys');
        expect(names).not.toContain('audit_logs');
        await qr.release();
    });
});
