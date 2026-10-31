"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const baileys_events_1 = require("./baileys-events");
const baileys_history_1 = require("./baileys-history");
const baileys_session_store_1 = require("./baileys-session-store");
const baileys_message_mapper_1 = require("./baileys-message-mapper");
const logger_service_1 = require("../../common/services/logger.service");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
/**
 * The chat list preview (GET /chats `lastMessage`) is the text of the chat's newest message, the
 * same text the message itself is announced with. A message in a disappearing chat arrives wrapped
 * in `ephemeralMessage`, and a photo or video carries its text as a caption; both are announced with
 * that text as their body, and the preview must show it too.
 */
// Library stand-in: unwraps the envelopes the real normalizeMessageContent opens.
const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'documentWithCaptionMessage'];
const normalizeMessageContent = (content) => {
    let current = content ?? undefined;
    for (let i = 0; i < 5 && current; i++) {
        const wrapper = WRAPPERS.find(name => current[name]);
        if (!wrapper)
            break;
        current = current[wrapper].message;
    }
    return current;
};
const getContentType = (content) => Object.keys(content ?? {}).find(k => k === 'conversation' || k.endsWith('Message'));
const lib = {
    normalizeMessageContent,
    extractMessageContent: normalizeMessageContent,
    getContentType,
    proto: { Message: { ProtocolMessage: { Type: { REVOKE: 0, MESSAGE_EDIT: 14 } } } },
};
const PEER = '628111@s.whatsapp.net';
const SELF = '628222@s.whatsapp.net';
function build(overrides = {}) {
    const store = new baileys_session_store_1.BaileysSessionStore(undefined, 's1');
    store.upsertChats([{ id: PEER }]);
    const emitted = [];
    const noop = () => undefined;
    const host = {
        getSocket: () => ({}),
        getSocketOrNull: () => null,
        logger: (0, logger_service_1.createLogger)('baileys-chat-preview-text.spec'),
        loadLib: () => Promise.resolve(lib),
        getFetchDispatcher: noop,
        toNeutralJid: (jid) => store.toNeutralJid(jid),
        normalizedSelfJid: () => SELF,
        inboundLimiter: new concurrency_limiter_1.ConcurrencyLimiter(2),
        recordKeyLidMappings: noop,
        recordMessage: (msg, type, order) => store.recordMessage(msg, type, order),
        nextMessageOrder: () => store.nextMessageOrder(),
        recordMessageEdit: (...args) => store.recordMessageEdit(...args),
        consumeOwnSend: () => false,
        getStoredMessage: noop,
        putStoredMessage: noop,
        updateStoredMessage: noop,
        removeStoredMessage: noop,
        getOnMessage: () => (m) => void emitted.push(m.body),
        getOnMessageCreate: noop,
        getOnMessageRevoked: noop,
        getOnMessageEdited: noop,
        getOnMessageReaction: noop,
        getOnMessageAck: noop,
        getOnMessageReceipt: noop,
        getOnGroupEvent: noop,
        getOnEventResponse: noop,
        findContact: () => null,
        getOnCall: noop,
        getOnPresenceUpdate: noop,
        getOnCallOutcome: noop,
        // history host
        upsertContacts: noop,
        upsertChats: noop,
        contactCount: () => 0,
        extractEphemeralDuration: (msg) => store.extractEphemeralDuration(msg),
        getOnHistoryMessages: noop,
        applyHistoryRevoke: noop,
        ...overrides,
    };
    return {
        events: new baileys_events_1.BaileysEvents(host),
        history: new baileys_history_1.BaileysHistory(host),
        store,
        emitted,
    };
}
const settle = async () => {
    for (let i = 0; i < 20; i++)
        await new Promise(resolve => setImmediate(resolve));
};
/** Wait until `done` holds, up to a deadline. */
const until = async (done) => {
    const deadline = Date.now() + 5_000;
    while (!done() && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 5));
};
const inbound = (id, message) => ({
    key: { id, remoteJid: PEER, fromMe: false },
    message,
    messageTimestamp: 1_700_000_000,
});
describe('Baileys chat list preview text', () => {
    const previous = process.env.MEDIA_DOWNLOAD_ENABLED;
    beforeAll(() => {
        process.env.MEDIA_DOWNLOAD_ENABLED = 'false';
    });
    afterAll(() => {
        if (previous === undefined)
            delete process.env.MEDIA_DOWNLOAD_ENABLED;
        else
            process.env.MEDIA_DOWNLOAD_ENABLED = previous;
    });
    it('previews a disappearing-chat text with the body it was announced with', async () => {
        const { events, store, emitted } = build();
        events.handleMessagesUpsert({
            type: 'notify',
            messages: [
                inbound('E1', {
                    ephemeralMessage: {
                        message: { extendedTextMessage: { text: 'see you at 7', contextInfo: { expiration: 86400 } } },
                    },
                }),
            ],
        });
        await settle();
        expect(emitted).toEqual(['see you at 7']);
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'see you at 7', lastMessageType: 'text' });
    });
    it('previews a captioned photo with its caption, as the announced body and an edited caption do', async () => {
        const { events, store, emitted } = build();
        events.handleMessagesUpsert({
            type: 'notify',
            messages: [inbound('I1', { imageMessage: { caption: 'the receipt', mimetype: 'image/jpeg', fileLength: 10 } })],
        });
        await settle();
        expect(emitted).toEqual(['the receipt']);
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'the receipt', lastMessageType: 'image' });
    });
    it('previews a captioned document and a view-once photo with their captions', async () => {
        const { events, store } = build();
        events.handleMessagesUpsert({
            type: 'notify',
            messages: [
                inbound('D1', {
                    documentWithCaptionMessage: {
                        message: { documentMessage: { caption: 'the contract', mimetype: 'application/pdf', fileName: 'c.pdf' } },
                    },
                }),
            ],
        });
        await settle();
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'the contract', lastMessageType: 'document' });
        events.handleMessagesUpsert({
            type: 'notify',
            messages: [
                {
                    ...inbound('V1', {
                        viewOnceMessageV2: { message: { imageMessage: { caption: 'look once', mimetype: 'image/jpeg' } } },
                    }),
                    messageTimestamp: 1_700_000_100,
                },
            ],
        });
        await settle();
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'look once', lastMessageType: 'image' });
    });
    it('previews a photo the account sent with its caption', () => {
        const { store } = build();
        store.recordMessage({
            key: { id: 'S1', remoteJid: PEER, fromMe: true },
            message: { imageMessage: { caption: 'invoice attached', mimetype: 'image/jpeg' } },
            messageTimestamp: 1_700_000_000,
        }, 'image');
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'invoice attached', lastMessageType: 'image' });
    });
    it('previews nothing of a captioned photo deleted while it was still being processed', async () => {
        // The first store read is the original's repeat-delivery check, held until released.
        let release = () => undefined;
        let reads = 0;
        const getStoredMessage = () => ++reads === 1 ? new Promise(resolve => (release = resolve)) : Promise.resolve(null);
        const { events, store } = build({ getStoredMessage });
        const own = { remoteJid: PEER, fromMe: true };
        events.handleMessagesUpsert({
            type: 'notify',
            messages: [
                {
                    key: { id: 'P1', ...own },
                    message: { imageMessage: { caption: 'wrong photo', mimetype: 'image/jpeg' } },
                    messageTimestamp: 1_700_000_000,
                },
            ],
        });
        await settle();
        events.handleMessagesUpsert({
            type: 'notify',
            messages: [
                {
                    key: { id: 'R1', ...own },
                    message: { protocolMessage: { type: 0, key: { id: 'P1', ...own } } },
                    messageTimestamp: 1_700_000_010,
                },
            ],
        });
        await settle();
        release(null);
        await settle();
        expect(store.listChats()[0]).toMatchObject({ lastMessage: '', lastMessageType: 'revoked' });
    });
    it('previews a history-synced disappearing-chat text with its body', async () => {
        const { history, store } = build();
        await history.captureHistoryMessages([
            inbound('H1', { ephemeralMessage: { message: { conversation: 'from before the link' } } }),
        ]);
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'from before the link', lastMessageType: 'text' });
    });
    // Some clients send a tapped native-flow button with its label only in the params: the reply is announced with
    // that label as its body, so the preview shows it too.
    it('previews a native-flow reply by the label it carries only in its params', async () => {
        const { events, store, emitted } = build();
        const reply = {
            interactiveResponseMessage: {
                nativeFlowResponseMessage: {
                    name: 'quick_reply',
                    paramsJson: '{"id":"opt-yes","display_text":"Yes, book it"}',
                },
            },
        };
        events.handleMessagesUpsert({ type: 'notify', messages: [inbound('NF1', reply)] });
        await until(() => emitted.length > 0);
        expect(emitted).toEqual(['Yes, book it']);
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'Yes, book it', lastMessageType: 'text' });
        expect((0, baileys_message_mapper_1.baileysMessageText)({ ephemeralMessage: { message: reply } })).toBe('Yes, book it');
    });
    it('previews nothing of a native-flow reply whose params carry no id, as it is announced with no body', async () => {
        const { events, store, emitted } = build();
        const reply = {
            interactiveResponseMessage: {
                nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: '{"display_text":"Yes, book it"}' },
            },
        };
        events.handleMessagesUpsert({ type: 'notify', messages: [inbound('NF2', reply)] });
        await until(() => emitted.length > 0);
        expect(emitted).toEqual(['']);
        expect(store.listChats()[0]).toMatchObject({ lastMessage: '' });
    });
});
