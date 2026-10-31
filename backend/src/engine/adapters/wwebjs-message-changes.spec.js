"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const v8_1 = require("v8");
const vm_1 = require("vm");
const whatsapp_web_js_1 = require("whatsapp-web.js");
const typeorm_1 = require("typeorm");
const whatsapp_web_js_adapter_1 = require("./whatsapp-web-js.adapter");
const wwebjs_message_events_1 = require("./wwebjs-message-events");
const engine_registry_service_1 = require("../engine-registry.service");
const message_projector_service_1 = require("../../modules/session/message-projector.service");
const inbound_room_1 = require("../../modules/session/inbound-room");
const logger_service_1 = require("../../common/services/logger.service");
const message_entity_1 = require("../../modules/message/entities/message.entity");
const CHAT = '628111@c.us';
const SELF = '628123@c.us';
const flush = async () => {
    for (let i = 0; i < 12; i++)
        await new Promise(resolve => setImmediate(resolve));
};
// TypeORM's FindOperator, read without importing its internals, as the projector specs do.
const matches = (row, where) => Object.entries(where).every(([key, want]) => {
    if (key === 'metadata')
        return true;
    const op = want;
    if (op && typeof op === 'object' && op._type === 'not')
        return row[key] !== op._value;
    if (op && typeof op === 'object' && op._type === 'or') {
        return op._value.some(alternative => matches(row, { [key]: alternative }));
    }
    if (op && typeof op === 'object' && op._type === 'isNull')
        return row[key] == null;
    return row[key] === want;
});
/** A message as whatsapp-web.js hands it to the `message` and `message_create` events. */
const incoming = (id, body, opts = {}) => ({
    id: { _serialized: id },
    from: opts.fromMe ? SELF : CHAT,
    to: opts.fromMe ? CHAT : SELF,
    body,
    type: opts.page ? 'image' : 'chat',
    timestamp: 1_700_000_000,
    fromMe: Boolean(opts.fromMe),
    hasMedia: Boolean(opts.page),
    _data: { mimetype: 'image/png', size: 3 },
    client: { pupPage: { evaluate: opts.page } },
    getContact: jest.fn(() => opts.contact ?? Promise.resolve(null)),
    hasQuotedMsg: false,
});
/**
 * A `message_edit` as whatsapp-web.js raises it: the message as it is after the change, whose `body` is its text
 * (the caption of a media message), and the new value of the attribute that changed, which is that text unless
 * `attribute` says otherwise (the thumbnail a media message keeps in its body attribute).
 */
const editEvent = (client, id, body, opts = {}) => client.emit('message_edit', {
    id: { _serialized: id },
    from: opts.fromMe ? SELF : CHAT,
    to: opts.fromMe ? CHAT : SELF,
    body,
    type: opts.media ? 'image' : 'chat',
    fromMe: Boolean(opts.fromMe),
    hasMedia: Boolean(opts.media),
}, opts.attribute ?? body);
const THUMBNAIL = '/9j/4AAQSkZJRgABAQAAAQABAAD';
const revokeEvent = (client, id, opts = {}) => client.emit('message_revoke_everyone', {
    id: { _serialized: `revoke-of-${id}` },
    from: opts.fromMe ? SELF : CHAT,
    to: opts.fromMe ? CHAT : SELF,
    fromMe: Boolean(opts.fromMe),
    timestamp: 2,
}, { id: { _serialized: id } });
const reactionEvent = (client, id, reaction) => client.emit('message_reaction', { msgId: { _serialized: id }, id: { remote: CHAT }, reaction, senderId: CHAT });
/** A `message_ciphertext`: a message WhatsApp Web could not decrypt yet, shown as "Waiting for this message". */
const ciphertextEvent = (client, id, subtype) => client.emit('message_ciphertext', {
    id: { _serialized: id },
    from: CHAT,
    to: SELF,
    body: '',
    type: 'ciphertext',
    rawData: { type: 'ciphertext', ...(subtype ? { subtype } : {}) },
});
describe.each([
    ['PostgreSQL', 'postgres'],
    ['SQLite', 'better-sqlite3'],
])('a change that reaches a message whatsapp-web.js still processes, on %s', (_name, type) => {
    const env = { ...process.env };
    let rows;
    let dispatch;
    let client;
    // The bodies the message:received and message:sent hooks were given, and a gate that holds the first of them.
    let hooked;
    let hookGate;
    // The rows handed to message:persisted, as they were then; what a plugin's message hook returns instead; an
    // insert that fails for good (not a unique violation, not transient).
    let persisted;
    let rewrite;
    let failInsert;
    let engines;
    let engine;
    let findOne;
    // Holds a row write the test names until the promise it returns settles.
    let holdWrite;
    let projector;
    beforeEach(() => {
        process.env.INBOUND_MEDIA_CONCURRENCY = '1';
        rows = [];
        hooked = [];
        hookGate = undefined;
        persisted = [];
        rewrite = undefined;
        failInsert = undefined;
        holdWrite = () => undefined;
        findOne = jest.fn(({ where }) => Promise.resolve(rows.find(r => matches(r, where)) ?? null));
        // The real projector over a stand-in `messages` table, wired as the database wires it: only PostgreSQL
        // admits a message on arrival.
        const repo = {
            manager: { connection: { options: { type } } },
            find: jest.fn().mockResolvedValue([]),
            findOne,
            create: jest.fn((x) => ({ ...x })),
            insert: jest.fn((row) => {
                if (failInsert?.(row)) {
                    return Promise.reject(Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }));
                }
                // As the real table's unique index refuses a second row under an id.
                if (rows.some(r => r.waMessageId === row.waMessageId)) {
                    return Promise.reject(Object.assign(new Error('UNIQUE constraint failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }));
                }
                rows.push({ ...row });
                return Promise.resolve({ identifiers: [{ id: `pk-${String(row.waMessageId)}` }], generatedMaps: [] });
            }),
            update: jest.fn((where, patch) => {
                const write = () => {
                    const hit = rows.filter(r => matches(r, where));
                    for (const r of hit)
                        Object.assign(r, patch);
                    return { affected: hit.length };
                };
                const held = holdWrite(patch);
                return held ? held.then(write) : Promise.resolve(write());
            }),
        };
        dispatch = jest.fn().mockResolvedValue(undefined);
        engines = new engine_registry_service_1.EngineRegistry();
        engine = {};
        engines.set('s1', engine);
        projector = new message_projector_service_1.MessageProjector(repo, { update: jest.fn().mockResolvedValue({ affected: 1 }) }, engines, new Proxy({}, { get: () => jest.fn() }), { dispatch }, {
            execute: jest.fn(async (event, data) => {
                if (event === 'message:persisted')
                    persisted.push({ ...data.message });
                if (event !== 'message:received' && event !== 'message:sent')
                    return { continue: true, data };
                hooked.push(String(data.body));
                if (event === 'message:received')
                    await hookGate;
                return { continue: true, data: rewrite ? rewrite(data) : data };
            }),
        }, { ingest: jest.fn() }, { resolveSenderPhone: jest.fn().mockResolvedValue(null) });
        const callbacks = {
            ...(type === 'postgres'
                ? {
                    admitInbound: (a) => projector.admitInbound('s1', engine, a),
                }
                : {}),
            onMessage: (m, t) => projector.handleInboundMessage('s1', engine, m, t),
            onMessageCreate: (m, t) => projector.handleOwnSendEcho('s1', engine, m, t),
            onMessageRevoked: (m, actor) => projector.handleMessageRevoked('s1', engine, m, actor),
            onMessageEdited: m => projector.applyMessageEditQueued('s1', m),
            onMessageReaction: r => projector.applyReactionQueued('s1', r),
        };
        // The real adapter wiring, as WhatsAppWebJsAdapter.setupEventHandlers builds it.
        const adapter = new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({
            sessionId: 'changes',
            sessionDataPath: './data/sessions',
            puppeteer: {},
        });
        client = Object.assign(new events_1.EventEmitter(), {
            info: { wid: { user: '628123' }, pushname: 'Tester' },
            getState: jest.fn().mockResolvedValue(whatsapp_web_js_1.WAState.CONNECTED),
            pupPage: { evaluate: jest.fn().mockResolvedValue(true) },
        });
        adapter.client = client;
        adapter.callbacks = callbacks;
        adapter.lifecycle.setupEventHandlers();
    });
    afterEach(() => {
        process.env = { ...env };
    });
    /** The payloads dispatched to webhooks under one event, in order. */
    const events = (event) => dispatch.mock.calls.filter(c => c[1] === event).map(c => c[2]);
    const download = () => {
        const page = (0, inbound_room_1.deferred)();
        return { page: jest.fn(() => page.promise), finish: () => page.resolve({ mimetype: 'image/png', data: 'QUJD' }) };
    };
    // What a message deleted for everyone while it was processed leaves behind. PostgreSQL held the message from its
    // arrival and stores it cleared. SQLite is told of it only at the hand-over, which is skipped, as the Baileys
    // adapter skips it: no row, no hook, no announcement.
    const deletedRows = (id) => type === 'postgres'
        ? [expect.objectContaining({ waMessageId: id, body: '', type: 'revoked', metadata: null })]
        : [];
    it('leaves no content of a message deleted for everyone during its contact lookup, and announces none', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'secret', { contact: contact.promise }));
        await flush();
        revokeEvent(client, 'A');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual(deletedRows('A'));
        expect(hooked).toEqual([]);
        expect(events('message.received')).toEqual([]);
        expect(events('message.revoked')).toHaveLength(1);
    });
    it('leaves no content of a message deleted for everyone during its media download, and announces none', async () => {
        const media = download();
        client.emit('message', incoming('M', 'caption', { page: media.page }));
        await flush();
        revokeEvent(client, 'M');
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual(deletedRows('M'));
        expect(hooked).toEqual([]);
        expect(events('message.received')).toEqual([]);
        expect(events('message.revoked')).toHaveLength(1);
    });
    it('stores an edit made during the contact lookup, marked edited, and announces the edited text', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        editEvent(client, 'A', 'fixed');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'fixed', metadata: { edited: true } })]);
        expect(hooked).toEqual(['fixed']);
        expect(events('message.received')).toEqual([expect.objectContaining({ body: 'fixed', edited: true })]);
        expect(events('message.edited').map(m => m.body)).toEqual(['fixed']);
    });
    it('stores an edit made during the media download beside the media, and announces the edited text', async () => {
        const media = download();
        client.emit('message', incoming('M', 'cap', { page: media.page }));
        await flush();
        editEvent(client, 'M', 'new cap', { media: true });
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual([
            expect.objectContaining({
                waMessageId: 'M',
                body: 'new cap',
                metadata: { media: expect.objectContaining({ mimetype: 'image/png' }), edited: true },
            }),
        ]);
        expect(hooked).toEqual(['new cap']);
        expect(events('message.received')).toEqual([expect.objectContaining({ body: 'new cap', edited: true })]);
    });
    it('keeps the caption of a message whose thumbnail changed during the media download, and announces no edit', async () => {
        const media = download();
        client.emit('message', incoming('M', 'cap', { page: media.page }));
        await flush();
        editEvent(client, 'M', 'cap', { media: true, attribute: THUMBNAIL });
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual([
            expect.objectContaining({
                waMessageId: 'M',
                body: 'cap',
                metadata: { media: expect.objectContaining({ mimetype: 'image/png' }) },
            }),
        ]);
        expect(hooked).toEqual(['cap']);
        expect(events('message.received').map(m => m.body)).toEqual(['cap']);
        expect(events('message.edited')).toEqual([]);
    });
    it('keeps the stored caption of a message whose thumbnail changed, and announces no edit', async () => {
        client.emit('message', incoming('M', 'cap', { page: jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' }) }));
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'M', body: 'cap' })]);
        editEvent(client, 'M', 'cap', { media: true, attribute: THUMBNAIL });
        await flush();
        expect(rows).toEqual([
            expect.objectContaining({
                body: 'cap',
                metadata: { media: expect.objectContaining({ mimetype: 'image/png' }) },
            }),
        ]);
        expect(events('message.edited')).toEqual([]);
    });
    it('applies the edits of one message in the order they arrived', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        editEvent(client, 'A', 'v1');
        editEvent(client, 'A', 'v2');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows[0].body).toBe('v2');
        expect(hooked).toEqual(['v2']);
        expect(events('message.edited').map(m => m.body)).toEqual(['v1', 'v2']);
        expect(events('message.received').map(m => m.body)).toEqual(['v2']);
    });
    it('stores a reaction made during the contact lookup on the row once it is written', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        reactionEvent(client, 'A', '👍');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining({ body: 'orig', metadata: { reactions: { [CHAT]: '👍' } } })]);
        expect(events('message.reaction')).toHaveLength(1);
    });
    it('stores a reaction made during the media download beside the media', async () => {
        const media = download();
        client.emit('message', incoming('M', 'cap', { page: media.page }));
        await flush();
        reactionEvent(client, 'M', '❤️');
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual([
            expect.objectContaining({
                waMessageId: 'M',
                metadata: { media: expect.objectContaining({ mimetype: 'image/png' }), reactions: { [CHAT]: '❤️' } },
            }),
        ]);
    });
    it('stores a reaction beside the edit that reached the message before it', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        editEvent(client, 'A', 'fixed');
        reactionEvent(client, 'A', '👍');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([
            expect.objectContaining({ body: 'fixed', metadata: { edited: true, reactions: { [CHAT]: '👍' } } }),
        ]);
    });
    it('leaves no content of a message edited and then deleted during its contact lookup', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        editEvent(client, 'A', 'fixed');
        revokeEvent(client, 'A');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual(deletedRows('A'));
        expect(hooked).toEqual([]);
        expect(events('message.received')).toEqual([]);
    });
    it('leaves no content of an own send deleted for everyone during its media download, and announces none', async () => {
        const media = download();
        client.emit('message_create', incoming('S', 'sent', { page: media.page, fromMe: true }));
        await flush();
        revokeEvent(client, 'S', { fromMe: true });
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual(deletedRows('S'));
        expect(hooked).toEqual([]);
        expect(events('message.sent')).toEqual([]);
    });
    // The REST send stored its row before the echo came, so the delete has a row to clear on both wirings.
    it('clears the row a REST send stored when its echo is deleted during its media download', async () => {
        rows.push({
            sessionId: 's1',
            waMessageId: 'S',
            chatId: CHAT,
            direction: 'outgoing',
            type: 'image',
            body: 'sent',
            metadata: { media: { mimetype: 'image/png', data: 'QUJD' } },
        });
        const media = download();
        client.emit('message_create', incoming('S', 'sent', { page: media.page, fromMe: true }));
        await flush();
        revokeEvent(client, 'S', { fromMe: true });
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', body: '', type: 'revoked', metadata: null })]);
        expect(hooked).toEqual([]);
        expect(events('message.sent')).toEqual([]);
    });
    it('stores an own send edited during its media download marked edited, and announces the edited text', async () => {
        const media = download();
        client.emit('message_create', incoming('S', 'sent', { page: media.page, fromMe: true }));
        await flush();
        editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', body: 'sent again' })]);
        expect(rows[0].metadata.edited).toBe(true);
        expect(hooked).toEqual(['sent again']);
        expect(events('message.sent')).toEqual([expect.objectContaining({ body: 'sent again', edited: true })]);
    });
    // An edit that repeats the text the message carries changes nothing: it is announced, and leaves no mark.
    it('announces an edit that repeats the text during the contact lookup, and does not mark the message edited', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'same', { contact: contact.promise }));
        await flush();
        editEvent(client, 'A', 'same');
        await flush();
        expect(events('message.edited')).toHaveLength(1);
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'same' })]);
        expect(rows[0].metadata ?? {}).not.toHaveProperty('edited');
        expect(events('message.received')).toHaveLength(1);
        expect(events('message.received')[0]).not.toHaveProperty('edited');
    });
    // The hook of message:received can run for a while, and the row is written when it returns.
    it('announces an edit that repeats the text while the hook runs, and does not mark the message edited', async () => {
        const hook = (0, inbound_room_1.deferred)();
        hookGate = hook.promise;
        client.emit('message', incoming('A', 'same'));
        await flush();
        editEvent(client, 'A', 'same');
        await flush();
        hook.resolve();
        await flush();
        expect(events('message.edited')).toHaveLength(1);
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'same' })]);
        expect(rows[0].metadata ?? {}).not.toHaveProperty('edited');
        expect(events('message.received')).toHaveLength(1);
        expect(events('message.received')[0]).not.toHaveProperty('edited');
    });
    it('stores an edit that changes the text while the hook runs, marked edited', async () => {
        const hook = (0, inbound_room_1.deferred)();
        hookGate = hook.promise;
        client.emit('message', incoming('A', 'orig'));
        await flush();
        editEvent(client, 'A', 'fixed');
        await flush();
        hook.resolve();
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'fixed', metadata: { edited: true } })]);
        expect(events('message.received')).toEqual([expect.objectContaining({ body: 'fixed', edited: true })]);
    });
    it('announces a message edited and then deleted for me while the hook runs as deleted, without the mark', async () => {
        const hook = (0, inbound_room_1.deferred)();
        hookGate = hook.promise;
        client.emit('message', incoming('A', 'orig'));
        await flush();
        editEvent(client, 'A', 'fixed');
        await flush();
        const deleted = projector.recordRevoke('s1', 'A', { kind: 'revoke', chatId: CHAT });
        hook.resolve();
        await deleted;
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: '', type: 'revoked', metadata: null })]);
        expect(events('message.received')).toEqual([expect.objectContaining({ body: '', type: 'revoked' })]);
        expect(events('message.received')[0]).not.toHaveProperty('edited');
    });
    it.each([
        ['before', true],
        ['after', false],
    ])('stores and announces a message decrypted in place unedited, its change raised %s it', async (_, changeFirst) => {
        const contact = (0, inbound_room_1.deferred)();
        ciphertextEvent(client, 'A');
        if (changeFirst)
            editEvent(client, 'A', 'hello');
        client.emit('message', incoming('A', 'hello', { contact: contact.promise }));
        if (!changeFirst)
            editEvent(client, 'A', 'hello');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'hello' })]);
        expect(rows[0].metadata ?? {}).not.toHaveProperty('edited');
        expect(events('message.received')).toEqual([expect.objectContaining({ body: 'hello' })]);
        expect(events('message.received')[0]).not.toHaveProperty('edited');
        expect(events('message.edited')).toEqual([]);
    });
    // Past the changes kept for one message they are delivered at once, before the message is handed over.
    it('marks a message edited more times during its contact lookup than are kept for it', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        for (let i = 1; i <= 65; i++)
            editEvent(client, 'A', `v${i}`);
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'v65', metadata: { edited: true } })]);
        expect(events('message.received')).toEqual([expect.objectContaining({ body: 'v65', edited: true })]);
    });
    // Its edits went out as message.edited, so it was edited, though the last one restored the text it arrived with.
    it.each([
        ['within the changes kept for it', 1],
        ['past the changes kept for it', 64],
    ])('marks a message edited and then restored to its text during its contact lookup, %s', async (_, edits) => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        for (let i = 1; i <= edits; i++)
            editEvent(client, 'A', `v${i}`);
        editEvent(client, 'A', 'orig');
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'orig', metadata: { edited: true } })]);
        expect(events('message.received')).toEqual([expect.objectContaining({ body: 'orig', edited: true })]);
        expect(events('message.edited')).toHaveLength(edits + 1);
    });
    // whatsapp-web.js builds a repeat delivery from the message as it is now, so one raised after an edit carries the
    // edited text, and its lookups can end before those of the first delivery.
    it.each([
        ['the edited text', 'v1'],
        ['the text the message arrived with', 'orig'],
    ])('marks an edit made before a repeat delivery carrying %s is handed over first', async (_, repeated) => {
        const first = (0, inbound_room_1.deferred)();
        const repeat = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: first.promise }));
        await flush();
        editEvent(client, 'A', 'v1');
        await flush();
        client.emit('message', incoming('A', repeated, { contact: repeat.promise }));
        await flush();
        repeat.resolve(null);
        await flush();
        first.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'v1', metadata: { edited: true } })]);
        expect(events('message.received')).toEqual([expect.objectContaining({ body: 'v1', edited: true })]);
    });
    // An own message delivered again loses its insert to the row stored first, which an edit may have marked since.
    const own = (id, body) => incoming(id, body, { fromMe: true });
    const sentMarks = () => events('message.sent').map(m => m.edited);
    it('announces an own message delivered again after its edit was stored with the mark', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', body: 'e0', metadata: { edited: true } })]);
        client.emit('message_create', own('S', 'e0'));
        await flush();
        expect(events('message.sent')).toEqual([
            expect.objectContaining({ body: 'orig' }),
            expect.objectContaining({ body: 'e0', edited: true }),
        ]);
        expect(events('message.sent')[0]).not.toHaveProperty('edited');
    });
    it('announces an own message delivered again while its edit is written after that edit, with the mark', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        const write = (0, inbound_room_1.deferred)();
        holdWrite = patch => (patch.body === 'e0' ? write.promise : undefined);
        editEvent(client, 'S', 'e0', { fromMe: true });
        client.emit('message_create', own('S', 'e0'));
        await flush();
        write.resolve();
        await flush();
        const announced = dispatch.mock.calls
            .filter(c => c[1] === 'message.sent' || c[1] === 'message.edited')
            .map(c => `${c[1]} ${String(c[2].body)}${c[2].edited ? ' edited' : ''}`);
        expect(announced).toEqual(['message.sent orig', 'message.edited e0', 'message.sent e0 edited']);
    });
    // A send made through the API stores its row before its echo comes, so the echo loses its insert.
    it('announces the echo of a send the API stored unmarked after checking its tombstone', async () => {
        rows.push({ sessionId: 's1', waMessageId: 'S', chatId: CHAT, direction: 'outgoing', type: 'text', body: 'sent' });
        client.emit('message_create', own('S', 'sent'));
        await flush();
        expect(events('message.sent')).toEqual([expect.objectContaining({ body: 'sent' })]);
        expect(events('message.sent')[0]).not.toHaveProperty('edited');
        expect(findOne).toHaveBeenCalledTimes(1);
        expect(findOne).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 's1', waMessageId: 'S', type: 'revoked' } }));
    });
    it('announces an own send edited during its media download with the mark each time it is delivered', async () => {
        const media = download();
        client.emit('message_create', incoming('S', 'sent', { page: media.page, fromMe: true }));
        await flush();
        editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
        await flush();
        media.finish();
        await flush();
        const page = jest.fn().mockResolvedValue({ mimetype: 'image/png', data: 'QUJD' });
        client.emit('message_create', incoming('S', 'sent again', { page, fromMe: true }));
        await flush();
        expect(events('message.sent').map(m => [m.body, m.edited])).toEqual([
            ['sent again', true],
            ['sent again', true],
        ]);
    });
    it('announces an own message delivered again after its edit and its delete without the mark', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        revokeEvent(client, 'S', { fromMe: true });
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', type: 'revoked', metadata: null })]);
        client.emit('message_create', { ...own('S', ''), type: 'revoked' });
        await flush();
        expect(sentMarks()).toEqual([undefined, undefined]);
        expect(events('message.sent')[1]).not.toHaveProperty('edited');
    });
    // A delete for me raises no revoke event: the REST delete alone takes the message back.
    it('announces an own message delivered again while its edit is written and deleted for me, without the mark', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        const write = (0, inbound_room_1.deferred)();
        holdWrite = patch => (patch.body === 'e1' ? write.promise : undefined);
        editEvent(client, 'S', 'e1', { fromMe: true });
        client.emit('message_create', own('S', 'e1'));
        await flush();
        const deleted = projector.recordRevoke('s1', 'S', { kind: 'revoke', chatId: CHAT });
        await flush();
        write.resolve();
        await deleted;
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', body: '', type: 'revoked', metadata: null })]);
        expect(events('message.sent')).toEqual([
            expect.objectContaining({ body: 'orig', type: 'text' }),
            expect.objectContaining({ body: '', type: 'revoked' }),
        ]);
        expect(events('message.sent')[1]).not.toHaveProperty('edited');
    });
    it('announces an own message delivered again as deleted without the mark its row still has', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        client.emit('message_create', { ...own('S', ''), type: 'revoked' });
        await flush();
        expect(events('message.sent')).toEqual([
            expect.objectContaining({ body: 'orig', type: 'text' }),
            expect.objectContaining({ body: '', type: 'revoked' }),
        ]);
        expect(events('message.sent')[1]).not.toHaveProperty('edited');
    });
    // Its commit waits behind an earlier message of the chat, whose hook runs meanwhile.
    it('announces an own message delivered again as deleted while its edit waits with it, without the mark', async () => {
        const hook = (0, inbound_room_1.deferred)();
        hookGate = hook.promise;
        client.emit('message', incoming('P', 'earlier'));
        await flush();
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        client.emit('message_create', { ...own('S', ''), type: 'revoked' });
        await flush();
        hook.resolve();
        await flush();
        expect(events('message.sent')).toEqual([
            expect.objectContaining({ body: '', type: 'revoked' }),
            expect.objectContaining({ body: '', type: 'revoked' }),
        ]);
        expect(events('message.sent')[1]).not.toHaveProperty('edited');
        // The message:sent hook of the delivery that came deleted is given no text either.
        expect(hooked[hooked.length - 1]).toBe('');
    });
    it('announces an own message delivered again after its delete and an API edit of it without the mark', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        revokeEvent(client, 'S', { fromMe: true });
        await flush();
        await projector.recordOutboundMessageEdit('s1', 'S', 'e0', { kind: 'edit', chatId: CHAT, fromMe: true });
        client.emit('message_create', { ...own('S', ''), type: 'revoked' });
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'S', type: 'revoked', metadata: null })]);
        expect(sentMarks()).toEqual([undefined, undefined]);
    });
    // whatsapp-web.js raises message and message_create for a message added to WhatsApp Web already deleted, with no
    // revoke event: such a delivery takes the message back as the revoke would, and lends nothing of its content.
    const deletedRow = (id) => ({ waMessageId: id, body: '', type: 'revoked', metadata: null });
    const deletedDelivery = (id, fromMe = false) => ({ ...incoming(id, '', { fromMe }), type: 'revoked' });
    it('takes an earlier queued own delivery back when a later one recognizes its stored tombstone', async () => {
        const hook = (0, inbound_room_1.deferred)();
        hookGate = hook.promise;
        client.emit('message', incoming('P', 'earlier'));
        await flush();
        client.emit('message_create', own('S', 'original text'));
        await flush();
        rows.push({ sessionId: 's1', chatId: CHAT, direction: 'outgoing', ...deletedRow('S') });
        client.emit('message_create', own('S', 'stale duplicate'));
        await flush();
        hook.resolve();
        await flush();
        expect(events('message.sent')).toHaveLength(2);
        for (const sent of events('message.sent'))
            expect(sent).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
    });
    it.each([false, true])('hooks a later content delivery of a message delivered deleted with no content, own=%s', async (fromMe) => {
        const event = fromMe ? 'message_create' : 'message';
        client.emit(event, deletedDelivery('A', fromMe));
        await flush();
        client.emit(event, incoming('A', 'stale text', { fromMe }));
        await flush();
        expect(hooked).toEqual(['', '']);
        expect(rows).toEqual([expect.objectContaining(deletedRow('A'))]);
        expect(dispatchedAfterDeleted()).toEqual([]);
    });
    it.each([false, true])('hooks a content delivery of a stored tombstone with no content after other messages, own=%s', async (fromMe) => {
        // These rows outlive the projector that stored them, and any bounded record of recent messages.
        for (let n = 0; n <= 501; n++)
            rows.push({
                sessionId: 's1',
                chatId: CHAT,
                direction: fromMe ? 'outgoing' : 'incoming',
                ...deletedRow(`A${n}`),
            });
        client.emit(fromMe ? 'message_create' : 'message', incoming('A0', 'stale text', { fromMe }));
        await flush();
        expect(hooked).toEqual(['']);
        expect(rows[0]).toEqual(expect.objectContaining(deletedRow('A0')));
        expect(contentAnnounced()).toEqual([]);
    });
    it.each([
        ['chat', CHAT, '628999@c.us', 'incoming', undefined, undefined],
        ['direction', CHAT, CHAT, 'outgoing', undefined, undefined],
        ['author', '120363000@g.us', '120363000@g.us', 'incoming', '628999@c.us', '628111@c.us'],
    ])('keeps the content of a delivery whose %s differs from the stored tombstone', async (_, chatId, storedChat, direction, storedAuthor, author) => {
        rows.push({
            sessionId: 's1',
            waMessageId: 'A',
            chatId: storedChat,
            direction,
            author: storedAuthor,
            type: 'revoked',
            body: '',
        });
        projector.handleInboundMessage('s1', engine, {
            id: 'A',
            chatId,
            from: chatId,
            to: SELF,
            fromMe: false,
            isGroup: chatId.endsWith('@g.us'),
            kind: 'individual',
            body: 'another message',
            type: 'text',
            timestamp: 1_700_000_000,
            author,
        });
        await flush();
        expect(hooked).toEqual(['another message']);
        expect(rows[0].body).toBe('');
    });
    it.each([false, true])('keeps a real delivery when the tombstone lookup is unavailable, own=%s', async (fromMe) => {
        findOne.mockRejectedValueOnce(new Error('database unavailable'));
        client.emit(fromMe ? 'message_create' : 'message', incoming('A', 'real message', { fromMe }));
        await flush();
        expect(hooked).toEqual(['real message']);
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'real message', type: 'text' })]);
        expect(contentAnnounced()).toHaveLength(1);
    });
    it.each([
        [CHAT, ''],
        ['628999@c.us', 'kept'],
    ])('checks content still being read against a deleted delivery in %s', async (chatId, expected) => {
        const read = (0, inbound_room_1.deferred)();
        findOne.mockReturnValueOnce(read.promise);
        const original = {
            id: 'A',
            chatId: CHAT,
            from: CHAT,
            to: SELF,
            fromMe: false,
            isGroup: false,
            kind: 'individual',
            body: 'kept',
            type: 'text',
            timestamp: 1_700_000_000,
        };
        projector.handleInboundMessage('s1', engine, original);
        projector.handleInboundMessage('s1', engine, {
            ...original,
            chatId,
            from: chatId,
            type: 'revoked',
            body: '',
        });
        await flush();
        read.resolve(null);
        await flush();
        expect(hooked.at(-1)).toBe(expected);
    });
    it('keeps another chat delivery separate from a deleted message still in its hook', async () => {
        const hook = (0, inbound_room_1.deferred)();
        hookGate = hook.promise;
        const deleted = {
            id: 'A',
            chatId: CHAT,
            from: CHAT,
            to: SELF,
            fromMe: false,
            isGroup: false,
            kind: 'individual',
            body: '',
            type: 'revoked',
            timestamp: 1_700_000_000,
        };
        projector.handleInboundMessage('s1', engine, deleted);
        await flush();
        projector.handleInboundMessage('s1', engine, {
            ...deleted,
            chatId: '628999@c.us',
            from: '628999@c.us',
            type: 'text',
            body: 'another message',
        });
        await flush();
        expect(hooked).toEqual(['', 'another message']);
        hook.resolve();
        await flush();
    });
    it.each([false, true])('runs no hook after its engine retired during the tombstone lookup, own=%s', async (fromMe) => {
        const read = (0, inbound_room_1.deferred)();
        findOne.mockReturnValueOnce(read.promise);
        client.emit(fromMe ? 'message_create' : 'message', incoming('A', 'late message', { fromMe }));
        await flush();
        engines.delete('s1');
        read.resolve(null);
        await flush();
        expect(hooked).toEqual([]);
        expect(rows).toEqual([]);
        expect(contentAnnounced()).toEqual([]);
    });
    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ])('lends no unchecked quote, then the checked body, deleted=%s own=%s', async (deleted, fromMe) => {
        const row = { sessionId: 's1', chatId: CHAT, direction: fromMe ? 'outgoing' : 'incoming', ...deletedRow('A') };
        if (deleted)
            rows.push(row);
        const read = (0, inbound_room_1.deferred)();
        findOne.mockReturnValueOnce(read.promise);
        let quoted;
        rewrite = data => {
            quoted = projector.inFlightInbound('s1', 'A');
            return data;
        };
        client.emit(fromMe ? 'message_create' : 'message', incoming('A', 'original text', { fromMe }));
        await flush();
        expect(projector.inFlightInbound('s1', 'A')).toBeUndefined();
        read.resolve(deleted ? row : null);
        await flush();
        expect(quoted).toEqual({ chatId: CHAT, body: deleted ? '' : 'original text' });
    });
    it('stores an own message stored and edited, then delivered again as deleted, as deleted', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        client.emit('message_create', deletedDelivery('S', true));
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('S'))]);
        expect(persisted.at(-1)).toEqual(expect.objectContaining(deletedRow('S')));
        expect(events('message.sent')).toEqual([
            expect.objectContaining({ body: 'orig', type: 'text' }),
            expect.objectContaining({ body: '', type: 'revoked' }),
        ]);
    });
    it('stores a message stored, then delivered again as deleted, as deleted', async () => {
        client.emit('message', incoming('A', 'secret'));
        await flush();
        client.emit('message', deletedDelivery('A'));
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('A'))]);
        expect(persisted.at(-1)).toEqual(expect.objectContaining(deletedRow('A')));
    });
    it.each([
        ['a message', false],
        ['an own message', true],
    ])('keeps a message stored in another chat under the id of %s delivered deleted', async (_, fromMe) => {
        rows.push({
            sessionId: 's1',
            waMessageId: 'A',
            chatId: '628999@c.us',
            direction: fromMe ? 'outgoing' : 'incoming',
            type: 'text',
            body: 'kept',
        });
        client.emit(fromMe ? 'message_create' : 'message', deletedDelivery('A', fromMe));
        await flush();
        expect(rows).toEqual([expect.objectContaining({ waMessageId: 'A', body: 'kept', type: 'text' })]);
    });
    // The first delivery's row is lost to a failed insert: the one that came deleted inserts it, with an edit held.
    it.each([
        ['an own message', true],
        ['a message', false],
    ])('stores %s delivered again as deleted while its edit waits as deleted, the first insert failed', async (_, fromMe) => {
        const hook = (0, inbound_room_1.deferred)();
        hookGate = hook.promise;
        client.emit('message', incoming('P', 'earlier'));
        await flush();
        let inserts = 0;
        failInsert = row => row.waMessageId === 'S' && ++inserts === 1;
        client.emit(fromMe ? 'message_create' : 'message', incoming('S', 'orig', { fromMe }));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe });
        await flush();
        client.emit(fromMe ? 'message_create' : 'message', deletedDelivery('S', fromMe));
        await flush();
        hook.resolve();
        await flush();
        expect(rows.filter(r => r.waMessageId === 'S')).toEqual([expect.objectContaining(deletedRow('S'))]);
        expect(persisted.filter(r => r.waMessageId === 'S')).toEqual([expect.objectContaining(deletedRow('S'))]);
    });
    it('stores a message delivered deleted as deleted whatever its hook returns', async () => {
        rewrite = data => ({ ...data, body: `${String(data.body)} signed` });
        client.emit('message_create', deletedDelivery('S', true));
        client.emit('message', deletedDelivery('A'));
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('S')), expect.objectContaining(deletedRow('A'))]);
        expect(persisted).toEqual([expect.objectContaining(deletedRow('S')), expect.objectContaining(deletedRow('A'))]);
    });
    const contentAnnounced = () => dispatch.mock.calls
        .filter(c => c[1] === 'message.sent' || c[1] === 'message.received')
        .map(c => c[2])
        .filter(m => m.type !== 'revoked');
    const dispatchedAfterDeleted = () => {
        const calls = dispatch.mock.calls.filter(c => ['message.sent', 'message.received', 'message.revoked'].includes(c[1]));
        const first = calls.findIndex(c => c[2].type === 'revoked');
        if (first < 0)
            return [];
        return calls.slice(first + 1).flatMap(c => (c[2].type === 'revoked' ? [] : [`${c[1]} ${String(c[2].body)}`]));
    };
    it('stores an own send delivered again as deleted during its media download as deleted, hooked with no text', async () => {
        const media = download();
        client.emit('message_create', incoming('S', 'orig', { page: media.page, fromMe: true }));
        await flush();
        editEvent(client, 'S', 'e0', { media: true, fromMe: true });
        await flush();
        client.emit('message_create', deletedDelivery('S', true));
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('S'))]);
        expect(persisted.filter(r => r.waMessageId === 'S').at(-1)).toEqual(expect.objectContaining(deletedRow('S')));
        expect(hooked.at(-1)).toBe('');
        expect(events('message.sent').at(-1)).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
        expect(dispatchedAfterDeleted()).toEqual([]);
    });
    it('stores a message delivered again as deleted during its contact lookup as deleted, hooked with no text', async () => {
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        await flush();
        editEvent(client, 'A', 'e0');
        await flush();
        client.emit('message', deletedDelivery('A'));
        await flush();
        contact.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('A'))]);
        expect(persisted.filter(r => r.waMessageId === 'A').at(-1)).toEqual(expect.objectContaining(deletedRow('A')));
        expect(hooked.at(-1)).toBe('');
        expect(dispatchedAfterDeleted()).toEqual([]);
    });
    it('announces nothing of an own media send after it was delivered again as deleted and deleted for everyone', async () => {
        const media = download();
        client.emit('message_create', incoming('S', 'orig', { page: media.page, fromMe: true }));
        await flush();
        client.emit('message_create', deletedDelivery('S', true));
        await flush();
        revokeEvent(client, 'S', { fromMe: true });
        await flush();
        media.finish();
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('S'))]);
        expect(contentAnnounced()).toEqual([]);
        expect(hooked).not.toContain('orig');
        expect(events('message.revoked')).toHaveLength(1);
    });
    // Whatever an engine hands over for a message that came deleted, none of it reaches the hooks.
    it('hooks a message delivered deleted with no content, whatever the engine hands over', async () => {
        const delivered = (id, fromMe) => ({
            id,
            chatId: CHAT,
            from: fromMe ? SELF : CHAT,
            to: fromMe ? CHAT : SELF,
            fromMe,
            isGroup: false,
            type: 'revoked',
            body: 'left over',
            timestamp: 1_700_000_000,
            media: { mimetype: 'image/png', data: 'QUJD' },
        });
        const seen = [];
        rewrite = data => (seen.push({ ...data }), data);
        projector.handleOwnSendEcho('s1', engine, delivered('S', true));
        projector.handleInboundMessage('s1', engine, delivered('A', false));
        await flush();
        expect(seen).toHaveLength(2);
        for (const data of seen) {
            expect(data).toEqual(expect.objectContaining({ body: '', type: 'revoked' }));
            expect(data).not.toHaveProperty('media');
        }
    });
    // Two deliveries of one message share what reaches it: one that ends first must not forget it for the other.
    it('announces nothing of an own media send delivered twice after it was deleted between their hand-overs', async () => {
        const first = download();
        const second = download();
        client.emit('message_create', incoming('S', 'orig', { page: first.page, fromMe: true }));
        await flush();
        client.emit('message_create', incoming('S', 'orig', { page: second.page, fromMe: true }));
        await flush();
        first.finish();
        await flush();
        revokeEvent(client, 'S', { fromMe: true });
        await flush();
        second.finish();
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('S'))]);
        expect(dispatchedAfterDeleted()).toEqual([]);
        expect(hooked.filter(body => body === 'orig').length).toBeLessThanOrEqual(1);
    });
    it('hooks nothing of a message delivered twice after it was deleted between their hand-overs', async () => {
        const first = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'secret', { contact: first.promise }));
        await flush();
        client.emit('message', incoming('A', 'secret'));
        await flush();
        revokeEvent(client, 'A');
        await flush();
        first.resolve(null);
        await flush();
        expect(rows).toEqual([expect.objectContaining(deletedRow('A'))]);
        expect(hooked.filter(body => body === 'secret').length).toBeLessThanOrEqual(1);
    });
    it('announces an own message stored again after its row was removed without the mark of that row', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        // The chat was cleared: its rows are removed, and the message can be delivered again.
        rows.length = 0;
        client.emit('message_create', own('S', 'e0'));
        await flush();
        client.emit('message_create', own('S', 'e0'));
        await flush();
        expect(sentMarks()).toEqual([undefined, undefined, undefined]);
    });
    it('forgets the marks of a session once it has no engine', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        engines.delete('s1');
        engines.set('s1', engine);
        client.emit('message_create', own('S', 'e0'));
        await flush();
        expect(sentMarks()).toEqual([undefined, undefined]);
    });
    it('keeps the marks of a session whose engine was replaced', async () => {
        client.emit('message_create', own('S', 'orig'));
        await flush();
        editEvent(client, 'S', 'e0', { fromMe: true });
        await flush();
        engines.set('s1', {});
        engines.set('s1', engine);
        client.emit('message_create', own('S', 'e0'));
        await flush();
        expect(sentMarks()).toEqual([undefined, true]);
    });
    it('keeps the marks of 500 messages of a session, forgetting the one marked first', async () => {
        const ids = Array.from({ length: 501 }, (_, i) => `S${i}`);
        for (const id of ids) {
            rows.push({ sessionId: 's1', waMessageId: id, chatId: CHAT, direction: 'outgoing', type: 'text', body: 'orig' });
            editEvent(client, id, 'e0', { fromMe: true });
        }
        await flush();
        client.emit('message_create', own('S0', 'e0'));
        client.emit('message_create', own('S1', 'e0'));
        client.emit('message_create', own('S500', 'e0'));
        await flush();
        expect(sentMarks()).toEqual([undefined, true, true]);
    });
});
describe('changes kept while whatsapp-web.js processes a message (adapter level)', () => {
    /** Calls of the engine callbacks in the order they were made, with the registration under test. */
    const wire = (extra = {}, media = Promise.resolve(undefined)) => {
        const order = [];
        // The body of each message handed over, in order, and the text it arrived with where an edit was applied.
        const bodies = [];
        const arrivals = [];
        const callbacks = {
            onMessage: (m) => {
                order.push(`message ${m.id}`);
                bodies.push(m.body);
                arrivals.push(m.originalBody);
            },
            onMessageCreate: (m) => {
                order.push(`own ${m.id}`);
                bodies.push(m.body);
                arrivals.push(m.originalBody);
            },
            onMessageEdited: (e) => {
                order.push(`edit ${e.messageId} ${e.body}`);
            },
            onMessageRevoked: (r) => {
                order.push(`revoke ${r.revokedId ?? r.id}`);
            },
            onMessageReaction: (r) => {
                order.push(`react ${r.messageId} ${r.reaction}`);
            },
            ...extra,
        };
        const client = new events_1.EventEmitter();
        const host = {
            logger: (0, logger_service_1.createLogger)('wwebjs-message-changes.spec'),
            getCallbacks: () => callbacks,
            capInboundMediaFor: jest.fn(() => media),
        };
        (0, wwebjs_message_events_1.registerWwebjsMessageEvents)(client, host);
        return { client, order, bodies, arrivals, callbacks };
    };
    // The bounds of wwebjs-message-events.ts: changes kept per message, and messages tracked at once.
    const PER_MESSAGE = 64;
    const TRACKED = 5_000;
    it('hands a message over with its latest edit, and delivers what reached it right after, in order', async () => {
        const { client, order, bodies } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'A', 'fixed');
        reactionEvent(client, 'A', '👍');
        editEvent(client, 'A', 'fixed twice');
        await flush();
        expect(order).toEqual([]);
        contact.resolve(null);
        await flush();
        expect(order).toEqual(['message A', 'edit A fixed', 'react A 👍', 'edit A fixed twice']);
        expect(bodies).toEqual(['fixed twice']);
    });
    it('hands over the text a message arrived with beside the edit applied to it', async () => {
        const { client, bodies, arrivals } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'A', 'v1');
        editEvent(client, 'A', 'v2');
        contact.resolve(null);
        await flush();
        expect(bodies).toEqual(['v2']);
        expect(arrivals).toEqual(['orig']);
    });
    it('hands over no arrival text when no edit was applied', async () => {
        const { client, arrivals } = wire();
        const plain = (0, inbound_room_1.deferred)();
        const reacted = (0, inbound_room_1.deferred)();
        const repeated = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: plain.promise }));
        client.emit('message', incoming('B', 'orig', { contact: reacted.promise }));
        client.emit('message', incoming('C', 'orig', { contact: repeated.promise }));
        reactionEvent(client, 'B', '👍');
        editEvent(client, 'C', 'orig');
        editEvent(client, 'C', 'orig');
        plain.resolve(null);
        reacted.resolve(null);
        repeated.resolve(null);
        await flush();
        expect(arrivals).toEqual([undefined, undefined, undefined]);
    });
    it('hands over the text a message arrived with when its edits restored it, past the changes kept too', async () => {
        const { client, bodies, arrivals } = wire();
        const kept = (0, inbound_room_1.deferred)();
        const past = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: kept.promise }));
        client.emit('message', incoming('B', 'orig', { contact: past.promise }));
        editEvent(client, 'A', 'v1');
        editEvent(client, 'A', 'orig');
        for (let i = 1; i <= PER_MESSAGE; i++)
            editEvent(client, 'B', `v${i}`);
        editEvent(client, 'B', 'orig');
        kept.resolve(null);
        past.resolve(null);
        await flush();
        expect(bodies).toEqual(['orig', 'orig']);
        expect(arrivals).toEqual(['orig', 'orig']);
    });
    it('hands a repeat delivery that carries an edit over with the text the first delivery arrived with', async () => {
        const { client, bodies, arrivals } = wire();
        const first = (0, inbound_room_1.deferred)();
        const repeat = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: first.promise }));
        editEvent(client, 'A', 'v1');
        client.emit('message', incoming('A', 'v1', { contact: repeat.promise }));
        repeat.resolve(null);
        await flush();
        first.resolve(null);
        await flush();
        expect(bodies).toEqual(['v1', 'v1']);
        expect(arrivals).toEqual(['orig', 'orig']);
    });
    it('hands over the text an own send arrived with beside the edit applied to it', async () => {
        const download = (0, inbound_room_1.deferred)();
        const { client, bodies, arrivals } = wire({}, download.promise);
        client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
        editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
        download.resolve(undefined);
        await flush();
        expect(bodies).toEqual(['sent again']);
        expect(arrivals).toEqual(['sent']);
    });
    it('does not hand over a message deleted meanwhile, and delivers what reached it', async () => {
        const { client, order, bodies } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'A', 'fixed');
        reactionEvent(client, 'A', '👍');
        revokeEvent(client, 'A');
        await flush();
        expect(order).toEqual([]);
        contact.resolve(null);
        await flush();
        expect(order).toEqual(['edit A fixed', 'react A 👍', 'revoke A']);
        expect(bodies).toEqual([]);
    });
    it('does not hand over a message deleted after more changes than are kept', async () => {
        const { client, order, bodies } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        for (let i = 1; i <= PER_MESSAGE; i++)
            editEvent(client, 'A', `v${i}`);
        revokeEvent(client, 'A');
        expect(order).toHaveLength(PER_MESSAGE + 1);
        expect(order.at(-1)).toBe('revoke A');
        contact.resolve(null);
        await flush();
        expect(order).toHaveLength(PER_MESSAGE + 1);
        expect(bodies).toEqual([]);
    });
    it('delivers at once a delete that reaches a message already handed over', async () => {
        const { client, order } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        contact.resolve(null);
        await flush();
        revokeEvent(client, 'A');
        expect(order).toEqual(['message A', 'revoke A']);
    });
    it('delivers at once what reaches a message the session holds from its arrival', async () => {
        const ticket = {
            reserve: () => false,
            holdUntil: () => undefined,
            drop: () => undefined,
            revoked: false,
        };
        const { client, order, bodies } = wire({ admitInbound: () => ticket });
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'A', 'fixed');
        revokeEvent(client, 'A');
        expect(order).toEqual(['edit A fixed', 'revoke A']);
        contact.resolve(null);
        await flush();
        // The session applies them itself: the message goes over as it arrived.
        expect(order).toEqual(['edit A fixed', 'revoke A', 'message A']);
        expect(bodies).toEqual(['orig']);
    });
    it('delivers at once what reaches another message, and what reaches a message already handed over', async () => {
        const { client, order } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'Z', 'elsewhere');
        reactionEvent(client, 'Z', '👍');
        expect(order).toEqual(['edit Z elsewhere', 'react Z 👍']);
        contact.resolve(null);
        await flush();
        editEvent(client, 'A', 'late');
        reactionEvent(client, 'A', '👍');
        expect(order).toEqual(['edit Z elsewhere', 'react Z 👍', 'message A', 'edit A late', 'react A 👍']);
    });
    it('delivers at once what reaches a status post', async () => {
        const { client, order } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', { ...incoming('ST', 'story', { contact: contact.promise }), from: 'status@broadcast' });
        editEvent(client, 'ST', 'edited story');
        expect(order).toEqual(['edit ST edited story']);
        contact.resolve(null);
        await flush();
        expect(order).toEqual(['edit ST edited story', 'message ST']);
    });
    it('delivers an edit that repeats the text at once and keeps one that changes it', async () => {
        const { client, order, bodies } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'A', 'orig');
        editEvent(client, 'A', 'v1');
        editEvent(client, 'A', 'v1');
        editEvent(client, 'A', 'orig');
        expect(order).toEqual(['edit A orig', 'edit A v1']);
        contact.resolve(null);
        await flush();
        expect(order).toEqual(['edit A orig', 'edit A v1', 'message A', 'edit A v1', 'edit A orig']);
        expect(bodies).toEqual(['orig']);
    });
    it('forgets the message when its processing fails, after delivering what it kept', async () => {
        const { client, order } = wire({
            onMessage: () => {
                throw new Error('boom');
            },
        });
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'A', 'fixed');
        expect(order).toEqual([]);
        contact.resolve(null);
        await flush();
        expect(order).toEqual(['edit A fixed']);
        editEvent(client, 'A', 'later');
        expect(order).toEqual(['edit A fixed', 'edit A later']);
    });
    it('hands an own send over with its latest edit, and delivers what reached it right after', async () => {
        const download = (0, inbound_room_1.deferred)();
        const { client, order, bodies } = wire({}, download.promise);
        client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
        editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
        await flush();
        expect(order).toEqual([]);
        download.resolve(undefined);
        await flush();
        expect(order).toEqual(['own S', 'edit S sent again']);
        expect(bodies).toEqual(['sent again']);
    });
    it('does not hand over an own send deleted meanwhile, and delivers what reached it', async () => {
        const download = (0, inbound_room_1.deferred)();
        const { client, order, bodies } = wire({}, download.promise);
        client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
        editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
        revokeEvent(client, 'S', { fromMe: true });
        await flush();
        download.resolve(undefined);
        await flush();
        expect(order).toEqual(['edit S sent again', 'revoke S']);
        expect(bodies).toEqual([]);
    });
    it('forgets an own send when handing it over fails, after delivering what it kept', async () => {
        const download = (0, inbound_room_1.deferred)();
        const { client, order } = wire({
            onMessageCreate: () => {
                throw new Error('boom');
            },
        }, download.promise);
        client.emit('message_create', incoming('S', 'sent', { page: jest.fn(), fromMe: true }));
        editEvent(client, 'S', 'sent again', { media: true, fromMe: true });
        expect(order).toEqual([]);
        download.resolve(undefined);
        await flush();
        expect(order).toEqual(['edit S sent again']);
        editEvent(client, 'S', 'later', { media: true, fromMe: true });
        expect(order).toEqual(['edit S sent again', 'edit S later']);
    });
    it('delivers at once a reaction whose message id could not be read', async () => {
        const { client, order } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        client.emit('message_reaction', { msgId: {}, id: { remote: CHAT }, reaction: '👍', senderId: CHAT });
        expect(order).toEqual(['react  👍']);
        contact.resolve(null);
        await flush();
    });
    // An id that could not be read keys nothing: two such messages in flight must not share what is kept for either.
    it('hands over each of two messages whose id could not be read with its own text', async () => {
        const { client, order, bodies } = wire();
        const first = (0, inbound_room_1.deferred)();
        const second = (0, inbound_room_1.deferred)();
        client.emit('message', { ...incoming('x', 'first text', { contact: first.promise }), id: {} });
        client.emit('message', { ...incoming('x', 'second text', { contact: second.promise }), id: {} });
        editEvent(client, '', 'an edit of neither');
        expect(order).toEqual(['edit  an edit of neither']);
        second.resolve(null);
        first.resolve(null);
        await flush();
        expect(bodies).toEqual(['second text', 'first text']);
    });
    it('hands over neither delivery of an id that was deleted meanwhile', async () => {
        const { client, order, bodies } = wire();
        const first = (0, inbound_room_1.deferred)();
        const second = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: first.promise }));
        client.emit('message', incoming('A', 'orig', { contact: second.promise }));
        revokeEvent(client, 'A');
        second.resolve(null);
        await flush();
        first.resolve(null);
        await flush();
        revokeEvent(client, 'A');
        expect(order).toEqual(['revoke A', 'revoke A']);
        expect(bodies).toEqual([]);
    });
    it('shares what reached an id between two deliveries of it, and forgets the id after both', async () => {
        const { client, order } = wire();
        const first = (0, inbound_room_1.deferred)();
        const second = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: first.promise }));
        client.emit('message', incoming('A', 'orig', { contact: second.promise }));
        editEvent(client, 'A', 'fixed');
        expect(order).toEqual([]);
        second.resolve(null);
        await flush();
        expect(order).toEqual(['message A', 'edit A fixed']);
        first.resolve(null);
        await flush();
        editEvent(client, 'A', 'late');
        expect(order).toEqual(['message A', 'edit A fixed', 'message A', 'edit A late']);
    });
    it('hands a delivery that came deleted over with no text, and not the delivery still processed after it', async () => {
        const { client, order, bodies, arrivals } = wire();
        const first = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: first.promise }));
        editEvent(client, 'A', 'v1');
        client.emit('message', { ...incoming('A', ''), type: 'revoked' });
        await flush();
        expect(order).toEqual(['message A']);
        first.resolve(null);
        await flush();
        editEvent(client, 'A', 'late');
        expect(order).toEqual(['message A', 'edit A v1', 'edit A late']);
        expect(bodies).toEqual(['']);
        expect(arrivals).toEqual([undefined]);
    });
    it('delivers at once what reaches an id once one delivery of it ended, and hands the other over as it left it', async () => {
        const { client, order, bodies, arrivals } = wire();
        const first = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: first.promise }));
        client.emit('message', incoming('A', 'orig'));
        await flush();
        editEvent(client, 'A', 'v1');
        expect(order).toEqual(['message A', 'edit A v1']);
        first.resolve(null);
        await flush();
        expect(order).toEqual(['message A', 'edit A v1', 'message A']);
        expect(bodies).toEqual(['orig', 'v1']);
        expect(arrivals).toEqual([undefined, 'orig']);
    });
    it.each([
        ['the first', true],
        ['the repeat', false],
    ])('hands over no delivery of an id deleted after another delivery of it ended, %s ending first', async (_, firstEnds) => {
        const { client, order, bodies } = wire();
        const slow = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', firstEnds ? {} : { contact: slow.promise }));
        client.emit('message', incoming('A', 'orig', firstEnds ? { contact: slow.promise } : {}));
        await flush();
        revokeEvent(client, 'A');
        expect(order).toEqual(['message A', 'revoke A']);
        slow.resolve(null);
        await flush();
        revokeEvent(client, 'A');
        expect(order).toEqual(['message A', 'revoke A', 'revoke A']);
        expect(bodies).toEqual(['orig']);
    });
    it('delivers the rest when one kept change fails', async () => {
        const { client, order } = wire({
            onMessageEdited: () => {
                throw new Error('boom');
            },
        });
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        editEvent(client, 'A', 'fixed');
        reactionEvent(client, 'A', '👍');
        contact.resolve(null);
        await flush();
        expect(order).toEqual(['message A', 'react A 👍']);
    });
    it('keeps a bounded number of changes for one message, delivering the rest in order at once', async () => {
        const { client, order } = wire();
        const contact = (0, inbound_room_1.deferred)();
        client.emit('message', incoming('A', 'orig', { contact: contact.promise }));
        for (let i = 1; i <= PER_MESSAGE + 6; i++)
            editEvent(client, 'A', `v${i}`);
        expect(order).toHaveLength(PER_MESSAGE + 1);
        contact.resolve(null);
        await flush();
        const edits = order.filter(entry => entry.startsWith('edit'));
        expect(edits).toEqual(Array.from({ length: PER_MESSAGE + 6 }, (_, i) => `edit A v${i + 1}`));
        expect(order.indexOf('message A')).toBe(PER_MESSAGE + 1);
    });
    it('tracks a bounded number of messages, delivering what reaches the others at once', async () => {
        const { client, order } = wire();
        const contact = (0, inbound_room_1.deferred)();
        for (let i = 0; i < TRACKED; i++)
            client.emit('message', incoming(`m${i}`, 'orig', { contact: contact.promise }));
        client.emit('message', incoming('over', 'orig', { contact: contact.promise }));
        editEvent(client, 'm0', 'kept');
        editEvent(client, 'over', 'at once');
        expect(order).toEqual(['edit over at once']);
        contact.resolve(null);
        await flush();
        expect(order[0]).toBe('edit over at once');
        expect(order.indexOf('edit m0 kept')).toBeGreaterThan(order.indexOf('message m0'));
        expect(order).toHaveLength(TRACKED + 3);
    });
    // WhatsApp Web decrypts such a message in place: whatsapp-web.js delivers it from the update that fills in its text,
    // which raises message_edit too, before or after the message.
    it.each([
        ['before', true],
        ['after', false],
    ])('delivers no edit for the change that decrypts a message, %s the message', async (_, changeFirst) => {
        const { client, order, bodies } = wire();
        ciphertextEvent(client, 'A');
        if (changeFirst)
            editEvent(client, 'A', 'hello');
        client.emit('message', incoming('A', 'hello'));
        if (!changeFirst)
            editEvent(client, 'A', 'hello');
        await flush();
        expect(order).toEqual(['message A']);
        expect(bodies).toEqual(['hello']);
    });
    // A captioned media message decrypted in place gets its thumbnail too, a change of its body attribute, which is
    // no edit and must not stand in for the change of its caption.
    it.each([
        ['its thumbnail changing first', true],
        ['its caption changing first', false],
    ])('delivers no edit for the decryption of a captioned media message, %s', async (_, thumbnailFirst) => {
        const { client, order } = wire();
        ciphertextEvent(client, 'M');
        client.emit('message', incoming('M', 'cap', { page: jest.fn() }));
        if (thumbnailFirst)
            editEvent(client, 'M', 'cap', { media: true, attribute: THUMBNAIL });
        editEvent(client, 'M', 'cap', { media: true });
        if (!thumbnailFirst)
            editEvent(client, 'M', 'cap', { media: true, attribute: THUMBNAIL });
        await flush();
        expect(order).toEqual(['message M']);
    });
    it.each([
        ['after the change that decrypted it', true],
        ['when its decryption raised no change', false],
    ])('delivers the edits of a message decrypted in place %s, a restore included', async (_, decryptChange) => {
        const { client, order } = wire();
        ciphertextEvent(client, 'A');
        client.emit('message', incoming('A', 'hello'));
        if (decryptChange)
            editEvent(client, 'A', 'hello');
        await flush();
        editEvent(client, 'A', 'v1');
        editEvent(client, 'A', 'hello');
        expect(order).toEqual(['message A', 'edit A v1', 'edit A hello']);
    });
    it('delivers the edits of an own message decrypted in place when its decryption raised no change', async () => {
        const { client, order } = wire();
        ciphertextEvent(client, 'S');
        client.emit('message_create', incoming('S', 'hello', { fromMe: true }));
        await flush();
        editEvent(client, 'S', 'v1', { fromMe: true });
        expect(order).toEqual(['own S', 'edit S v1']);
    });
    it('delivers the edits of a message whatsapp-web.js does not deliver once decrypted', () => {
        const { client, order } = wire();
        ciphertextEvent(client, 'A', 'bot_unavailable_fanout');
        editEvent(client, 'A', 'hello');
        expect(order).toEqual(['edit A hello']);
    });
    it('remembers a bounded number of messages awaiting their decryption, forgetting the oldest first', () => {
        const { client, order } = wire();
        for (let i = 0; i <= TRACKED; i++)
            ciphertextEvent(client, `c${i}`);
        editEvent(client, 'c0', 'forgotten');
        editEvent(client, `c${TRACKED}`, 'decrypted');
        expect(order).toEqual(['edit c0 forgotten']);
    });
    it('keeps no text of the messages it remembers as decrypted in place', async () => {
        // Process-wide: later suites in this jest worker also see a global gc in new vm contexts.
        (0, v8_1.setFlagsFromString)('--expose-gc');
        const gc = (0, vm_1.runInNewContext)('gc');
        const { client } = wire({ onMessage: () => undefined });
        const MESSAGES = 256;
        const LONGEST_TEXT = 65_536;
        gc();
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < MESSAGES; i++) {
            ciphertextEvent(client, `c${i}`);
            client.emit('message', {
                ...incoming(`c${i}`, Buffer.alloc(LONGEST_TEXT, 97 + (i % 26)).toString('latin1')),
                getContact: () => Promise.resolve(null),
            });
        }
        await flush();
        gc();
        expect(process.memoryUsage().heapUsed - before).toBeLessThan((MESSAGES * LONGEST_TEXT) / 4);
    });
});
describe('stored tombstones on a shared SQLite connection', () => {
    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ])('waits for another transaction before trusting the row, commit=%s own=%s', async (commit, fromMe) => {
        const db = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [message_entity_1.Message], synchronize: true });
        await db.initialize();
        const repository = db.getRepository(message_entity_1.Message);
        const runner = db.createQueryRunner();
        const engines = new engine_registry_service_1.EngineRegistry();
        const engine = {};
        engines.set('s1', engine);
        const seen = [];
        const message = {
            id: 'A',
            chatId: CHAT,
            from: fromMe ? SELF : CHAT,
            to: fromMe ? CHAT : SELF,
            fromMe,
            isGroup: false,
            kind: 'individual',
            type: 'text',
            body: 'original text',
            timestamp: 1_700_000_000,
        };
        const projector = new message_projector_service_1.MessageProjector(repository, { update: jest.fn().mockResolvedValue({ affected: 1 }) }, engines, new Proxy({}, { get: () => jest.fn() }), { dispatch: jest.fn().mockResolvedValue(undefined) }, {
            execute: jest.fn((event, data) => {
                if (event === 'message:sent' || event === 'message:received')
                    seen.push(data.body);
                return Promise.resolve({ continue: true, data });
            }),
        }, { ingest: jest.fn() }, { resolveSenderPhone: jest.fn().mockResolvedValue(null) });
        try {
            await repository.insert({
                sessionId: 's1',
                waMessageId: 'A',
                chatId: CHAT,
                from: message.from,
                to: message.to,
                direction: fromMe ? message_entity_1.MessageDirection.OUTGOING : message_entity_1.MessageDirection.INCOMING,
                type: 'text',
                body: 'original text',
                timestamp: message.timestamp,
            });
            await runner.startTransaction();
            await runner.manager.update(message_entity_1.Message, { waMessageId: 'A' }, { type: 'revoked', body: '' });
            if (fromMe)
                projector.handleOwnSendEcho('s1', engine, message);
            else
                projector.handleInboundMessage('s1', engine, message);
            await flush();
            expect(seen).toEqual([]);
            if (commit)
                await runner.commitTransaction();
            else
                await runner.rollbackTransaction();
            for (let n = 0; n < 20; n++)
                await new Promise(resolve => setTimeout(resolve, 2));
            expect(seen).toEqual([commit ? '' : 'original text']);
            expect(await repository.findOneByOrFail({ waMessageId: 'A' })).toEqual(expect.objectContaining({ type: commit ? 'revoked' : 'text', body: commit ? '' : 'original text' }));
        }
        finally {
            if (runner.isTransactionActive)
                await runner.rollbackTransaction();
            await runner.release();
            await db.destroy();
        }
    });
});
