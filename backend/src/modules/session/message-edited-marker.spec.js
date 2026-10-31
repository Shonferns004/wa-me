"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../message/entities/message.entity");
const message_mutation_projector_1 = require("./message-mutation-projector");
const message_projector_service_1 = require("./message-projector.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const keyed_mutation_queue_1 = require("../../common/utils/keyed-mutation-queue");
const inbound_room_1 = require("./inbound-room");
describe('persisted edited message marker', () => {
    let db;
    let repository;
    let projector;
    let queue;
    let emit;
    beforeEach(async () => {
        db = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [message_entity_1.Message], synchronize: true });
        await db.initialize();
        repository = db.getRepository(message_entity_1.Message);
        queue = new keyed_mutation_queue_1.KeyedMutationQueue();
        emit = jest.fn();
        projector = new message_mutation_projector_1.MessageMutationProjector(repository, { emitMessageEdited: emit }, { dispatch: jest.fn().mockResolvedValue(undefined) }, queue, { error: jest.fn(), warn: jest.fn() });
    });
    afterEach(async () => {
        await db.destroy();
    });
    const source = { kind: 'edit', chatId: '15550001111@c.us', fromMe: false };
    const edit = { messageId: 'WA_EDIT', chatId: source.chatId, fromMe: false, body: 'new' };
    const metadata = { reactions: { alice: '👍' }, media: { mimetype: 'image/jpeg', archived: true } };
    async function seed(type = 'text') {
        await repository.save({
            sessionId: 's1',
            waMessageId: edit.messageId,
            chatId: source.chatId,
            from: source.chatId,
            to: 'me',
            direction: message_entity_1.MessageDirection.INCOMING,
            body: 'old',
            type,
            metadata,
        });
    }
    async function drain() {
        while (queue.size)
            await new Promise(resolve => setImmediate(resolve));
    }
    it('persists the inbound marker before notifying consumers, without losing other metadata', async () => {
        await seed();
        emit.mockImplementation(() => {
            // Inspect the storage at notification time, rather than assuming the queue wrote it first.
            const row = db.query('SELECT metadata FROM messages');
            return row.then((rows) => {
                const storedMetadata = JSON.parse(rows[0].metadata);
                expect(storedMetadata.edited).toBe(true);
            });
        });
        projector.applyMessageEditQueued('s1', edit);
        await drain();
        const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
        expect(stored.body).toBe('new');
        expect(stored.metadata).toEqual({ ...metadata, edited: true });
        expect(emit).toHaveBeenCalledTimes(1);
        await emit.mock.results[0].value;
    });
    it('persists outbound edits as well', async () => {
        await seed();
        await repository.update({ waMessageId: edit.messageId }, { direction: message_entity_1.MessageDirection.OUTGOING });
        await projector.recordOutboundMessageEdit('s1', edit.messageId, 'REST edit', { ...source, fromMe: true });
        const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
        expect(stored.body).toBe('REST edit');
        expect(stored.metadata).toEqual({ ...metadata, edited: true });
    });
    // A body event that repeats the stored text is no edit; it is still announced, as it always was.
    it('does not mark an edit that leaves the stored text as it is', async () => {
        await seed();
        projector.applyMessageEditQueued('s1', { ...edit, body: 'old' });
        await drain();
        const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
        expect(stored.body).toBe('old');
        expect(stored.metadata).toEqual(metadata);
        expect(emit).toHaveBeenCalledTimes(1);
    });
    // The row can be inserted after the read that found none, so the write compares the text, not the read.
    it.each([
        ['before the write of a new text', 'findOne', 'new', 'new', { ...metadata, edited: true }],
        ['before the write of the same text', 'findOne', 'old', 'old', metadata],
        ['after the write of a new text', 'update', 'new', 'old', metadata],
        ['after the write of the same text', 'update', 'old', 'old', metadata],
    ])('marks a row the insert lands on %s only where the write changed its text', async (_, after, body, stored, marked) => {
        const real = repository[after].bind(repository);
        jest.spyOn(repository, after).mockImplementationOnce((async (...args) => {
            const result = await real(...args);
            await seed();
            return result;
        }));
        projector.applyMessageEditQueued('s1', { ...edit, body });
        await drain();
        const row = await repository.findOneByOrFail({ waMessageId: edit.messageId });
        expect(row.body).toBe(stored);
        expect(row.metadata).toEqual(marked);
        expect(emit).toHaveBeenCalledTimes(1);
    });
    it('marks an edit of a row stored without a text', async () => {
        await seed();
        await repository.update({ waMessageId: edit.messageId }, { body: () => 'NULL' });
        projector.applyMessageEditQueued('s1', edit);
        await drain();
        const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
        expect(stored.body).toBe('new');
        expect(stored.metadata).toEqual({ ...metadata, edited: true });
    });
    it('does not restore or mark a revoked message', async () => {
        await seed('revoked');
        await repository.update({ waMessageId: edit.messageId }, { body: '', metadata: {} });
        projector.applyMessageEditQueued('s1', edit);
        await drain();
        const stored = await repository.findOneByOrFail({ waMessageId: edit.messageId });
        expect(stored.body).toBe('');
        expect(stored.metadata).toEqual({});
    });
    it('does not mark another chat when an edit names the wrong chat', async () => {
        await seed();
        projector.applyMessageEditQueued('s1', { ...edit, chatId: '15550002222@c.us' });
        await drain();
        expect((await repository.findOneByOrFail({ waMessageId: edit.messageId })).metadata).toEqual(metadata);
        expect(emit).not.toHaveBeenCalled();
    });
});
// An edit can reach a message before its row is written: its insert is out, or an earlier message of the
// chat holds the commit turn. The edit then lands on the row once it exists, and leaves the same marker.
describe('edited marker for a message whose row is not written yet', () => {
    const CHAT = '15550001111@c.us';
    let db;
    let repository;
    let projector;
    let engine;
    // The insert of a row waits for the promise held under its message id.
    let stalled;
    // What the message hooks were given, and what webhooks and the socket were told, in order.
    let hooked;
    let announced;
    let hookManager;
    const flush = async () => {
        for (let i = 0; i < 25; i++)
            await new Promise(resolve => setImmediate(resolve));
    };
    const incoming = (id, over = {}) => ({
        id,
        chatId: CHAT,
        from: CHAT,
        to: 'me@c.us',
        body: 'original',
        type: 'text',
        timestamp: 1_700_000_000,
        fromMe: false,
        isGroup: false,
        kind: 'individual',
        ...over,
    });
    const editOf = (messageId, body) => ({ messageId, chatId: CHAT, fromMe: false, body });
    const stored = (waMessageId) => repository.findOneByOrFail({ waMessageId });
    beforeEach(async () => {
        db = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [message_entity_1.Message], synchronize: true });
        await db.initialize();
        repository = db.getRepository(message_entity_1.Message);
        stalled = new Map();
        hooked = [];
        announced = [];
        hookManager = {
            execute: jest.fn((event, data) => {
                hooked.push({ event, data: data });
                return Promise.resolve({ continue: true, data });
            }),
        };
        const insert = repository.insert.bind(repository);
        jest.spyOn(repository, 'insert').mockImplementation(async (row) => {
            await stalled.get(row.waMessageId);
            return insert(row);
        });
        const engines = new engine_registry_service_1.EngineRegistry();
        engine = { tag: 'one' };
        engines.set('s1', engine);
        projector = new message_projector_service_1.MessageProjector(repository, { update: jest.fn().mockResolvedValue({ affected: 1 }) }, engines, new Proxy({}, {
            get: (_target, name) => (_id, payload) => {
                announced.push({ event: `socket ${String(name)}`, payload });
            },
        }), {
            dispatch: jest.fn((_id, event, payload) => {
                announced.push({ event, payload });
                return Promise.resolve();
            }),
        }, hookManager, { ingest: jest.fn() }, { resolveSenderPhone: jest.fn().mockResolvedValue(null) });
    });
    afterEach(async () => {
        await db.destroy();
    });
    // What an engine that applied an edit before the hand-over tells the session stays between them.
    it('removes the text a message arrived with before it is hooked, stored or announced', async () => {
        projector.handleInboundMessage('s1', engine, incoming('A', { body: 'fixed', originalBody: 'original' }));
        projector.handleOwnSendEcho('s1', engine, incoming('S', { fromMe: true, body: 'fixed', originalBody: 'original' }));
        await flush();
        const seen = [
            ...hooked.filter(h => /^message:(received|sent)$/.test(h.event)).map(h => h.data),
            ...announced.map(a => a.payload),
        ];
        expect(seen.length).toBeGreaterThanOrEqual(4);
        for (const payload of seen)
            expect(payload).not.toHaveProperty('originalBody');
        expect(announced.find(a => a.event === 'message.received')?.payload).toEqual(expect.objectContaining({ body: 'fixed' }));
        expect((await stored('A')).body).toBe('fixed');
        expect((await stored('S')).body).toBe('fixed');
    });
    // A hook that hands back something that is not a message leaves the session with the engine's own copy.
    it('removes the text a message arrived with from the copy it falls back to when a hook returns no message', async () => {
        hookManager.execute.mockImplementation(() => Promise.resolve({ continue: true, data: null }));
        projector.handleInboundMessage('s1', engine, incoming('A', { body: 'fixed', originalBody: 'original' }));
        projector.handleOwnSendEcho('s1', engine, incoming('S', { fromMe: true, body: 'fixed', originalBody: 'original' }));
        await flush();
        const sent = announced.filter(a => a.event === 'message.received' || a.event === 'message.sent');
        expect(sent.map(a => a.event).sort()).toEqual(['message.received', 'message.sent']);
        for (const { payload } of sent) {
            expect(payload).toEqual(expect.objectContaining({ body: 'fixed' }));
            expect(payload).not.toHaveProperty('originalBody');
        }
    });
    it('marks a message edited while its insert is out, beside the metadata it was stored with', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A', { quotedMessage: { id: 'Q', body: 'quoted' } }));
        await flush();
        expect(await repository.count()).toBe(0);
        projector.applyMessageEditQueued('s1', editOf('A', 'edited'));
        projector.applyReactionQueued('s1', { messageId: 'A', chatId: CHAT, senderId: CHAT, reaction: '👍' });
        await flush();
        insert.resolve();
        await flush();
        const row = await stored('A');
        expect(row.body).toBe('edited');
        expect(row.metadata).toEqual({
            quotedMessage: { id: 'Q', body: 'quoted' },
            reactions: { [CHAT]: '👍' },
            edited: true,
        });
    });
    it('leaves an edit that repeats the text unmarked while the insert is out, and announces it', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('A', 'original'));
        await flush();
        insert.resolve();
        await flush();
        expect(await stored('A')).toEqual(expect.objectContaining({ body: 'original', metadata: null }));
        expect(announced.filter(a => a.event === 'message.edited')).toHaveLength(1);
    });
    it('marks a message edited and then restored to its text while the insert is out', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('A', 'v1'));
        projector.applyMessageEditQueued('s1', editOf('A', 'original'));
        await flush();
        insert.resolve();
        await flush();
        expect(await stored('A')).toEqual(expect.objectContaining({ body: 'original', metadata: { edited: true } }));
    });
    it('keeps the mark of an edit that restored the text when the message is delivered again', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('A', 'v1'));
        projector.applyMessageEditQueued('s1', editOf('A', 'original'));
        projector.handleInboundMessage('s1', engine, incoming('A'));
        await flush();
        insert.resolve();
        await flush();
        expect(await stored('A')).toEqual(expect.objectContaining({ body: 'original', metadata: { edited: true } }));
    });
    // The engine applied the edit before the hand-over and told the session of it, so the text the message was
    // handed over with is already the edited one.
    it('compares an edit with the text the message arrived with, not the one it was handed over with', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        stalled.set('B', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A', { body: 'fixed', originalBody: 'original' }));
        projector.handleInboundMessage('s1', engine, incoming('B', { body: 'original' }));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('A', 'fixed'));
        projector.applyMessageEditQueued('s1', editOf('B', 'original'));
        await flush();
        insert.resolve();
        await flush();
        expect(await stored('A')).toEqual(expect.objectContaining({ body: 'fixed', metadata: { edited: true } }));
        expect(await stored('B')).toEqual(expect.objectContaining({ body: 'original', metadata: null }));
    });
    // A REST edit is asked for by the caller, and the stored row is marked for it whatever the text.
    it('marks a send a REST edit reaches while its insert is out, even when the edit repeats the text', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('S', insert.promise);
        projector.handleOwnSendEcho('s1', engine, incoming('S', { fromMe: true, body: 'sent' }));
        await flush();
        await projector.recordOutboundMessageEdit('s1', 'S', 'sent', { kind: 'edit', chatId: CHAT, fromMe: true });
        insert.resolve();
        await flush();
        expect(await stored('S')).toEqual(expect.objectContaining({ body: 'sent', metadata: { edited: true } }));
    });
    it('marks a message edited while it waits behind an earlier message of its chat', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        projector.handleInboundMessage('s1', engine, incoming('B'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('B', 'edited'));
        await flush();
        insert.resolve();
        await flush();
        expect(await stored('B')).toEqual(expect.objectContaining({ body: 'edited', metadata: { edited: true } }));
        expect((await stored('A')).metadata).toBeNull();
    });
    it('marks a send echoed behind an earlier message when a REST edit reaches it first', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        projector.handleOwnSendEcho('s1', engine, incoming('S', { fromMe: true, body: 'sent' }));
        await flush();
        await projector.recordOutboundMessageEdit('s1', 'S', 'rest edit', { kind: 'edit', chatId: CHAT, fromMe: true });
        insert.resolve();
        await flush();
        expect(await stored('S')).toEqual(expect.objectContaining({ body: 'rest edit', direction: message_entity_1.MessageDirection.OUTGOING, metadata: { edited: true } }));
    });
    // The message.edited of a message without a row reaches consumers before the message itself, so the
    // announcement of the message says what its row is stored with.
    it('announces each message with the edited mark its row is stored with, and no mark on the others', async () => {
        const insert = (0, inbound_room_1.deferred)();
        const ids = ['A', 'R', 'V', 'N', 'T', 'S', 'D'];
        for (const id of ids)
            stalled.set(id, insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        projector.handleInboundMessage('s1', engine, incoming('R'));
        projector.handleInboundMessage('s1', engine, incoming('V'));
        projector.handleInboundMessage('s1', engine, incoming('N'));
        projector.handleInboundMessage('s1', engine, incoming('T', { body: 'fixed', originalBody: 'original' }));
        projector.handleOwnSendEcho('s1', engine, incoming('S', { fromMe: true, body: 'sent' }));
        projector.handleInboundMessage('s1', engine, incoming('D'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('A', 'edited'));
        projector.applyMessageEditQueued('s1', editOf('R', 'original'));
        projector.applyMessageEditQueued('s1', editOf('V', 'v1'));
        projector.applyMessageEditQueued('s1', editOf('V', 'original'));
        projector.applyMessageEditQueued('s1', editOf('T', 'fixed'));
        await projector.recordOutboundMessageEdit('s1', 'S', 'sent', { kind: 'edit', chatId: CHAT, fromMe: true });
        projector.applyMessageEditQueued('s1', editOf('D', 'edited'));
        await projector.recordRevoke('s1', 'D');
        insert.resolve();
        await flush();
        const marked = [];
        for (const id of ids) {
            const row = await stored(id);
            const payloads = announced
                .filter(a => /^(message\.(received|sent)|socket emitMessage(Sent)?)$/.test(a.event) && a.payload.id === id)
                .map(a => a.payload);
            // The webhook and the socket.
            expect(payloads).toHaveLength(2);
            for (const payload of payloads) {
                expect(payload.body).toBe(row.body);
                if (row.metadata?.edited)
                    expect(payload.edited).toBe(true);
                else
                    expect(payload).not.toHaveProperty('edited');
            }
            if (row.metadata?.edited)
                marked.push(id);
        }
        expect(marked).toEqual(['A', 'V', 'T', 'S']);
    });
    it('leaves a message nobody edited unmarked', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        await flush();
        insert.resolve();
        await flush();
        expect((await stored('A')).metadata).toBeNull();
    });
    it('does not mark a message deleted after the edit while it was not written yet', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A'));
        await flush();
        projector.applyMessageEditQueued('s1', editOf('A', 'edited'));
        await projector.recordRevoke('s1', 'A');
        insert.resolve();
        await flush();
        expect(await stored('A')).toEqual(expect.objectContaining({ body: '', type: 'revoked', metadata: null }));
    });
    // An engine that applied an edit before the hand-over names the text the message arrived with, only when the edit
    // changed it. The edit itself may have reached the session before the message, which then held nothing to mark.
    it('marks a message and a send the engine handed over edited, though no edit reached them here', async () => {
        projector.handleInboundMessage('s1', engine, incoming('A', { body: 'fixed', originalBody: 'original' }));
        projector.handleOwnSendEcho('s1', engine, incoming('S', { fromMe: true, body: 'fixed', originalBody: 'original' }));
        await flush();
        for (const id of ['A', 'S']) {
            expect(await stored(id)).toEqual(expect.objectContaining({ body: 'fixed', metadata: { edited: true } }));
        }
        const sent = announced.filter(a => /^(message\.(received|sent)|socket emitMessage(Sent)?)$/.test(a.event));
        // The webhook and the socket, for each.
        expect(sent).toHaveLength(4);
        for (const { payload } of sent)
            expect(payload).toEqual(expect.objectContaining({ body: 'fixed', edited: true }));
    });
    it('does not mark a message the engine handed over edited and that was deleted before it was written', async () => {
        const insert = (0, inbound_room_1.deferred)();
        stalled.set('A', insert.promise);
        projector.handleInboundMessage('s1', engine, incoming('A', { body: 'fixed', originalBody: 'original' }));
        await flush();
        await projector.recordRevoke('s1', 'A');
        insert.resolve();
        await flush();
        expect(await stored('A')).toEqual(expect.objectContaining({ body: '', type: 'revoked', metadata: null }));
        const received = announced.filter(a => a.event === 'message.received').map(a => a.payload);
        expect(received).toEqual([expect.objectContaining({ body: '', type: 'revoked' })]);
        expect(received[0]).not.toHaveProperty('edited');
    });
});
