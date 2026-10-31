"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const lid_mapping_entity_1 = require("../../../engine/identity/lid-mapping.entity");
const lid_mapping_store_service_1 = require("../../../engine/identity/lid-mapping-store.service");
const _1781200000000_AddLidMappings_1 = require("../1781200000000-AddLidMappings");
const _1791400000000_AddLidMappingReportSource_1 = require("../1791400000000-AddLidMappingReportSource");
describe('AddLidMappingReportSource migration', () => {
    const pg = process.env.DATABASE_TYPE === 'postgres';
    const server = {
        type: 'postgres',
        host: process.env.DATABASE_HOST || '127.0.0.1',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
    };
    const migration = new _1791400000000_AddLidMappingReportSource_1.AddLidMappingReportSource1791400000000();
    let ds;
    let admin;
    let schema;
    beforeEach(async () => {
        schema = `lid_report_${(0, crypto_1.randomUUID)().replace(/-/g, '')}`;
        admin = pg ? await new typeorm_1.DataSource(server).initialize() : undefined;
        if (admin)
            await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = await new typeorm_1.DataSource(pg
            ? { ...server, schema, extra: { options: `-c search_path=${schema},public` }, entities: [lid_mapping_entity_1.LidMapping] }
            : { type: 'better-sqlite3', database: ':memory:', entities: [lid_mapping_entity_1.LidMapping] }).initialize();
        const runner = ds.createQueryRunner();
        await new _1781200000000_AddLidMappings_1.AddLidMappings1781200000000().up(runner);
        await runner.release();
    });
    afterEach(async () => {
        await ds.destroy();
        if (admin) {
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            await admin.destroy();
        }
    });
    it('preserves legacy data conservatively, upgrades an actual report, and does not renew trust on retry', async () => {
        await ds.query(`INSERT INTO "lid_mappings" ("lid", "phone", "sessionId") VALUES ('111', '628111', 's1'), ('222', NULL, 's2')`);
        const runner = ds.createQueryRunner();
        await migration.up(runner);
        expect(await ds.getRepository(lid_mapping_entity_1.LidMapping).find({ order: { lid: 'ASC' } })).toMatchObject([
            { lid: '111', phone: '628111', sessionId: 's1', isReported: false },
            { lid: '222', phone: null, sessionId: 's2', isReported: false },
        ]);
        const store = new lid_mapping_store_service_1.LidMappingStoreService(ds.getRepository(lid_mapping_entity_1.LidMapping));
        await store.onModuleInit();
        expect(store.getCached('111')).toBe('628111');
        expect(await store.findPhoneForLid('111@lid')).toBeNull();
        await store.remember('111', '628111', 's1');
        await migration.up(runner);
        expect(await store.findPhoneForLid('111@lid')).toBe('628111');
        await runner.release();
    });
    it('clears only unreported positive aliases before dropping origin on downgrade', async () => {
        const runner = ds.createQueryRunner();
        await migration.up(runner);
        await ds.getRepository(lid_mapping_entity_1.LidMapping).insert([
            { lid: '111', phone: '628111', sessionId: 's1', isReported: false },
            { lid: '222', phone: '628222', sessionId: 's2', isReported: true },
            { lid: '333', phone: null, sessionId: 's3', isReported: false },
        ]);
        await migration.down(runner);
        await migration.down(runner);
        expect(await runner.hasColumn('lid_mappings', 'isReported')).toBe(false);
        expect(await ds.query(`SELECT "lid", "phone", "sessionId" FROM "lid_mappings" ORDER BY "lid"`)).toEqual([
            { lid: '111', phone: null, sessionId: null },
            { lid: '222', phone: '628222', sessionId: 's2' },
            { lid: '333', phone: null, sessionId: 's3' },
        ]);
        await runner.release();
    });
    it('skips a database without the mapping table', async () => {
        const runner = ds.createQueryRunner();
        await runner.dropTable('lid_mappings');
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down(runner)).resolves.toBeUndefined();
        await runner.release();
    });
});
