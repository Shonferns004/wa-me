"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1779900000000_CreateAuthAuditTables_1 = require("../1779900000000-CreateAuthAuditTables");
const _1786600000000_AddApiKeyAllowedChats_1 = require("../1786600000000-AddApiKeyAllowedChats");
/**
 * Regression lock: the main-connection migration must add `allowedChats` to `api_keys` so a deploy
 * with `MAIN_DATABASE_SYNCHRONIZE=false` can persist and enforce a chat-scoped key.
 */
describe('AddApiKeyAllowedChats migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [], synchronize: false });
        await ds.initialize();
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const columns = async () => {
        const qr = ds.createQueryRunner();
        const rows = (await qr.query(`PRAGMA table_info("api_keys")`));
        await qr.release();
        return rows.map(r => r.name);
    };
    it('adds the nullable allowedChats column on the existing api_keys table', async () => {
        const qr = ds.createQueryRunner();
        await new _1779900000000_CreateAuthAuditTables_1.CreateAuthAuditTables1779900000000().up(qr);
        expect(await columns()).not.toContain('allowedChats');
        await new _1786600000000_AddApiKeyAllowedChats_1.AddApiKeyAllowedChats1786600000000().up(qr);
        expect(await columns()).toContain('allowedChats');
        await qr.query("INSERT INTO api_keys (id, name, keyHash, keyPrefix) VALUES ('1', 'k', 'hash', 'pref')");
        const rows = (await qr.query("SELECT allowedChats FROM api_keys WHERE id = '1'"));
        expect(rows[0].allowedChats).toBeNull();
        await qr.release();
    });
    it('is idempotent', async () => {
        const qr = ds.createQueryRunner();
        await new _1779900000000_CreateAuthAuditTables_1.CreateAuthAuditTables1779900000000().up(qr);
        const migration = new _1786600000000_AddApiKeyAllowedChats_1.AddApiKeyAllowedChats1786600000000();
        await migration.up(qr);
        await expect(migration.up(qr)).resolves.not.toThrow();
        await qr.release();
    });
    it('down() drops the column', async () => {
        const qr = ds.createQueryRunner();
        await new _1779900000000_CreateAuthAuditTables_1.CreateAuthAuditTables1779900000000().up(qr);
        const migration = new _1786600000000_AddApiKeyAllowedChats_1.AddApiKeyAllowedChats1786600000000();
        await migration.up(qr);
        await migration.down(qr);
        expect(await columns()).not.toContain('allowedChats');
        await qr.release();
    });
});
