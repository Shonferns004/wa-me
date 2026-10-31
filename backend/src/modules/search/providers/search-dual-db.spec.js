"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../../../modules/message/entities/message.entity");
const session_entity_1 = require("../../../modules/session/entities/session.entity");
const _1782400000000_AddMessagesFts_1 = require("../../../database/migrations/1782400000000-AddMessagesFts");
const builtin_fts_provider_1 = require("./builtin-fts.provider");
/**
 * Dual-DB switching + import/export round-trip safety (Task 12). OpenWA's `data` DB is SQLite-or-
 * Postgres and switchable; export/import performs `repo.clear()` + re-insert. DB-level sync (SQLite
 * FTS5 triggers / PG generated `body_ts` column) must keep the index correct across that clear+re-
 * insert — no stale or duplicate FTS rows. This is the SQLite runtime proof; the Postgres round-trip
 * is the same clear+re-insert cycle in 1782400000000-AddMessagesFts.pg.spec.ts.
 *
 * Also covers the FTS-absent safety net: if the FTS schema is missing (e.g. non-FTS5 SQLite build
 * where the migration skipped, or a partial state), the provider 501s cleanly instead of crashing on
 * a missing table.
 */
async function boot() {
    const ds = new typeorm_1.DataSource({
        type: 'better-sqlite3',
        database: ':memory:',
        entities: [session_entity_1.Session, message_entity_1.Message],
        synchronize: true,
    });
    await ds.initialize();
    await new _1782400000000_AddMessagesFts_1.AddMessagesFts1782400000000().up(ds.createQueryRunner());
    return { ds, provider: new builtin_fts_provider_1.BuiltInFtsProvider(ds) };
}
// Minimal row factory. `to` is NOT NULL on the entity; including it keeps the insert from failing at
// runtime (the entity's TS type would flag the omission, but the brief's `as any` masked it).
const row = (body) => ({
    sessionId: 's1',
    chatId: 'c1',
    from: 'a@c.us',
    to: 'b@c.us',
    body,
    type: 'text',
    direction: message_entity_1.MessageDirection.OUTGOING,
    timestamp: 1,
});
describe('search dual-DB + import/export round-trip safety (sqlite)', () => {
    it('keeps FTS correct after a clear+re-insert (the import path), repeatedly', async () => {
        const { ds, provider } = await boot();
        const repo = ds.getRepository(message_entity_1.Message);
        // Seed before the cycling begins.
        await repo.insert([row('alpha beta'), row('gamma delta')]);
        // Simulate POST /infra/import-data: clear, then re-insert. The FTS5 external-content triggers
        // must re-derive every index row on re-insert, so no stale 'gamma delta' (only) entry survives
        // and no duplicates accumulate across cycles.
        for (let cycle = 0; cycle < 3; cycle++) {
            await repo.clear();
            await repo.insert([row('alpha beta'), row('gamma delta'), row('alpha gamma')]);
            const res = await provider.search({ q: 'alpha', limit: 10 });
            expect(res.hits).toHaveLength(2); // 'alpha beta' + 'alpha gamma', never the stale 'gamma delta'
            expect(res.total).toBe(2);
        }
        await ds.destroy();
    });
    it('the provider 501s (NotImplemented) when FTS is absent (no-FTS5 / partial-state simulation)', async () => {
        // Boot a DataSource WITHOUT running AddMessagesFts → messages_fts is absent. The provider must
        // detect this and throw NotImplementedException (→ HTTP 501), not crash on a missing table.
        const ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, message_entity_1.Message],
            synchronize: true,
        });
        await ds.initialize();
        const provider = new builtin_fts_provider_1.BuiltInFtsProvider(ds);
        await expect(provider.search({ q: 'x' })).rejects.toThrow(/no full-text index/i);
        await ds.destroy();
    });
});
