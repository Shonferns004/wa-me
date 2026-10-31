"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const baileys_contacts_1 = require("./baileys-contacts");
const baileys_messaging_1 = require("./baileys-messaging");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
/**
 * The last group of writes whose confirmation the library discards. Same reasoning as the group and
 * profile writes: `chatModify`, the addressbook writes and the block toggles all await a query and
 * return void, so the call resolves identically whether WhatsApp applied the change or never
 * answered. One case per call site — a missing wrapper is invisible any other way.
 */
const never = () => new Promise(() => undefined);
const stub = () => jest.fn(never);
const LAST = { key: { id: 'M1', remoteJid: '628123@s.whatsapp.net' }, timestamp: 1 };
function contacts(sock, budgetMs) {
    const host = {
        ensureReady: () => undefined,
        getSocket: () => sock,
        logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
        normalizedSelfJid: () => '628177@s.whatsapp.net',
        listContacts: () => [],
        findContact: () => null,
        resolvePhone: () => null,
        listChats: () => [],
        lastMessage: () => LAST,
        chatDeletedAt: () => null,
        toEngineJid: (j) => j,
        chatJid: (j) => j,
        lidOf: () => null,
    };
    return new baileys_contacts_1.BaileysContacts(host, budgetMs);
}
function messaging(sock, budgetMs) {
    const host = {
        ensureReady: () => undefined,
        getSocket: () => sock,
        logger: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
        toNeutralJid: (j) => j,
        toEngineJid: (j) => j,
        normalizedSelfJid: () => '628177@s.whatsapp.net',
        getEphemeralExpiration: () => undefined,
        toUnixSeconds: () => 1,
        loadLib: () => Promise.resolve({}),
        getStoredMessage: () => Promise.resolve({ key: { ...LAST.key, fromMe: true }, message: {}, messageTimestamp: 1 }),
        wasDeletedForEveryone: () => false,
        pendingEditOf: () => undefined,
        markDeletedForEveryone: () => undefined,
        putStoredMessage: () => undefined,
        recordLidMapping: () => undefined,
        getOnMessageCreate: () => undefined,
        mapMessage: () => Promise.resolve({}),
    };
    return new baileys_messaging_1.BaileysMessaging(host, budgetMs);
}
describe('contact and chat-state writes report an unconfirmed write', () => {
    it.each([
        ['upsertContact', 'addOrEditContact', (c) => c.upsertContact('628123@c.us', 'Ada')],
        ['deleteContact', 'removeContact', (c) => c.deleteContact('628123@c.us')],
        ['blockContact', 'updateBlockStatus', (c) => c.blockContact('628123@c.us')],
        ['unblockContact', 'updateBlockStatus', (c) => c.unblockContact('628123@c.us')],
        ['markUnread', 'chatModify', (c) => c.markUnread('628123@c.us')],
        ['clearChatMessages', 'chatModify', (c) => c.clearChatMessages('628123@c.us')],
        ['archiveChat', 'chatModify', (c) => c.archiveChat('628123@c.us', true)],
        ['deleteChat', 'chatModify', (c) => c.deleteChat('628123@c.us')],
    ])('%s', async (_n, method, call) => {
        await expect(call(contacts({ [method]: stub() }, 15))).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
    it('still resolves when WhatsApp answers inside the budget', async () => {
        const updateBlockStatus = jest.fn().mockResolvedValue(undefined);
        await expect(contacts({ updateBlockStatus }, 500).blockContact('628123@c.us')).resolves.toBeUndefined();
    });
});
describe('message chat-state writes report an unconfirmed write', () => {
    it.each([
        ['deleteMessage (for me)', (m) => m.deleteMessage('628123@s.whatsapp.net', 'M1', false)],
        ['starMessage', (m) => m.starMessage('628123@s.whatsapp.net', 'M1', true)],
    ])('%s', async (_n, call) => {
        await expect(call(messaging({ chatModify: stub() }, 15))).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
});
