"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const message_service_1 = require("./message.service");
const message_entity_1 = require("./entities/message.entity");
/**
 * A chat thread is read with a chatId IN (...) filter, and SQLite here never has planner statistics.
 * Without them it walked the whole session through (sessionId, createdAt) to fill one chat's page,
 * so the plans of the statements getMessages actually issues are pinned against the entity schema.
 */
describe('message list query plans on SQLite', () => {
    let ds;
    let service;
    const queries = [];
    const logger = {
        logQuery: (sql, params) => {
            queries.push({ sql, params: params });
        },
        logQueryError: () => undefined,
        logQuerySlow: () => undefined,
        logSchemaBuild: () => undefined,
        logMigration: () => undefined,
        log: () => undefined,
    };
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message],
            synchronize: true,
            logging: ['query'],
            logger,
        });
        await ds.initialize();
        service = new message_service_1.MessageService(ds.getRepository(message_entity_1.Message), {}, {}, {}, {
            findLidsForPhone: () => Promise.resolve([]),
            findPhoneForLid: () => Promise.resolve(null),
        }, {}, {});
        queries.length = 0;
    });
    afterEach(async () => {
        await ds.destroy();
    });
    /** The ordered, limited statement that picks the page. */
    const pageQuery = () => {
        const page = queries.find(q => q.sql.includes('ORDER BY') && q.sql.includes('LIMIT'));
        expect(page).toBeDefined();
        return page;
    };
    /** EXPLAIN QUERY PLAN of the page select getMessages issued. */
    const pagePlan = async () => {
        const page = pageQuery();
        const rows = await ds.query(`EXPLAIN QUERY PLAN ${page.sql}`, page.params);
        return rows.map(r => r.detail).join(' | ');
    };
    const countPlan = async () => {
        const count = queries.find(q => q.sql.includes('COUNT('));
        expect(count).toBeDefined();
        const rows = await ds.query(`EXPLAIN QUERY PLAN ${count.sql}`, count.params);
        return rows.map(r => r.detail).join(' | ');
    };
    it('seeks one user chat through the (sessionId, chatId, createdAt) index', async () => {
        // A user chat expands to several dialect candidates (@c.us and @s.whatsapp.net at least).
        await service.getMessages('s1', { chatId: '628123@c.us', limit: 50 });
        expect(await pagePlan()).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=?)');
        expect(await countPlan()).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=?)');
    });
    it('reads a single-candidate chat from the same index in order, with no sort', async () => {
        await service.getMessages('s1', { chatId: '120363@g.us', limit: 50 });
        const plan = await pagePlan();
        expect(plan).toContain('IDX_messages_sessionId_chatId_createdAt (sessionId=? AND chatId=?)');
        expect(plan).not.toContain('TEMP B-TREE');
    });
    it('keeps the unfiltered list on the (sessionId, createdAt) index with no sort', async () => {
        await service.getMessages('s1', { limit: 50 });
        const plan = await pagePlan();
        expect(plan).toContain('(sessionId=?)');
        expect(plan).not.toContain('chatId');
        expect(plan).not.toContain('TEMP B-TREE');
    });
    /**
     * A sort evaluates its result columns for every matching row before the limit applies, so a size
     * computed in the ordered statement read the stored payload of every row in the chat. The size is
     * read by id for the page rows only, and as a byte count, which neither dialect has to load the
     * payload for.
     */
    it('reads metadata sizes for the page rows only, outside the ordered statement', async () => {
        const repo = ds.getRepository(message_entity_1.Message);
        await repo.save(['a', 'b', 'c'].map(n => repo.create({ sessionId: 's1', chatId: '628123@c.us', waMessageId: n, from: 'x', to: 'y', body: n })));
        queries.length = 0;
        const { messages } = await service.getMessages('s1', { chatId: '628123@c.us', limit: 2 });
        expect(messages).toHaveLength(2);
        expect(pageQuery().sql).not.toMatch(/metadata/i);
        const sizes = queries.filter(q => /LENGTH\(/i.test(q.sql));
        expect(sizes).toHaveLength(1);
        expect(sizes[0].sql).toMatch(/OCTET_LENGTH\(/);
        expect(sizes[0].sql).not.toMatch(/(^|[^_])LENGTH\(/);
        expect(sizes[0].sql).not.toContain('ORDER BY');
    });
    /**
     * The page rows are read by id, from about ten ids on SQLite prefers the session or chat index for that
     * statement and visits every row of it (the same session of 300k rows took 20 ms a statement, against 0.05
     * ms by key). Every read of the page's rows has to be a primary key lookup, whatever the list is filtered by.
     */
    describe('the reads of a page by id', () => {
        const seedChat = async () => {
            const repo = ds.getRepository(message_entity_1.Message);
            await repo.save(Array.from({ length: 120 }, (_, i) => repo.create({
                sessionId: 's1',
                chatId: '628123@c.us',
                waMessageId: `w${i}`,
                from: '628123@c.us',
                to: 'y',
                body: 'b',
                type: 'text',
                direction: message_entity_1.MessageDirection.INCOMING,
                timestamp: 1000 + i,
            })));
            queries.length = 0;
        };
        const plansOfReadsById = async () => {
            const reads = queries.filter(q => /"message"\."id" IN/.test(q.sql) && !/^\s*SELECT\s+COUNT/i.test(q.sql));
            const plans = [];
            for (const read of reads) {
                const rows = await ds.query(`EXPLAIN QUERY PLAN ${read.sql}`, read.params);
                plans.push(rows.map(r => r.detail).join(' | '));
            }
            return plans;
        };
        it.each([
            ['an unfiltered list', {}],
            ['one chat', { chatId: '628123@c.us' }],
            [
                'every filter',
                {
                    chatId: '628123@c.us',
                    from: '628123@c.us',
                    direction: message_entity_1.MessageDirection.INCOMING,
                    type: 'text',
                    since: 1000000,
                    until: 1200000,
                    orderBy: 'timestamp',
                },
            ],
        ])('looks %s up by primary key', async (_label, options) => {
            await seedChat();
            const { messages } = await service.getMessages('s1', { ...options, limit: 100, inlineMedia: false });
            expect(messages).toHaveLength(100);
            const plans = await plansOfReadsById();
            expect(plans).toHaveLength(2);
            for (const plan of plans) {
                expect(plan).toBe('SEARCH message USING INDEX sqlite_autoindex_messages_1 (id=?)');
            }
        });
        it('reads a page chunk without the list order', async () => {
            await seedChat();
            await service.getMessages('s1', { limit: 100, inlineMedia: false });
            const chunk = queries.find(q => /"message"\."id" IN/.test(q.sql) && !/OCTET_LENGTH/.test(q.sql));
            expect(chunk).toBeDefined();
            expect(chunk.sql).not.toContain('ORDER BY');
        });
    });
});
