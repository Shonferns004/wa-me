"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const baileys_events_1 = require("./baileys-events");
const baileys_history_1 = require("./baileys-history");
const baileys_session_store_1 = require("./baileys-session-store");
const CHAT = '120363000000000001@g.us';
const SECOND = 1800000000;
const msg = (id, timestamp = SECOND) => ({
    key: { id, remoteJid: CHAT, fromMe: false },
    message: { conversation: id },
    messageTimestamp: timestamp,
});
function historyFor(store) {
    return new baileys_history_1.BaileysHistory({
        loadLib: () => Promise.resolve({
            normalizeMessageContent: (m) => m,
            getContentType: (m) => Object.keys(m)[0],
        }),
        normalizedSelfJid: () => '99999@s.whatsapp.net',
        toNeutralJid: (id) => store.toNeutralJid(id),
        extractEphemeralDuration: (message) => store.extractEphemeralDuration(message),
        recordMessage: (...args) => store.recordMessage(...args),
        recordMessageEdit: (...args) => store.recordMessageEdit(...args),
        upsertContacts: () => undefined,
        getOnHistoryMessages: () => () => undefined,
    });
}
describe('chat preview among messages of one second', () => {
    it('follows the order messages were observed in', () => {
        const store = new baileys_session_store_1.BaileysSessionStore();
        store.recordMessage(msg('A'), 'image');
        store.recordMessage(msg('B'), 'text');
        expect(store.lastMessage(CHAT)?.key.id).toBe('B');
        expect(store.lastInboundMessage(CHAT)?.key.id).toBe('B');
        expect(store.listChats()[0]).toMatchObject({ lastMessage: 'B', lastMessageType: 'text' });
    });
    it('keeps the newer second whichever message is observed last', () => {
        const store = new baileys_session_store_1.BaileysSessionStore();
        store.recordMessage(msg('B', SECOND + 1));
        store.recordMessage(msg('A'));
        expect(store.lastMessage(CHAT)?.key.id).toBe('B');
        expect(store.lastInboundMessage(CHAT)?.key.id).toBe('B');
    });
    it('does not bring back the original text when the current message is delivered again after an edit', () => {
        const store = new baileys_session_store_1.BaileysSessionStore();
        store.recordMessage(msg('A'), 'text');
        store.recordMessageEdit(CHAT, 'A', 'edited');
        store.recordMessage(msg('A'), 'text');
        expect(store.listChats()[0].lastMessage).toBe('edited');
    });
    it('keeps the first of equal-time history, in either order, and gives way to a live message', async () => {
        for (const ids of [
            ['A', 'B'],
            ['B', 'A'],
        ]) {
            const store = new baileys_session_store_1.BaileysSessionStore();
            await historyFor(store).captureHistoryMessages(ids.map(id => msg(id)));
            expect(store.lastMessage(CHAT)?.key.id).toBe(ids[0]);
            store.recordMessage(msg('LIVE'));
            expect(store.lastMessage(CHAT)?.key.id).toBe('LIVE');
        }
    });
    it('does not let equal-time history displace a live message', async () => {
        const store = new baileys_session_store_1.BaileysSessionStore();
        store.recordMessage(msg('B'));
        await historyFor(store).captureHistoryMessages([msg('A')]);
        expect(store.lastMessage(CHAT)?.key.id).toBe('B');
    });
    it.each([false, true])('keeps arrival order when the first message is slow to process (slow=%s)', async (slow) => {
        const store = new baileys_session_store_1.BaileysSessionStore();
        const emitted = [];
        let release;
        const gate = new Promise(resolve => (release = resolve));
        let sequence = 0;
        const host = {
            loadLib: () => Promise.resolve({
                normalizeMessageContent: (content) => content,
                getContentType: (content) => Object.keys(content)[0],
            }),
            logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
            toNeutralJid: (id) => store.toNeutralJid(id),
            normalizedSelfJid: () => '99999@s.whatsapp.net',
            inboundLimiter: new concurrency_limiter_1.ConcurrencyLimiter(2),
            nextMessageOrder: () => ++sequence,
            getStoredMessage: async (id) => {
                if (slow && id === 'A')
                    await gate;
                return null;
            },
            putStoredMessage: () => undefined,
            recordKeyLidMappings: () => undefined,
            recordMessage: (...args) => store.recordMessage(...args),
            recordMessageEdit: (...args) => store.recordMessageEdit(...args),
            consumeOwnSend: () => false,
            getOnMessage: () => (message) => emitted.push(message.id),
            getOnMessageCreate: () => undefined,
        };
        const events = new baileys_events_1.BaileysEvents(host);
        const flush = () => new Promise(resolve => setImmediate(resolve));
        events.handleMessagesUpsert({ messages: [msg('A')], type: 'notify' });
        await flush();
        events.handleMessagesUpsert({ messages: [msg('B')], type: 'notify' });
        await flush();
        expect(emitted).toEqual(slow ? ['B'] : ['A', 'B']);
        release();
        await flush();
        expect(emitted).toEqual(slow ? ['B', 'A'] : ['A', 'B']);
        expect(store.lastMessage(CHAT)?.key.id).toBe('B');
        expect(store.lastInboundMessage(CHAT)?.key.id).toBe('B');
    });
});
