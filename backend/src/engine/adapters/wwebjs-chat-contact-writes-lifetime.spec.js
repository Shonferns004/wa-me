"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const wwebjs_chats_1 = require("./wwebjs-chats");
const wwebjs_contacts_1 = require("./wwebjs-contacts");
const wwebjs_channels_1 = require("./wwebjs-channels");
/**
 * A chat, contact or channel write looks its target up first and then acts through the object that lookup
 * returned, which carries its own client: the host's readiness check on getClient never sees that second call. A
 * session stopped while the lookup was in flight must answer the retryable 409 and leave the write unsent, as the
 * group writes and the message mutations already do.
 */
const CHAT = '628111@c.us';
const CHANNEL = '120363000000000001@newsletter';
const deferred = () => {
    let resolve;
    const promise = new Promise(yes => {
        resolve = yes;
    });
    return { promise, resolve };
};
const writes = [
    'sendSeen',
    'clearChatMessages',
    'markUnread',
    'deleteChat',
    'block',
    'unblock',
    'muteChannel',
];
/** A READY session whose lookup is held until the test releases it; the looked-up object records the write. */
function fixture() {
    const entered = deferred();
    const gate = deferred();
    const write = jest.fn().mockResolvedValue(true);
    const target = {
        sendSeen: write,
        clearMessages: write,
        markUnread: write,
        delete: write,
        block: write,
        unblock: write,
        mute: write,
    };
    const held = async () => {
        entered.resolve();
        await gate.promise;
        return target;
    };
    const client = { getChatById: jest.fn(held), getContactById: jest.fn(held) };
    let ready = true;
    const host = {
        ensureReady() {
            if (!ready)
                throw new engine_not_ready_error_1.EngineNotReadyError();
        },
        getClient() {
            host.ensureReady();
            return client;
        },
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
        logger: { debug: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() },
        config: { sessionId: 'sess-writes' },
    };
    const chats = new wwebjs_chats_1.WwebjsChats(host, {});
    const contacts = new wwebjs_contacts_1.WwebjsContacts(host);
    const channels = new wwebjs_channels_1.WwebjsChannels(host);
    const invoke = (name) => {
        switch (name) {
            case 'sendSeen':
                return chats.sendSeen(CHAT);
            case 'clearChatMessages':
                return chats.clearChatMessages(CHAT);
            case 'markUnread':
                return chats.markUnread(CHAT);
            case 'deleteChat':
                return chats.deleteChat(CHAT);
            case 'block':
                return contacts.blockContact(CHAT);
            case 'unblock':
                return contacts.unblockContact(CHAT);
            case 'muteChannel':
                return channels.muteChannel(CHANNEL, true);
        }
    };
    return {
        invoke,
        write,
        entered,
        gate,
        stopSession: () => {
            ready = false;
        },
    };
}
describe('chat, contact and channel writes when the session stops during their lookup', () => {
    it.each(writes)('runs %s on a session that stays ready', async (name) => {
        const test = fixture();
        const done = test.invoke(name);
        test.gate.resolve();
        await done;
        expect(test.write).toHaveBeenCalledTimes(1);
    });
    it.each(writes)('refuses %s after the session stopped during the lookup, without sending it', async (name) => {
        const test = fixture();
        const done = test.invoke(name).catch((error) => error);
        await test.entered.promise;
        test.stopSession();
        test.gate.resolve();
        const outcome = await done;
        expect({ outcome: outcome instanceof engine_not_ready_error_1.EngineNotReadyError, writes: test.write.mock.calls.length }).toEqual({
            outcome: true,
            writes: 0,
        });
    });
});
