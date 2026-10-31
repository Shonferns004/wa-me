"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// NOTE: kept OUT of src/database/migrations/ on purpose — the TypeORM migrations glob
// (`migrations/*{.ts,.js}`) would otherwise load this spec as a migration under ts-node
// (the CLI datasource / start:dev) and crash on `describe`.
const _1782200000000_AddWebhooksSessionIdIndex_1 = require("./migrations/1782200000000-AddWebhooksSessionIdIndex");
function makeQueryRunner(type, hasWebhooks = true) {
    const query = jest.fn(() => Promise.resolve(undefined));
    return {
        dataSource: { options: { type } },
        hasTable: jest.fn((t) => Promise.resolve(t === 'webhooks' && hasWebhooks)),
        query,
    };
}
const sqlOf = (qr) => qr.query.mock.calls.map(call => String(call[0]));
describe('AddWebhooksSessionIdIndex migration', () => {
    const migration = new _1782200000000_AddWebhooksSessionIdIndex_1.AddWebhooksSessionIdIndex1782200000000();
    it('creates an IF-NOT-EXISTS index on webhooks.sessionId', async () => {
        const qr = makeQueryRunner('sqlite');
        await migration.up(qr);
        expect(sqlOf(qr).join('\n')).toMatch(/CREATE INDEX IF NOT EXISTS "IDX_webhooks_sessionId" ON "webhooks" \("sessionId"\)/);
    });
    it('lifts the statement_timeout on Postgres only (never on SQLite)', async () => {
        const pg = makeQueryRunner('postgres');
        await migration.up(pg);
        expect(sqlOf(pg).some(s => /SET LOCAL statement_timeout = 0/.test(s))).toBe(true);
        const sqlite = makeQueryRunner('sqlite');
        await migration.up(sqlite);
        expect(sqlOf(sqlite).some(s => /SET LOCAL/.test(s))).toBe(false);
    });
    it('is a no-op when the webhooks table does not exist (fresh DB mid-bootstrap)', async () => {
        const qr = makeQueryRunner('sqlite', /* hasWebhooks */ false);
        await migration.up(qr);
        expect(sqlOf(qr).some(s => /CREATE INDEX/.test(s))).toBe(false);
    });
    it('drops the index on down()', async () => {
        const qr = makeQueryRunner('sqlite');
        await migration.down(qr);
        expect(sqlOf(qr).join('\n')).toMatch(/DROP INDEX IF EXISTS "IDX_webhooks_sessionId"/);
    });
});
