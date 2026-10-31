"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runProviderContract = runProviderContract;
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const _1782400000000_AddMessagesFts_1 = require("../../database/migrations/1782400000000-AddMessagesFts");
const message_entity_1 = require("../message/entities/message.entity");
const session_entity_1 = require("../session/entities/session.entity");
const builtin_fts_provider_1 = require("./providers/builtin-fts.provider");
/**
 * Contract every SearchProvider must satisfy. Run inside a `describe` from a provider's own spec
 * (Spec 2's Meilisearch plugin reuses this as its review gate):
 *
 *   describe('MyProvider', () => { runProviderContract(async () => ({ provider, seed })); });
 *
 * The harness seeds a fixed 3-message set (two sessions, one shared term `hello`, one session-unique
 * `goodbye`) in `beforeEach`, then asserts the provider's `search`/`health` contract. `makeProvider`
 * is invoked fresh per test so each case starts from a clean index.
 */
function runProviderContract(makeProvider) {
    let provider;
    let seed;
    beforeEach(async () => {
        const env = await makeProvider();
        provider = env.provider;
        seed = env.seed;
        await seed([
            { body: 'hello world', sessionId: 's1' },
            { body: 'goodbye world', sessionId: 's1' },
            { body: 'hello other', sessionId: 's2' },
        ]);
    });
    it('returns matching hits with a snippet, total, and provider id', async () => {
        const q = 'hello';
        const res = await provider.search({ q, limit: 10 });
        expect(res.provider).toBe(provider.id);
        expect(res.hits.length).toBe(2);
        // Snippet must actually reflect the query term — `length >= 0` is trivially true.
        expect(res.hits.every(h => h.snippet.toLowerCase().includes(q.toLowerCase()))).toBe(true);
        expect(res.total).toBeGreaterThanOrEqual(2);
    });
    it('honors sessionIds scoping', async () => {
        const res = await provider.search({ q: 'hello', sessionIds: ['s2'] });
        // The seed puts `hello other` in s2, so this MUST yield ≥1 hit — otherwise the `every`
        // predicate below is vacuously true on an empty hit set (zero-hit escape hatch).
        expect(res.hits.length).toBeGreaterThanOrEqual(1);
        expect(res.hits.every(h => h.sessionId === 's2')).toBe(true);
    });
    it('returns empty for no matches', async () => {
        const res = await provider.search({ q: 'zzzz' });
        expect(res.hits).toEqual([]);
        // For pagination correctness, total === 0 when no hits is part of the contract.
        expect(res.total).toBe(0);
    });
    it('reports health', async () => {
        const h = await provider.health();
        expect(typeof h.ok).toBe('boolean');
    });
}
// Wire the built-in provider into the contract: proves the harness is satisfiable and gives Spec 2's
// plugin a concrete example. The seed mirrors the FTS provider spec's message shape (Task 6).
describe('BuiltInFtsProvider satisfies the SearchProvider contract', () => {
    let ds;
    afterEach(async () => {
        if (ds && ds.isInitialized) {
            await ds.destroy();
        }
    });
    runProviderContract(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, message_entity_1.Message],
            synchronize: true,
        });
        await ds.initialize();
        await new _1782400000000_AddMessagesFts_1.AddMessagesFts1782400000000().up(ds.createQueryRunner());
        const provider = new builtin_fts_provider_1.BuiltInFtsProvider(ds);
        const seed = async (messages) => {
            await ds.getRepository(message_entity_1.Message).insert(messages.map(m => ({
                sessionId: m.sessionId,
                body: m.body,
                chatId: 'c',
                from: 'a@c.us',
                to: 'dest@c.us',
                type: 'text',
                direction: message_entity_1.MessageDirection.OUTGOING,
                timestamp: 1,
            })));
        };
        return { provider, seed };
    });
});
