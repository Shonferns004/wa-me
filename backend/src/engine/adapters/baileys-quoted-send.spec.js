"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const baileys_messaging_1 = require("./baileys-messaging");
const message_not_found_error_1 = require("../../common/errors/message-not-found.error");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * Baileys quotes by full stored message, not by id: `MiscMessageGenerationOptions.quoted` is a
 * `WAMessage` (Types/Message.d.ts:246), and the contextInfo is attached after content generation
 * with no per-content-type branch (Utils/messages.js), so every send kind can carry one.
 *
 * The adapter can therefore only quote a message it has already persisted. That store dependency is
 * the whole reason these assertions check `getStoredMessage` traffic as well as the socket payload:
 * a resolver that silently returned undefined would send an unquoted message and report success,
 * which is exactly the failure this feature exists to avoid on the other engine.
 */
const logger = (0, logger_service_1.createLogger)('baileys-quoted-send.spec');
const STORED = {
    key: { id: 'QUOTED-1', remoteJid: '628111@s.whatsapp.net', fromMe: false },
    message: { conversation: 'the quoted text' },
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// `null`, not `undefined`, for the not-found case: passing undefined to a defaulted parameter
// selects the default, which would quietly turn that test into a second happy-path assertion.
function makeMessaging(stored = STORED) {
    const sock = {
        onWhatsApp: jest.fn((jid) => Promise.resolve([{ jid, exists: true }])),
        sendMessage: jest.fn().mockResolvedValue({ key: { id: 'M1' }, messageTimestamp: 1 }),
    };
    const getStoredMessage = jest.fn().mockResolvedValue(stored);
    const host = {
        ensureReady: jest.fn(),
        sessionProxyUrl: () => undefined,
        getSocket: () => sock,
        getSocketOrNull: () => sock,
        logger,
        toNeutralJid: (j) => j,
        toEngineJid: (j) => j,
        normalizedSelfJid: () => '628177@s.whatsapp.net',
        getEphemeralExpiration: () => undefined,
        toUnixSeconds: () => 1,
        loadLib: () => Promise.resolve({}),
        getStoredMessage,
        wasDeletedForEveryone: () => false,
        pendingEditOf: () => undefined,
        markDeletedForEveryone: () => undefined,
        putStoredMessage: () => undefined,
        recordMessage: () => undefined,
        rememberOwnSend: () => undefined,
        recordLidMapping: () => undefined,
        getOnMessageCreate: () => undefined,
        mapMessage: () => Promise.resolve({}),
    };
    return { messaging: new baileys_messaging_1.BaileysMessaging(host), sock, getStoredMessage };
}
const optionsOf = (sock) => {
    const [, , options] = sock.sendMessage.mock.calls[0];
    return (options ?? {});
};
const CHAT = '628111@s.whatsapp.net';
describe('BaileysMessaging — a quote rides along with every content kind', () => {
    // One case per content kind rather than media alone: the poll, location and contact paths each
    // build their own content object, so a thread that covered only the shared media helper would
    // leave three senders silently unquoted while this file stayed green.
    it.each([
        [
            'image',
            (m) => m.sendImageMessage(CHAT, { data: PNG, mimetype: 'image/png', quotedMessageId: 'QUOTED-1' }),
        ],
        [
            'document',
            (m) => m.sendDocumentMessage(CHAT, { data: PNG, mimetype: 'application/pdf', quotedMessageId: 'QUOTED-1' }),
        ],
        [
            'location',
            (m) => m.sendLocationMessage(CHAT, { latitude: 1, longitude: 2, quotedMessageId: 'QUOTED-1' }),
        ],
        [
            'contact',
            (m) => m.sendContactMessage(CHAT, { name: 'Alice', number: '628999', quotedMessageId: 'QUOTED-1' }),
        ],
        [
            'poll',
            (m) => m.sendPollMessage(CHAT, { name: 'Q', options: ['a', 'b'], quotedMessageId: 'QUOTED-1' }),
        ],
        ['text', (m) => m.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: 'QUOTED-1' })],
    ])('%s send attaches the stored message as `quoted`', async (_kind, send) => {
        const { messaging, sock } = makeMessaging();
        await send(messaging);
        expect(sock.sendMessage).toHaveBeenCalledTimes(1);
        expect(optionsOf(sock).quoted).toBe(STORED);
    });
    // Known-negative control. Without it an implementation that attached the quote unconditionally —
    // or that resolved the store on every send — would satisfy every assertion above.
    it('sends unquoted, and never touches the store, when no id is supplied', async () => {
        const { messaging, sock, getStoredMessage } = makeMessaging();
        await messaging.sendImageMessage(CHAT, { data: PNG, mimetype: 'image/png' });
        expect(optionsOf(sock).quoted).toBeUndefined();
        expect(getStoredMessage).not.toHaveBeenCalled();
    });
    it('leaves the existing text options intact while adding the quote', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: 'QUOTED-1' });
        // getUrlInfo is passed on every text send so Baileys' own vulnerable preview generator stays
        // unreachable; merging the quote must not displace it.
        expect(typeof optionsOf(sock).getUrlInfo).toBe('function');
    });
    it('refuses an unresolvable id instead of sending unquoted', async () => {
        const { messaging, sock } = makeMessaging(null);
        await expect(messaging.sendImageMessage(CHAT, { data: PNG, mimetype: 'image/png', quotedMessageId: 'MISSING' })).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        // Reporting success on a message that went out without its quote is the defect; failing after
        // the send would not fix it.
        expect(sock.sendMessage).not.toHaveBeenCalled();
    });
    it('refuses a message deleted for everyone instead of quoting what was deleted', async () => {
        // The store keeps a deleted message with `message: null`. Baileys copies the quoted message into
        // the reply's contextInfo, so quoting the pre-delete copy would send the deleted content again.
        const { messaging, sock } = makeMessaging({ ...STORED, message: null });
        await expect(messaging.sendTextMessage(CHAT, 'hi', undefined, { quotedMessageId: 'QUOTED-1' })).rejects.toBeInstanceOf(message_not_found_error_1.MessageNotFoundError);
        expect(sock.sendMessage).not.toHaveBeenCalled();
    });
});
