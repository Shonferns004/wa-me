"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../message/entities/message.entity");
const search_service_1 = require("./search.service");
const search_provider_registry_1 = require("./search-provider.registry");
const builtin_fts_provider_1 = require("./providers/builtin-fts.provider");
const chat_scope_service_1 = require("../auth/chat-scope.service");
const _1782400000000_AddMessagesFts_1 = require("../../database/migrations/1782400000000-AddMessagesFts");
// A send through the API was once stored with the account's bare phone digits as its sender, while every
// other writer stores the account's JID. A search filtered on that JID must find both. Runs on SQLite, and
// on the postgres:16 service when DATABASE_TYPE=postgres.
describe('search sender filter on the account itself', () => {
    const PHONE = '628123456789';
    let ds;
    let search;
    beforeEach(async () => {
        const postgres = process.env.DATABASE_TYPE === 'postgres';
        ds = new typeorm_1.DataSource(postgres
            ? {
                type: 'postgres',
                host: process.env.DATABASE_HOST || 'localhost',
                port: Number(process.env.DATABASE_PORT || 5432),
                username: process.env.DATABASE_USERNAME || 'openwa',
                password: process.env.DATABASE_PASSWORD || 'openwa',
                database: process.env.DATABASE_NAME || 'openwa',
                entities: [message_entity_1.Message],
            }
            : { type: 'better-sqlite3', database: ':memory:', entities: [message_entity_1.Message], synchronize: true });
        await ds.initialize();
        if (postgres) {
            // The provider queries `messages` through the search path, so the table lives in the default schema.
            await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
            await ds.synchronize();
        }
        await new _1782400000000_AddMessagesFts_1.AddMessagesFts1782400000000().up(ds.createQueryRunner());
        const row = (waMessageId, from, direction, body) => ({
            sessionId: 's1',
            waMessageId,
            chatId: '628987654321@c.us',
            from,
            to: '628987654321@c.us',
            body,
            type: 'text',
            direction,
            status: message_entity_1.MessageStatus.SENT,
            timestamp: 1_700_000_000,
        });
        await ds
            .getRepository(message_entity_1.Message)
            .save([
            row('WA_JID', `${PHONE}@c.us`, message_entity_1.MessageDirection.OUTGOING, 'invoice sent today'),
            row('WA_LEGACY', PHONE, message_entity_1.MessageDirection.OUTGOING, 'invoice sent last year'),
            row('WA_PEER', '628987654321@c.us', message_entity_1.MessageDirection.INCOMING, 'invoice received'),
        ]);
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register(new builtin_fts_provider_1.BuiltInFtsProvider(ds));
        search = new search_service_1.SearchService(registry, new chat_scope_service_1.ChatScopeService({
            findPhoneForLid: () => Promise.resolve(null),
            findLidsForPhone: () => Promise.resolve([]),
        }));
    });
    afterEach(async () => {
        if (ds.options.type === 'postgres')
            await ds.query(`DROP TABLE IF EXISTS "messages" CASCADE`);
        await ds.destroy();
    });
    const hitsFrom = async (from) => (await search.search({ q: 'invoice', from })).hits.map(hit => hit.waMessageId).sort();
    it('finds the rows stored under the bare digits as well as under the JID', async () => {
        expect(await hitsFrom(`${PHONE}@c.us`)).toEqual(['WA_JID', 'WA_LEGACY']);
        expect(await hitsFrom(PHONE)).toEqual(['WA_JID', 'WA_LEGACY']);
    });
    it('keeps the account out of a filter on another sender', async () => {
        expect(await hitsFrom('628987654321@c.us')).toEqual(['WA_PEER']);
    });
});
