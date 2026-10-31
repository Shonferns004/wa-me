"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const message_entity_1 = require("./entities/message.entity");
const message_batch_entity_1 = require("./entities/message-batch.entity");
const message_retention_service_1 = require("./message-retention.service");
const _1782400000000_AddMessagesFts_1 = require("../../database/migrations/1782400000000-AddMessagesFts");
describe('resolveMessageRetentionDays', () => {
    it.each([
        [undefined, 0],
        ['', 0],
        ['0', 0],
        ['-5', 0],
        ['30d', 0],
        ['abc', 0],
        ['30', 30],
        ['36500', 36500],
        ['36501', 0],
        ['9999999', 0],
    ])('reads %p as %p', (raw, expected) => {
        expect((0, message_retention_service_1.resolveMessageRetentionDays)({ MESSAGE_RETENTION_DAYS: raw })).toBe(expected);
    });
    it('has no cutoff while retention is off', () => {
        expect((0, message_retention_service_1.resolveMessageRetentionCutoff)(new Date(), {})).toBeUndefined();
        expect((0, message_retention_service_1.resolveMessageRetentionCutoff)(new Date('2026-03-31T00:00:00Z'), { MESSAGE_RETENTION_DAYS: '30' })).toEqual(new Date('2026-03-01T00:00:00Z'));
    });
});
describe('MessageRetentionService against a real database', () => {
    const NOW = new Date('2026-06-30T12:00:00.000Z');
    const DAY_MS = 86_400_000;
    let ds;
    let messages;
    let batches;
    let service;
    let prev;
    const daysAgo = (days) => new Date(NOW.getTime() - days * DAY_MS);
    const addMessages = async (count, at, body = 'hello') => {
        const rows = Array.from({ length: count }, () => ({
            sessionId: 's1',
            chatId: 'peer@c.us',
            from: 'peer@c.us',
            to: 'me@c.us',
            body,
            direction: message_entity_1.MessageDirection.INCOMING,
            createdAt: at,
        }));
        for (let i = 0; i < rows.length; i += 200) {
            await messages.insert(rows.slice(i, i + 200));
        }
    };
    const addBatch = (batchId, status, at) => batches.insert({ batchId, sessionId: 's1', status, messages: [], createdAt: at });
    beforeEach(async () => {
        prev = process.env.MESSAGE_RETENTION_DAYS;
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message, message_batch_entity_1.MessageBatch],
            synchronize: true,
        });
        await ds.initialize();
        messages = ds.getRepository(message_entity_1.Message);
        batches = ds.getRepository(message_batch_entity_1.MessageBatch);
        service = new message_retention_service_1.MessageRetentionService(messages, batches);
    });
    afterEach(async () => {
        service.onModuleDestroy();
        jest.restoreAllMocks();
        if (prev === undefined)
            delete process.env.MESSAGE_RETENTION_DAYS;
        else
            process.env.MESSAGE_RETENTION_DAYS = prev;
        await ds.destroy();
    });
    it('deletes nothing and starts no timer while retention is off', async () => {
        delete process.env.MESSAGE_RETENTION_DAYS;
        await addMessages(3, daysAgo(400));
        const interval = jest.spyOn(global, 'setInterval');
        service.onModuleInit();
        expect(interval).not.toHaveBeenCalled();
        expect(await service.prune(NOW)).toEqual({ messages: 0, batches: 0 });
        expect(await messages.count()).toBe(3);
    });
    /**
     * A cutoff tens of thousands of years back is bound on SQLite as a truncated 4-digit year that
     * sorts after today, so an operator asking to keep everything had every row deleted instead.
     */
    it('deletes nothing for a window beyond the supported maximum', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '9999999';
        await addMessages(2, NOW);
        await addBatch('done-now', message_batch_entity_1.BatchStatus.COMPLETED, NOW);
        expect(await service.prune(NOW)).toEqual({ messages: 0, batches: 0 });
        expect(await messages.count()).toBe(2);
        expect(await batches.count()).toBe(1);
    });
    it('deletes messages older than the window and keeps newer ones', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        await addMessages(4, daysAgo(31));
        await addMessages(2, daysAgo(29));
        expect(await service.prune(NOW)).toEqual({ messages: 4, batches: 0 });
        expect(await messages.count()).toBe(2);
    });
    it('drains a backlog larger than one delete statement in a single run', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        await addMessages(1203, daysAgo(60));
        const del = jest.spyOn(messages, 'delete');
        expect((await service.prune(NOW)).messages).toBe(1203);
        expect(await messages.count()).toBe(0);
        expect(del).toHaveBeenCalledTimes(3); // 500 + 500 + 203
    });
    it('prunes finished batches past the window but never a pending or processing one', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        await addBatch('done-old', message_batch_entity_1.BatchStatus.COMPLETED, daysAgo(40));
        await addBatch('cancelled-old', message_batch_entity_1.BatchStatus.CANCELLED, daysAgo(40));
        await addBatch('failed-old', message_batch_entity_1.BatchStatus.FAILED, daysAgo(40));
        await addBatch('done-new', message_batch_entity_1.BatchStatus.COMPLETED, daysAgo(10));
        await addBatch('pending-old', message_batch_entity_1.BatchStatus.PENDING, daysAgo(40));
        await addBatch('processing-old', message_batch_entity_1.BatchStatus.PROCESSING, daysAgo(40));
        expect((await service.prune(NOW)).batches).toBe(3);
        const left = (await batches.find()).map(b => b.batchId).sort();
        expect(left).toEqual(['done-new', 'pending-old', 'processing-old']);
    });
    it('removes pruned bodies from the built-in full-text index', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        await new _1782400000000_AddMessagesFts_1.AddMessagesFts1782400000000().up(ds.createQueryRunner());
        await addMessages(1, daysAgo(40), 'ancient walrus');
        await addMessages(1, daysAgo(1), 'recent walrus');
        await service.prune(NOW);
        const hits = await ds.query(`SELECT m."body" FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH 'walrus'`);
        expect(hits.map(h => h.body)).toEqual(['recent walrus']);
    });
    it('runs at startup, then daily on an unref-ed timer that destroy clears', () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        const prune = jest.spyOn(service, 'prune').mockResolvedValue({ messages: 0, batches: 0 });
        const unref = jest.fn();
        const interval = jest
            .spyOn(global, 'setInterval')
            .mockReturnValue({ unref });
        const clear = jest.spyOn(global, 'clearInterval');
        service.onModuleInit();
        expect(prune).toHaveBeenCalledTimes(1);
        expect(interval).toHaveBeenCalledWith(expect.any(Function), DAY_MS);
        expect(unref).toHaveBeenCalled();
        service.onModuleDestroy();
        expect(clear).toHaveBeenCalled();
    });
    /**
     * One run deletes at most 100,000 rows. A deployment that takes in more than that a day, or a first
     * enable against a large backlog, never caught up while the next run waited a whole day.
     */
    it('runs again a minute later while a run keeps hitting its cap, then waits a day', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        jest.useFakeTimers();
        try {
            const prune = jest
                .spyOn(service, 'prune')
                .mockResolvedValueOnce({ messages: 100_000, batches: 0 })
                .mockResolvedValueOnce({ messages: 100_000, batches: 0 })
                .mockResolvedValue({ messages: 42, batches: 0 });
            const warn = jest.spyOn(service['logger'], 'warn');
            service.onModuleInit();
            await jest.advanceTimersByTimeAsync(60_000);
            expect(prune).toHaveBeenCalledTimes(2);
            await jest.advanceTimersByTimeAsync(60_000);
            expect(prune).toHaveBeenCalledTimes(3);
            expect(warn).toHaveBeenCalledTimes(2);
            await jest.advanceTimersByTimeAsync(DAY_MS - 120_001);
            expect(prune).toHaveBeenCalledTimes(3);
            await jest.advanceTimersByTimeAsync(1);
            expect(prune).toHaveBeenCalledTimes(4);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('drops a pending follow-up run on destroy', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        jest.useFakeTimers();
        try {
            const prune = jest.spyOn(service, 'prune').mockResolvedValue({ messages: 100_000, batches: 0 });
            service.onModuleInit();
            await jest.advanceTimersByTimeAsync(0);
            service.onModuleDestroy();
            await jest.advanceTimersByTimeAsync(60_000);
            expect(prune).toHaveBeenCalledTimes(1);
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('does not start a second pass while one is running', async () => {
        process.env.MESSAGE_RETENTION_DAYS = '30';
        await addMessages(2, daysAgo(40));
        const [first, second] = await Promise.all([service.prune(NOW), service.prune(NOW)]);
        expect(first.messages + second.messages).toBe(2);
        expect(Math.min(first.messages, second.messages)).toBe(0);
    });
});
