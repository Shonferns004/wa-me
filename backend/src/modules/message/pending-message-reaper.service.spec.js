"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const message_entity_1 = require("./entities/message.entity");
const pending_message_reaper_service_1 = require("./pending-message-reaper.service");
const OPTS = { intervalMs: 600_000, graceMs: 3_600_000, batchSize: 50 };
const hoursAgo = (h) => new Date(Date.now() - h * 3_600_000);
const minutesAgo = (m) => new Date(Date.now() - m * 60_000);
describe('PendingMessageReaperService.sweep', () => {
    let ds;
    let messages;
    let execute;
    let service;
    let seq;
    beforeEach(async () => {
        seq = 0;
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message],
            synchronize: true,
        });
        await ds.initialize();
        messages = ds.getRepository(message_entity_1.Message);
        execute = jest.fn().mockResolvedValue(undefined);
        service = new pending_message_reaper_service_1.PendingMessageReaperService(messages, { execute });
    });
    afterEach(async () => {
        await service.onModuleDestroy();
        if (ds.isInitialized)
            await ds.destroy();
    });
    // queryBuilder insert (not repo.save) so createdAt is set explicitly and the test controls the
    // grace window rather than the @CreateDateColumn "now" default.
    const insertMessage = async (over = {}) => {
        const n = ++seq;
        await messages
            .createQueryBuilder()
            .insert()
            .values({
            id: `msg-${n}`,
            sessionId: 'sess-1',
            chatId: '628123@c.us',
            from: 'me',
            to: '628123@c.us',
            body: `hello ${n}`,
            type: 'text',
            direction: message_entity_1.MessageDirection.OUTGOING,
            status: message_entity_1.MessageStatus.PENDING,
            createdAt: hoursAgo(2),
            ...over,
        })
            .execute();
        return `msg-${n}`;
    };
    const stored = (id) => messages.findOneByOrFail({ id });
    const persistedCalls = () => execute.mock.calls.filter(([event]) => event === 'message:persisted');
    it('fails a stale outgoing PENDING row, marks it reapedAt, and emits message:persisted', async () => {
        const id = await insertMessage();
        const stats = await service.sweep(OPTS);
        expect(stats).toEqual({ scanned: 1, reaped: 1, failed: 0 });
        const row = await stored(id);
        expect(row.status).toBe(message_entity_1.MessageStatus.FAILED);
        expect(typeof row.metadata.reapedAt).toBe('string');
        expect(persistedCalls()).toHaveLength(1);
        const [event, payload, context] = persistedCalls()[0];
        expect(event).toBe('message:persisted');
        expect(payload.sessionId).toBe('sess-1');
        expect(payload.message.id).toBe(id);
        expect(payload.message.status).toBe(message_entity_1.MessageStatus.FAILED);
        expect(payload.message.metadata.reapedAt).toBeDefined();
        expect(context).toEqual({ sessionId: 'sess-1', source: 'PendingMessageReaperService' });
    });
    it('does not touch an outgoing PENDING row younger than the grace window', async () => {
        const id = await insertMessage({ createdAt: minutesAgo(10) });
        const stats = await service.sweep(OPTS);
        expect(stats).toEqual({ scanned: 0, reaped: 0, failed: 0 });
        expect((await stored(id)).status).toBe(message_entity_1.MessageStatus.PENDING);
        expect(execute).not.toHaveBeenCalled();
    });
    it('never touches outgoing rows that already reached a post-pending state', async () => {
        const sent = await insertMessage({ status: message_entity_1.MessageStatus.SENT });
        const failed = await insertMessage({ status: message_entity_1.MessageStatus.FAILED });
        const stats = await service.sweep(OPTS);
        expect(stats).toEqual({ scanned: 0, reaped: 0, failed: 0 });
        expect((await stored(sent)).status).toBe(message_entity_1.MessageStatus.SENT);
        expect((await stored(failed)).status).toBe(message_entity_1.MessageStatus.FAILED);
        expect(execute).not.toHaveBeenCalled();
    });
    it('never touches incoming rows, even a stale PENDING one', async () => {
        const id = await insertMessage({ direction: message_entity_1.MessageDirection.INCOMING });
        const stats = await service.sweep(OPTS);
        expect(stats).toEqual({ scanned: 0, reaped: 0, failed: 0 });
        expect((await stored(id)).status).toBe(message_entity_1.MessageStatus.PENDING);
        expect(execute).not.toHaveBeenCalled();
    });
    it('bounds the sweep to the batch size, oldest first, and drains the rest on the next pass', async () => {
        const ids = [];
        for (const age of [5, 4, 3, 2, 1.5])
            ids.push(await insertMessage({ createdAt: hoursAgo(age) }));
        const tight = { ...OPTS, batchSize: 3 };
        const first = await service.sweep(tight);
        expect(first).toEqual({ scanned: 3, reaped: 3, failed: 0 });
        for (const id of ids.slice(0, 3))
            expect((await stored(id)).status).toBe(message_entity_1.MessageStatus.FAILED);
        for (const id of ids.slice(3))
            expect((await stored(id)).status).toBe(message_entity_1.MessageStatus.PENDING);
        expect(persistedCalls()).toHaveLength(3);
        const second = await service.sweep(tight);
        expect(second).toEqual({ scanned: 2, reaped: 2, failed: 0 });
        for (const id of ids)
            expect((await stored(id)).status).toBe(message_entity_1.MessageStatus.FAILED);
    });
    it('drops the outbound media payload on reap but keeps mimetype/filename and other metadata', async () => {
        const id = await insertMessage({
            type: 'image',
            metadata: { media: { mimetype: 'image/jpeg', filename: 'a.jpg', data: 'aGVsbG8=' }, quotedMessage: { id: 'q1' } },
        });
        await service.sweep(OPTS);
        const metadata = (await stored(id)).metadata;
        expect(metadata.media.data).toBeUndefined();
        expect(metadata.media.mimetype).toBe('image/jpeg');
        expect(metadata.media.filename).toBe('a.jpg');
        expect(metadata.quotedMessage).toEqual({ id: 'q1' });
        expect(metadata.reapedAt).toBeDefined();
        // The emitted snapshot carries the same slimmed metadata.
        const [, payload] = persistedCalls()[0];
        expect(payload.message.metadata.media.data).toBeUndefined();
    });
    it('keeps the batch alive when one row fails to persist', async () => {
        const first = await insertMessage();
        const second = await insertMessage();
        const updateSpy = jest.spyOn(messages, 'update').mockRejectedValueOnce(new Error('db hiccup'));
        const stats = await service.sweep(OPTS);
        expect(stats).toEqual({ scanned: 2, reaped: 1, failed: 1 });
        expect((await stored(first)).status).toBe(message_entity_1.MessageStatus.PENDING);
        expect((await stored(second)).status).toBe(message_entity_1.MessageStatus.FAILED);
        expect(persistedCalls()).toHaveLength(1);
        updateSpy.mockRestore();
    });
    it('does not overwrite a row whose send resolved between the sweep read and the reap write', async () => {
        const id = await insertMessage();
        const realUpdate = messages.update.bind(messages);
        // The live send path persists its own SENT + waMessageId outcome just before the reap write
        // lands; the guarded UPDATE must then match nothing instead of clobbering it back to FAILED.
        jest.spyOn(messages, 'update').mockImplementationOnce(async (criteria, partial) => {
            await realUpdate({ id }, { status: message_entity_1.MessageStatus.SENT, waMessageId: 'wamid.race' });
            return realUpdate(criteria, partial);
        });
        const stats = await service.sweep(OPTS);
        expect(stats).toEqual({ scanned: 1, reaped: 0, failed: 0 });
        const row = await stored(id);
        expect(row.status).toBe(message_entity_1.MessageStatus.SENT);
        expect(row.waMessageId).toBe('wamid.race');
        expect(persistedCalls()).toHaveLength(0);
    });
    // Plugins unregister their hooks and the DataSource closes right after this module is torn down,
    // so a reap landing later would leave a provider's copy PENDING for good.
    it('stops a running pass on destroy and finishes the row in hand before destroy resolves', async () => {
        const ids = [];
        for (const age of [4, 3, 2])
            ids.push(await insertMessage({ createdAt: hoursAgo(age) }));
        const realUpdate = messages.update.bind(messages);
        let reaping;
        const started = new Promise(resolve => (reaping = resolve));
        let release;
        const held = new Promise(resolve => (release = resolve));
        const updateSpy = jest.spyOn(messages, 'update').mockImplementationOnce(async (criteria, partial) => {
            reaping();
            await held;
            return realUpdate(criteria, partial);
        });
        const sweep = service.sweep(OPTS);
        await started;
        const destroyed = service.onModuleDestroy();
        release();
        await destroyed;
        const writesAtDestroy = updateSpy.mock.calls.length;
        const emissionsAtDestroy = persistedCalls().length;
        const stats = await sweep;
        expect(stats).toEqual({ scanned: 1, reaped: 1, failed: 0 });
        expect(writesAtDestroy).toBe(1);
        expect(emissionsAtDestroy).toBe(1);
        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(persistedCalls()).toHaveLength(1);
        expect((await stored(ids[0])).status).toBe(message_entity_1.MessageStatus.FAILED);
        for (const id of ids.slice(1))
            expect((await stored(id)).status).toBe(message_entity_1.MessageStatus.PENDING);
        // A stopped reaper starts no further pass.
        expect(await service.sweep(OPTS)).toEqual({ scanned: 0, reaped: 0, failed: 0 });
    });
});
describe('resolvePendingMessageReaperOptions', () => {
    it('defaults to a 10-minute interval, 1-hour grace, and a batch of 50', () => {
        expect((0, pending_message_reaper_service_1.resolvePendingMessageReaperOptions)({})).toEqual({
            intervalMs: 600_000,
            graceMs: 3_600_000,
            batchSize: 50,
        });
    });
    it('reads interval, grace, and batch size from the environment', () => {
        expect((0, pending_message_reaper_service_1.resolvePendingMessageReaperOptions)({
            MESSAGE_REAPER_INTERVAL_MS: '300000',
            MESSAGE_REAPER_GRACE_MS: '120000',
            MESSAGE_REAPER_BATCH_SIZE: '7',
        })).toEqual({ intervalMs: 300_000, graceMs: 120_000, batchSize: 7 });
    });
    it('falls back to defaults on non-numeric or out-of-range values', () => {
        expect((0, pending_message_reaper_service_1.resolvePendingMessageReaperOptions)({
            MESSAGE_REAPER_INTERVAL_MS: 'abc',
            MESSAGE_REAPER_GRACE_MS: '-5',
            MESSAGE_REAPER_BATCH_SIZE: '0',
        })).toEqual({ intervalMs: 600_000, graceMs: 3_600_000, batchSize: 50 });
    });
    it('treats blank values as unset, not as 0 (which would disable the reaper)', () => {
        expect((0, pending_message_reaper_service_1.resolvePendingMessageReaperOptions)({
            MESSAGE_REAPER_INTERVAL_MS: '',
            MESSAGE_REAPER_GRACE_MS: '   ',
        })).toEqual({ intervalMs: 600_000, graceMs: 3_600_000, batchSize: 50 });
    });
});
describe('PendingMessageReaperService.onModuleInit (scheduling)', () => {
    const ENV_KEYS = ['MESSAGE_REAPER_INTERVAL_MS', 'MESSAGE_REAPER_GRACE_MS', 'MESSAGE_REAPER_BATCH_SIZE'];
    const originals = new Map();
    beforeEach(() => {
        for (const key of ENV_KEYS) {
            originals.set(key, process.env[key]);
            delete process.env[key];
        }
    });
    afterEach(() => {
        for (const key of ENV_KEYS) {
            const value = originals.get(key);
            if (value === undefined)
                delete process.env[key];
            else
                process.env[key] = value;
        }
        originals.clear();
    });
    const makeService = () => new pending_message_reaper_service_1.PendingMessageReaperService({ find: jest.fn() }, { execute: jest.fn() });
    it('does not schedule a timer when MESSAGE_REAPER_INTERVAL_MS=0', () => {
        process.env.MESSAGE_REAPER_INTERVAL_MS = '0';
        const svc = makeService();
        jest.useFakeTimers();
        try {
            const sweepSpy = jest.spyOn(svc, 'sweep');
            svc.onModuleInit();
            jest.advanceTimersByTime(10 * 600_000);
            expect(sweepSpy).not.toHaveBeenCalled();
            void svc.onModuleDestroy();
        }
        finally {
            jest.useRealTimers();
        }
    });
    it('sweeps on the configured interval and stops after onModuleDestroy', () => {
        process.env.MESSAGE_REAPER_INTERVAL_MS = '60000';
        const svc = makeService();
        jest.useFakeTimers();
        try {
            const sweepSpy = jest.spyOn(svc, 'sweep').mockResolvedValue({ scanned: 0, reaped: 0, failed: 0 });
            svc.onModuleInit();
            jest.advanceTimersByTime(60_000);
            expect(sweepSpy).toHaveBeenCalledTimes(1);
            void svc.onModuleDestroy();
            sweepSpy.mockClear();
            jest.advanceTimersByTime(60_000);
            expect(sweepSpy).not.toHaveBeenCalled();
        }
        finally {
            jest.useRealTimers();
        }
    });
});
