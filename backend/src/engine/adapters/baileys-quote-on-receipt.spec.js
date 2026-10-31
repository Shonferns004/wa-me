"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const baileys_events_1 = require("./baileys-events");
const baileys_messaging_1 = require("./baileys-messaging");
const baileys_message_store_service_1 = require("./baileys-message-store.service");
const baileys_stored_message_entity_1 = require("./baileys-stored-message.entity");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const message_not_found_error_1 = require("../../common/errors/message-not-found.error");
const logger_service_1 = require("../../common/services/logger.service");
const session_entity_1 = require("../../modules/session/entities/session.entity");
const CHAT = '628111@s.whatsapp.net';
const inbound = (id) => ({
    key: { id, remoteJid: CHAT, fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { conversation: 'hi' },
});
const photo = (id) => ({
    key: { id, remoteJid: CHAT, fromMe: false },
    messageTimestamp: 1_700_000_000,
    message: { imageMessage: { mimetype: 'image/jpeg', caption: 'about to be deleted' } },
});
/**
 * Real events, real messaging, real store on in-memory SQLite. A consumer that quotes a message the
 * moment it is announced (a quick-reply plugin on message:received) used to lose the race against the
 * store write and fail with `Message <id> not found`.
 */
describe('quoting a Baileys message the moment it is announced', () => {
    let ds;
    let repo;
    let store;
    let release;
    let upsert;
    /** One release per media download started, in call order: each download is held until released. */
    let downloads;
    /** Every chat preview write, in order: `record:<id>` for a message, `edit:<id>:<text>` for an edit. */
    let preview;
    const ticks = async () => {
        for (let i = 0; i < 20; i++)
            await new Promise(resolve => setImmediate(resolve));
    };
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [baileys_stored_message_entity_1.BaileysStoredMessage, session_entity_1.Session],
            synchronize: true,
        });
        await ds.initialize();
        repo = ds.getRepository(baileys_stored_message_entity_1.BaileysStoredMessage);
        store = new baileys_message_store_service_1.BaileysMessageStoreService(repo);
        downloads = [];
        preview = [];
        await ds
            .getRepository(session_entity_1.Session)
            .save(ds.getRepository(session_entity_1.Session).create({ id: 's1', name: 's1', status: session_entity_1.SessionStatus.READY, config: {} }));
        // Hold the first upsert: the database round trip the consumer lands inside.
        const gate = new Promise(resolve => (release = resolve));
        const real = repo.upsert.bind(repo);
        upsert = jest.spyOn(repo, 'upsert').mockImplementationOnce(async (...args) => {
            await gate;
            return real(...args);
        });
    });
    afterEach(async () => {
        await ticks(); // let the reply's own fire-and-forget store write land before the database closes
        jest.restoreAllMocks();
        await ds.destroy();
    });
    const build = (onMessage, on = {}) => {
        const sock = {
            onWhatsApp: jest.fn((jid) => Promise.resolve([{ jid, exists: true }])),
            sendMessage: jest
                .fn()
                .mockResolvedValue({ key: { id: 'R1', remoteJid: CHAT, fromMe: true }, messageTimestamp: 1 }),
        };
        const host = {
            getSocket: () => sock,
            getSocketOrNull: () => sock,
            logger: (0, logger_service_1.createLogger)('baileys-quote-on-receipt.spec'),
            toNeutralJid: (j) => j,
            toEngineJid: (j) => j,
            normalizedSelfJid: () => '628177@s.whatsapp.net',
            loadLib: () => Promise.resolve({
                normalizeMessageContent: (c) => c,
                extractMessageContent: (c) => c,
                getContentType: (c) => Object.keys(c ?? {})[0],
                proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
                BufferJSON: { replacer: (_k, v) => v, reviver: (_k, v) => v },
                downloadMediaMessage: () => new Promise(resolve => downloads.push(() => resolve({
                    // eslint-disable-next-line @typescript-eslint/require-await
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.from('JPEG');
                    },
                }))),
            }),
            getFetchDispatcher: () => undefined,
            inboundLimiter: new concurrency_limiter_1.ConcurrencyLimiter(4),
            recordKeyLidMappings: () => undefined,
            recordMessage: (m) => preview.push(`record:${m.key.id}`),
            recordMessageEdit: (_chatId, messageId, text) => preview.push(`edit:${messageId}:${text}`),
            putStoredMessage: (m) => store.put('s1', m),
            getStoredMessage: (id) => store.getMessage('s1', id),
            updateStoredMessage: (id, change) => store.update('s1', id, change),
            consumeOwnSend: () => false,
            rememberOwnSend: () => undefined,
            recordLidMapping: () => undefined,
            getOnMessage: () => onMessage,
            getOnMessageCreate: () => undefined,
            getOnMessageEdited: () => on.edited,
            getOnMessageRevoked: () => on.revoked,
            ensureReady: () => undefined,
            sessionProxyUrl: () => undefined,
            getEphemeralExpiration: () => undefined,
            toUnixSeconds: () => 1,
        };
        const events = new baileys_events_1.BaileysEvents(host);
        const messaging = new baileys_messaging_1.BaileysMessaging({
            ...host,
            mapMessage: (...a) => events.mapMessage(...a),
            wasDeletedForEveryone: (id) => events.wasDeletedForEveryone(id),
            markDeletedForEveryone: (id) => events.markDeletedForEveryone(id),
            pendingEditOf: (id, key) => events.pendingEditOf(id, key),
        });
        return { events, messaging, sock };
    };
    const change = (protocolMessage, chat = CHAT) => ({
        key: { id: 'CHANGE', remoteJid: chat, fromMe: false },
        messageTimestamp: 1_700_000_100,
        message: { protocolMessage: { key: { id: 'TARGET' }, ...protocolMessage } },
    });
    /** The content of every row the store was asked to write for `id`, in order. */
    const writtenContents = (id) => upsert.mock.calls
        .filter(([row]) => row.waMessageId === id)
        .map(([row]) => JSON.parse(row.serializedMessage).message);
    it('lets an onMessage consumer quote the message it was just handed', async () => {
        let reply;
        const { events, messaging, sock } = build(m => {
            reply = messaging.replyToMessage(m.chatId, m.id, 'ok');
        });
        events.handleMessagesUpsert({ messages: [inbound('QUOTE-ME')], type: 'notify' });
        await ticks();
        expect(reply).toBeDefined();
        release();
        await expect(reply).resolves.toMatchObject({ id: 'R1' });
        const [, , options] = sock.sendMessage.mock.calls[0];
        expect(options.quoted?.key.id).toBe('QUOTE-ME');
    });
    it('drops a re-delivery that arrives while the first copy is still being stored', async () => {
        const heard = jest.fn();
        const { events } = build(heard);
        events.handleMessagesUpsert({ messages: [inbound('TWICE')], type: 'notify' });
        await ticks();
        events.handleMessagesUpsert({ messages: [inbound('TWICE')], type: 'notify' });
        await ticks();
        release();
        await ticks();
        expect(heard).toHaveBeenCalledTimes(1);
    });
    describe('an edit or a delete for everyone of a stored message', () => {
        const stored = async (events) => {
            events.handleMessagesUpsert({ messages: [inbound('TARGET')], type: 'notify' });
            await ticks();
            release();
            await ticks();
        };
        it('lets a consumer of the edit quote the edited text at once', async () => {
            let reply;
            const { events, messaging, sock } = build(() => undefined, {
                edited: () => {
                    reply = messaging.replyToMessage(CHAT, 'TARGET', 'ok');
                },
            });
            await stored(events);
            events.handleMessagesUpsert({
                messages: [change({ type: 14, editedMessage: { conversation: 'after the edit' } })],
                type: 'notify',
            });
            await ticks();
            await expect(reply).resolves.toMatchObject({ id: 'R1' });
            const [, , options] = sock.sendMessage.mock.calls[0];
            expect(options.quoted?.message?.conversation).toBe('after the edit');
        });
        it('empties a message stored under its lid when the delete names the chat by phone', async () => {
            const revoked = jest.fn();
            const { events, messaging } = build(() => undefined, { revoked });
            const byLid = inbound('TARGET');
            byLid.key = { ...byLid.key, remoteJid: '99887@lid', remoteJidAlt: CHAT };
            events.handleMessagesUpsert({ messages: [byLid], type: 'notify' });
            await ticks();
            release();
            await ticks();
            events.handleMessagesUpsert({ messages: [change({ type: 0 })], type: 'notify' });
            await ticks();
            expect(revoked).toHaveBeenCalledTimes(1);
            expect((await store.getMessage('s1', 'TARGET'))?.message).toBeNull();
            await expect(messaging.forwardMessage(CHAT, '628555@s.whatsapp.net', 'TARGET')).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        });
        it('refuses a consumer of the delete that quotes the deleted message at once', async () => {
            let reply;
            const { events, messaging, sock } = build(() => undefined, {
                revoked: () => {
                    reply = messaging.replyToMessage(CHAT, 'TARGET', 'ok').catch((err) => err);
                },
            });
            await stored(events);
            events.handleMessagesUpsert({ messages: [change({ type: 0 })], type: 'notify' });
            await ticks();
            expect(await reply).toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
            expect(sock.sendMessage).not.toHaveBeenCalled();
        });
    });
    describe('a delete for everyone that arrives while the original is still downloading its media', () => {
        beforeEach(() => release()); // the held step here is the download, not the store write
        it('keeps the content out of the store, out of the chat preview and out of any announcement', async () => {
            const heard = jest.fn();
            const { events, messaging } = build(heard);
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [change({ type: 0 })], type: 'notify' });
            await ticks();
            downloads[0]();
            await ticks();
            expect(heard).not.toHaveBeenCalled();
            expect(writtenContents('TARGET')).toEqual([null]);
            // The delete found no preview to clear, so the original, recorded after it, must not restore one.
            expect(preview).toEqual(['edit:TARGET:', 'record:TARGET', 'edit:TARGET:']);
            await expect(messaging.replyToMessage(CHAT, 'TARGET', 'ok')).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        });
        it('keeps a repeat delivery that passed the repeat check from restoring the content', async () => {
            const { events, messaging } = build(() => undefined);
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [change({ type: 0 })], type: 'notify' });
            await ticks();
            // Nothing is stored yet, so the repeat is not recognised as one and downloads too.
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            downloads[0](); // the first delivery is stored, and the delete lands on top of it
            await ticks();
            downloads[1](); // then the repeat is stored
            await ticks();
            expect((await store.getMessage('s1', 'TARGET'))?.message).toBeNull();
            expect(writtenContents('TARGET')).toEqual([null, null]);
            await expect(messaging.forwardMessage(CHAT, '628555@s.whatsapp.net', 'TARGET')).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        });
        it('refuses a consumer of the delete while a repeat of the original is already stored', async () => {
            let reply;
            const { events, messaging, sock } = build(() => undefined, {
                revoked: () => {
                    reply = messaging.replyToMessage(CHAT, 'TARGET', 'ok').catch((err) => err);
                },
            });
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            downloads[1](); // the repeat is stored with its content; the first delivery still downloads
            await ticks();
            events.handleMessagesUpsert({ messages: [change({ type: 0 })], type: 'notify' });
            await ticks();
            expect(await reply).toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
            expect(sock.sendMessage).not.toHaveBeenCalled();
            downloads[0]();
            await ticks();
        });
        it('ignores a delete of the same id sent from another chat', async () => {
            let reply;
            const { events, messaging } = build(m => {
                reply = messaging.replyToMessage(CHAT, m.id, 'ok');
            });
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [change({ type: 0 }, '628999@s.whatsapp.net')], type: 'notify' });
            await ticks();
            downloads[0]();
            await ticks();
            await expect(reply).resolves.toMatchObject({ id: 'R1' });
            expect(writtenContents('TARGET')).toEqual([photo('TARGET').message]);
            // The declined delete is written through update(), after the reply, so read the row it left.
            await ticks();
            expect((await store.getMessage('s1', 'TARGET'))?.message).toEqual(photo('TARGET').message);
        });
    });
    describe('an edit that arrives while the original is still downloading its media', () => {
        beforeEach(() => release()); // the held step here is the download, not the store write
        const edit = (chat = CHAT) => change({ type: 14, editedMessage: { conversation: 'fixed caption' } }, chat);
        const caption = async () => (await store.getMessage('s1', 'TARGET'))?.message?.imageMessage?.caption;
        it('announces, stores and previews the message with its edited text', async () => {
            const order = [];
            const heard = [];
            const { events } = build(m => {
                order.push('received');
                heard.push(m.body);
            }, { edited: () => order.push('edited') });
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [edit()], type: 'notify' });
            await ticks();
            downloads[0]();
            await ticks();
            // The edit is announced right after the message it changes, when the session holds it.
            expect(order).toEqual(['received', 'edited']);
            expect(heard).toEqual(['fixed caption']);
            expect(writtenContents('TARGET')).toEqual([
                { imageMessage: { mimetype: 'image/jpeg', caption: 'fixed caption' } },
            ]);
            expect(await caption()).toBe('fixed caption');
            // The edit found no preview to change, so the original, recorded after it, carries the edit.
            expect(preview).toEqual(['edit:TARGET:fixed caption', 'record:TARGET', 'edit:TARGET:fixed caption']);
        });
        it('keeps a repeat delivery that passed the repeat check from restoring the old text', async () => {
            const heard = [];
            const { events } = build(m => heard.push(m.body));
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [edit()], type: 'notify' });
            await ticks();
            // Nothing is stored yet, so the repeat is not recognised as one and downloads too.
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            downloads[0](); // the first delivery is stored, and the edit lands on top of it
            await ticks();
            downloads[1](); // then the repeat is stored
            await ticks();
            expect(await caption()).toBe('fixed caption');
            expect(heard).toEqual(['fixed caption', 'fixed caption']);
        });
        it('lets a quote carry the edited text while a repeat of the original is stored', async () => {
            const { events, messaging, sock } = build(() => undefined);
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            downloads[1](); // the repeat is stored with the old caption; the first delivery still downloads
            await ticks();
            events.handleMessagesUpsert({ messages: [edit()], type: 'notify' });
            await ticks();
            const reply = messaging.replyToMessage(CHAT, 'TARGET', 'ok');
            await expect(reply).resolves.toMatchObject({ id: 'R1' });
            const [, , options] = sock.sendMessage.mock.calls[0];
            expect(options.quoted?.message?.imageMessage?.caption).toBe('fixed caption');
            // The overlay is a copy: the stored row changes only once the first delivery settles.
            expect(await caption()).toBe('about to be deleted');
            downloads[0]();
            await ticks();
            expect(await caption()).toBe('fixed caption');
        });
        it('forgets the edit once the message is no longer in flight', async () => {
            const { events } = build(() => undefined);
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [edit()], type: 'notify' });
            await ticks();
            expect(events.pendingEditOf('TARGET', photo('TARGET').key)).toBe('fixed caption');
            downloads[0]();
            await ticks();
            // A later repeat is in flight again, but the store already carries the edit, and any newer one.
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            expect(events.pendingEditOf('TARGET', photo('TARGET').key)).toBeUndefined();
            await ticks();
        });
        it('does not overlay an edit sent from another chat', async () => {
            const { events } = build(() => undefined);
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [edit()], type: 'notify' });
            await ticks();
            const elsewhere = { ...photo('TARGET').key, remoteJid: '628999@s.whatsapp.net' };
            expect(events.pendingEditOf('TARGET', elsewhere)).toBeUndefined();
            downloads[0]();
            await ticks();
        });
        it('lets a delete for everyone win over an earlier edit', async () => {
            const heard = jest.fn();
            const { events } = build(heard);
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [edit()], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [change({ type: 0 })], type: 'notify' });
            await ticks();
            downloads[0]();
            await ticks();
            expect(heard).not.toHaveBeenCalled();
            expect(writtenContents('TARGET')).toEqual([null]);
            expect(preview.slice(-1)).toEqual(['edit:TARGET:']);
        });
        it('ignores an edit of the same id sent from another chat', async () => {
            const heard = [];
            const { events } = build(m => heard.push(m.body));
            events.handleMessagesUpsert({ messages: [photo('TARGET')], type: 'notify' });
            await ticks();
            events.handleMessagesUpsert({ messages: [edit('628999@s.whatsapp.net')], type: 'notify' });
            await ticks();
            downloads[0]();
            await ticks();
            expect(heard).toEqual(['about to be deleted']);
            expect(await caption()).toBe('about to be deleted');
        });
    });
});
