"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const baileys_history_1 = require("./baileys-history");
const baileys_events_1 = require("./baileys-events");
const baileys_messaging_1 = require("./baileys-messaging");
const baileys_message_store_service_1 = require("./baileys-message-store.service");
const baileys_stored_message_entity_1 = require("./baileys-stored-message.entity");
const baileys_session_store_1 = require("./baileys-session-store");
const message_entity_1 = require("../../modules/message/entities/message.entity");
const session_entity_1 = require("../../modules/session/entities/session.entity");
const message_history_projector_1 = require("../../modules/session/message-history-projector");
const message_not_found_error_1 = require("../../common/errors/message-not-found.error");
const logger_service_1 = require("../../common/services/logger.service");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const CHAT = '628111@s.whatsapp.net';
const SELF = '628222@s.whatsapp.net';
const target = (over = {}) => ({
    key: { id: 'M1', remoteJid: CHAT, fromMe: false },
    message: { conversation: 'withdrawn secret' },
    messageTimestamp: 1_700_000_000,
    ...over,
});
const revoke = (key = target().key, envelope = {}) => ({
    key: { id: 'R1', remoteJid: key.remoteJid, fromMe: false, ...envelope },
    message: { protocolMessage: { type: 0, key } },
    messageTimestamp: 1_700_000_100,
});
describe('Baileys history revokes', () => {
    let ds;
    let repo;
    let raw;
    let history;
    let messaging;
    let previews;
    let pending;
    let onHistory;
    let liveFanout;
    let persisted;
    let isLive;
    let sendMessage;
    let events;
    let releaseMedia;
    beforeEach(async () => {
        ds = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message, session_entity_1.Session, baileys_stored_message_entity_1.BaileysStoredMessage],
            synchronize: true,
        }).initialize();
        repo = ds.getRepository(message_entity_1.Message);
        raw = new baileys_message_store_service_1.BaileysMessageStoreService(ds.getRepository(baileys_stored_message_entity_1.BaileysStoredMessage));
        await ds.getRepository(session_entity_1.Session).save({ id: 's1', name: 's1', status: session_entity_1.SessionStatus.READY, config: {} });
        previews = new baileys_session_store_1.BaileysSessionStore(undefined, 's1');
        previews.upsertChats([{ id: CHAT }, { id: '1@g.us' }]);
        pending = [];
        isLive = true;
        liveFanout = jest.fn();
        persisted = jest.fn();
        onHistory = jest.fn((messages) => {
            const saving = (0, message_history_projector_1.persistHistoryMessages)(repo, undefined, 's1', messages, { log: jest.fn() }, () => isLive, persisted);
            pending.push(saving);
            return saving;
        });
        sendMessage = jest.fn().mockResolvedValue({ key: { id: 'S1', remoteJid: CHAT, fromMe: true } });
        const socket = { sendMessage, onWhatsApp: (jid) => Promise.resolve([{ jid, exists: true }]) };
        const host = {
            getSocket: () => socket,
            getSocketOrNull: () => socket,
            logger: (0, logger_service_1.createLogger)('baileys-history-revokes.spec'),
            loadLib: () => Promise.resolve({
                normalizeMessageContent: (m) => m,
                getContentType: (m) => Object.keys(m)[0],
                extractMessageContent: (m) => m,
                proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
                downloadMediaMessage: () => new Promise(resolve => {
                    releaseMedia = () => resolve({
                        // eslint-disable-next-line @typescript-eslint/require-await
                        async *[Symbol.asyncIterator]() {
                            yield Buffer.from('private photo');
                        },
                    });
                }),
            }),
            normalizedSelfJid: () => SELF,
            toNeutralJid: (jid) => previews.toNeutralJid(jid),
            toEngineJid: (jid) => jid,
            extractEphemeralDuration: (msg) => previews.extractEphemeralDuration(msg),
            recordMessage: (msg, type) => previews.recordMessage(msg, type),
            recordMessageEdit: (...args) => previews.recordMessageEdit(...args),
            upsertContacts: () => undefined,
            getOnHistoryMessages: () => onHistory,
            getOnMessageRevoked: () => liveFanout,
            getOnMessage: () => liveFanout,
            getOnMessageCreate: () => liveFanout,
            getFetchDispatcher: () => undefined,
            inboundLimiter: new concurrency_limiter_1.ConcurrencyLimiter(4),
            recordKeyLidMappings: () => undefined,
            consumeOwnSend: () => false,
            putStoredMessage: (msg) => raw.put('s1', msg),
            getStoredMessage: (id) => raw.getMessage('s1', id),
            updateStoredMessage: (id, change) => raw.update('s1', id, change),
            ensureReady: () => undefined,
        };
        events = new baileys_events_1.BaileysEvents(host);
        const shared = {
            ...host,
            applyHistoryRevoke: (...args) => events.applyHistoryRevoke(...args),
            wasDeletedForEveryone: (id) => events.wasDeletedForEveryone(id),
            pendingEditOf: (id, key) => events.pendingEditOf(id, key),
        };
        history = new baileys_history_1.BaileysHistory(shared);
        messaging = new baileys_messaging_1.BaileysMessaging(shared);
    });
    afterEach(async () => {
        await Promise.all(pending);
        await ds.destroy();
    });
    const capture = async (messages) => {
        await history.captureHistoryMessages(messages);
        await Promise.all(pending);
    };
    const cleared = async () => {
        const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'M1' });
        expect(row).toMatchObject({ body: '', type: 'revoked', metadata: null, mediaPath: null, mediaMimetype: null });
        expect(liveFanout).not.toHaveBeenCalled();
        return row;
    };
    it.each([false, true])('persists a cleared target in either batch order (reversed=%s)', async (reversed) => {
        const batch = [target(), revoke()];
        await capture(reversed ? batch.reverse() : batch);
        await cleared();
        expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
            lastMessage: '',
            lastMessageType: 'revoked',
        });
    });
    it('clears stored poll, archive, quote and reaction data in a revoke-only chunk', async () => {
        const poll = target({
            message: {
                pollCreationMessageV3: {
                    name: 'Private question',
                    options: [{ optionName: 'Secret' }],
                    selectableOptionsCount: 1,
                },
            },
        });
        await capture([poll]);
        const row = await repo.findOneByOrFail({ waMessageId: 'M1' });
        expect(row.metadata.poll).toBeDefined();
        await repo.update(row.id, {
            metadata: {
                ...row.metadata,
                media: { data: 'secret' },
                quotedMessage: { body: 'secret' },
                reactions: { sender: 'yes' },
            },
            mediaPath: 's1/secret.jpg',
            mediaMimetype: 'image/jpeg',
        });
        await raw.put('s1', poll);
        await capture([revoke()]);
        await cleared();
        expect(onHistory).toHaveBeenCalledTimes(2);
        expect(persisted).toHaveBeenCalledWith(expect.objectContaining({ id: row.id, body: '', type: 'revoked', metadata: null }));
        expect((await raw.getMessage('s1', 'M1'))?.message).toBeNull();
        await expect(messaging.replyToMessage(CHAT, 'M1', 'reply')).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        await expect(messaging.forwardMessage(CHAT, SELF, 'M1')).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        expect(sendMessage).not.toHaveBeenCalled();
    });
    it('keeps a tombstone when the target arrives in a later history chunk', async () => {
        await capture([revoke()]);
        await cleared();
        await capture([target()]);
        expect(await cleared()).toMatchObject({ timestamp: 1_700_000_000, createdAt: new Date(1_700_000_000_000) });
        expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
            lastMessage: '',
            lastMessageType: 'revoked',
        });
    });
    it('keeps the preview cleared after the bounded raw-cache marker has been evicted', async () => {
        await raw.put('s1', target());
        await capture([revoke()]);
        for (let i = 0; i <= baileys_events_1.BaileysEvents.DELETED_FOR_EVERYONE_LIMIT; i++)
            events.markDeletedForEveryone(`other-${i}`);
        expect(events.wasDeletedForEveryone('M1')).toBe(false);
        await capture([target()]);
        await cleared();
        expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
            lastMessage: '',
            lastMessageType: 'revoked',
        });
    });
    it('keeps the tombstone when a concurrent content chunk finishes its dedup query later', async () => {
        const find = repo.find.bind(repo);
        let releaseFind;
        const gate = new Promise(resolve => {
            releaseFind = resolve;
        });
        const spy = jest
            .spyOn(repo, 'find')
            .mockImplementationOnce(async () => {
            await gate;
            return [];
        })
            .mockImplementation(find);
        const m = {
            id: 'M1',
            chatId: '628111@c.us',
            from: '628111@c.us',
            to: '628222@c.us',
            fromMe: false,
            isGroup: false,
            kind: 'individual',
            body: 'withdrawn secret',
            type: 'text',
            timestamp: 1_700_000_000,
        };
        const content = (0, message_history_projector_1.persistHistoryMessages)(repo, undefined, 's1', [m], { log: jest.fn() }, () => true);
        await capture([revoke()]);
        releaseFind();
        await content;
        spy.mockRestore();
        expect(await cleared()).toMatchObject({ timestamp: 1_700_000_000, createdAt: new Date(1_700_000_000_000) });
    });
    it('clears an original still downloading its media without live fanout', async () => {
        const photo = target({ message: { imageMessage: { mimetype: 'image/jpeg', caption: 'withdrawn secret' } } });
        events.handleMessagesUpsert({ messages: [photo], type: 'notify' });
        for (let i = 0; i < 20 && !releaseMedia; i++)
            await new Promise(resolve => setImmediate(resolve));
        expect(releaseMedia).toBeDefined();
        await capture([revoke()]);
        releaseMedia();
        for (let i = 0; i < 20; i++)
            await new Promise(resolve => setImmediate(resolve));
        await cleared();
        expect((await raw.getMessage('s1', 'M1'))?.message).toBeNull();
    });
    it.each([
        ['another chat', { remoteJid: SELF }],
        ['another author', { fromMe: true }],
    ])('rejects a revoke from %s in the same batch and raw cache', async (_label, envelope) => {
        await raw.put('s1', target());
        await capture([target(), revoke(target().key, envelope)]);
        expect(await repo.findOneByOrFail({ waMessageId: 'M1' })).toMatchObject({ body: 'withdrawn secret', type: 'text' });
        expect((await raw.getMessage('s1', 'M1'))?.message).toEqual(target().message);
    });
    it.each([
        ['another chat', { remoteJid: SELF }],
        ['another author', { fromMe: true }],
    ])('preserves a prior SQL row when a revoke targets %s without a raw copy', async (_label, key) => {
        await capture([target()]);
        const other = { ...target().key, ...key };
        await capture([revoke(other, { fromMe: other.fromMe })]);
        await capture([target()]);
        expect(await repo.findOneByOrFail({ waMessageId: 'M1' })).toMatchObject({ body: 'withdrawn secret', type: 'text' });
        expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
            lastMessage: 'withdrawn secret',
            lastMessageType: 'text',
        });
    });
    it('accepts a group admin revoke and preserves the original outgoing direction', async () => {
        const own = target({ key: { id: 'M1', remoteJid: '1@g.us', fromMe: true } });
        await raw.put('s1', own);
        await capture([own, revoke(own.key, { fromMe: false, participant: CHAT })]);
        expect(await cleared()).toMatchObject({ direction: message_entity_1.MessageDirection.OUTGOING, from: '628222@c.us', author: null });
        expect((await raw.getMessage('s1', 'M1'))?.message).toBeNull();
    });
    it('does not write history tombstones after the session is retired', async () => {
        isLive = false;
        await capture([revoke()]);
        expect(await repo.count()).toBe(0);
    });
    it('does not apply a history revoke whose raw lookup outlives unlinking', async () => {
        await raw.put('s1', target());
        let release;
        const spy = jest.spyOn(raw, 'getMessage').mockImplementationOnce(() => new Promise(resolve => {
            release = resolve;
        }));
        const applying = events.applyHistoryRevoke(target().key, revoke().key);
        events.fenceStoredWrites();
        release(target());
        expect(await applying).toBeUndefined();
        spy.mockRestore();
        expect((await raw.getMessage('s1', 'M1'))?.message).toEqual(target().message);
    });
    it('keeps distinct raw LIDs separate even when both keys carry the same phone', async () => {
        const original = target({ key: { id: 'M1', remoteJid: '111@lid', remoteJidAlt: CHAT, fromMe: false } });
        await raw.put('s1', original);
        const applying = events.applyHistoryRevoke(original.key, {
            remoteJid: '222@lid',
            remoteJidAlt: CHAT,
            fromMe: false,
        });
        expect(await applying).toBeUndefined();
        expect((await raw.getMessage('s1', 'M1'))?.message).toEqual(original.message);
    });
    it('does not apply a history revoke whose directory lookup outlives unlinking', async () => {
        await raw.put('s1', target());
        let release;
        let entered;
        const started = new Promise(resolve => {
            entered = resolve;
        });
        events.host.findPersistedLidPhone = () => {
            entered();
            return new Promise(resolve => {
                release = resolve;
            });
        };
        const applying = events.applyHistoryRevoke(target().key, { remoteJid: '111@lid', fromMe: false });
        await started;
        events.fenceStoredWrites();
        release('628111');
        expect(await applying).toBeUndefined();
        expect((await raw.getMessage('s1', 'M1'))?.message).toEqual(target().message);
    });
    it.each([
        ['edit', 'preview'],
        ['edit', 'stored'],
        ['revoke', 'preview'],
        ['revoke', 'stored'],
    ])('does not resume a live %s after its %s lookup outlives reset', async (kind, phase) => {
        await raw.put('s1', target());
        previews.upsertChats([{ id: CHAT }]);
        previews.recordMessage(target());
        let release;
        let entered;
        const started = new Promise(resolve => {
            entered = resolve;
        });
        const host = events.host;
        const phone = new Promise(resolve => {
            release = resolve;
        });
        let reads = 0;
        host.findPersistedLidPhone = () => {
            reads++;
            if (reads !== (phase === 'preview' ? 1 : 2))
                return Promise.resolve('628111');
            entered();
            return phone;
        };
        host.getOnMessageEdited = () => liveFanout;
        const change = kind === 'revoke'
            ? revoke(target().key, { remoteJid: '111@lid' })
            : {
                key: { id: 'EDIT', remoteJid: '111@lid', fromMe: false },
                message: {
                    protocolMessage: { type: 14, key: { id: 'M1' }, editedMessage: { conversation: 'old connection edit' } },
                },
                messageTimestamp: 1700000100,
            };
        events.handleMessagesUpsert({ type: 'notify', messages: [change] });
        await started;
        const jobs = [
            ...events.inboundInFlight.values(),
        ].map(job => job.done);
        events.fenceStoredWrites();
        await raw.clearSession('s1');
        const current = target({ message: { conversation: 'current connection body' } });
        await raw.put('s1', current);
        previews = new baileys_session_store_1.BaileysSessionStore(undefined, 's1');
        previews.upsertChats([{ id: CHAT }]);
        previews.recordMessage(current);
        release('628111');
        await Promise.all(jobs);
        for (let i = 0; i < 10; i++)
            await new Promise(resolve => setImmediate(resolve));
        expect((await raw.getMessage('s1', 'M1'))?.message).toEqual(current.message);
        expect(previews.listChats().find(chat => chat.id === '628111@c.us')?.lastMessage).toBe('current connection body');
        expect(liveFanout).not.toHaveBeenCalled();
    });
    it('does not bridge a history preview after its directory lookup outlives reset', async () => {
        let generation = 0;
        let release;
        let entered;
        const started = new Promise(resolve => {
            entered = resolve;
        });
        const host = history
            .host;
        host.getStoredWriteGeneration = () => generation;
        const phone = new Promise(resolve => {
            release = resolve;
        });
        host.findPersistedLidPhone = () => {
            entered();
            return phone;
        };
        onHistory.mockImplementationOnce((messages) => Promise.resolve(messages.map(message => ({ ...message, type: 'revoked', body: '' }))));
        const capturing = history.captureHistoryMessages([
            target({ key: { id: 'M1', remoteJid: '111@lid', fromMe: false } }),
        ]);
        await started;
        generation++;
        previews = new baileys_session_store_1.BaileysSessionStore(undefined, 's1');
        previews.upsertChats([{ id: CHAT }]);
        previews.recordMessage(target({ message: { conversation: 'current connection body' } }));
        release('628111');
        await capturing;
        expect(previews.listChats().find(chat => chat.id === '628111@c.us')?.lastMessage).toBe('current connection body');
    });
    it('clears old content with retention enabled without inserting old content again', async () => {
        await capture([target()]);
        const previous = process.env.MESSAGE_RETENTION_DAYS;
        process.env.MESSAGE_RETENTION_DAYS = '1';
        try {
            await capture([target(), revoke()]);
            await cleared();
            previews = new baileys_session_store_1.BaileysSessionStore(undefined, 's1');
            previews.upsertChats([{ id: CHAT }]);
            await capture([target()]);
            expect(previews.listChats().find(chat => chat.id === '628111@c.us')).toMatchObject({
                lastMessage: '',
                lastMessageType: 'revoked',
            });
        }
        finally {
            if (previous === undefined)
                delete process.env.MESSAGE_RETENTION_DAYS;
            else
                process.env.MESSAGE_RETENTION_DAYS = previous;
        }
    });
});
