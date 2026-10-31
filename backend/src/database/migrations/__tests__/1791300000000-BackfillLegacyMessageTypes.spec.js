"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const _1791300000000_BackfillLegacyMessageTypes_1 = require("../1791300000000-BackfillLegacyMessageTypes");
describe('BackfillLegacyMessageTypes migration', () => {
    let ds;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await ds.initialize();
        await ds.query(`CREATE TABLE "messages" ("id" varchar PRIMARY KEY NOT NULL, "type" varchar NOT NULL)`);
        const types = [
            'chat',
            'buttons_response',
            'list_response',
            'template_button_reply',
            'ptt',
            'vcard',
            'multi_vcard',
            // Already neutral, or deliberately left alone.
            'text',
            'voice',
            'contact',
            'image',
            'call_log',
            'poll_creation',
        ];
        await ds.query(`INSERT INTO "messages" ("id","type") VALUES ${types.map((t, i) => `('m${i}', '${t}')`).join(',')}`);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const typeOf = async () => {
        const rows = await ds.query(`SELECT "id","type" FROM "messages" ORDER BY "id"`);
        return Object.fromEntries(rows.map(r => [r.id, r.type]));
    };
    it('rewrites every legacy token to the neutral type and touches nothing else', async () => {
        await new _1791300000000_BackfillLegacyMessageTypes_1.BackfillLegacyMessageTypes1791300000000().up(ds.createQueryRunner());
        const after = await typeOf();
        expect([after.m0, after.m1, after.m2, after.m3]).toEqual(['text', 'text', 'text', 'text']);
        expect(after.m4).toBe('voice');
        expect([after.m5, after.m6]).toEqual(['contact', 'contact']);
        // text, voice, contact stay; image, call_log and poll_creation are left as stored.
        expect([after.m7, after.m8, after.m9, after.m10, after.m11, after.m12]).toEqual([
            'text',
            'voice',
            'contact',
            'image',
            'call_log',
            'poll_creation',
        ]);
    });
    it('is idempotent and its down() changes nothing', async () => {
        const migration = new _1791300000000_BackfillLegacyMessageTypes_1.BackfillLegacyMessageTypes1791300000000();
        const runner = ds.createQueryRunner();
        await migration.up(runner);
        const once = await typeOf();
        await migration.up(runner);
        await migration.down();
        expect(await typeOf()).toEqual(once);
    });
    it('does nothing on a database that has no messages table yet', async () => {
        await ds.query(`DROP TABLE "messages"`);
        await expect(_1791300000000_BackfillLegacyMessageTypes_1.BackfillLegacyMessageTypes1791300000000.backfill(ds.createQueryRunner())).resolves.toBeUndefined();
    });
});
