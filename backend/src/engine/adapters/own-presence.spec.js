"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const wwebjs_chats_1 = require("./wwebjs-chats");
const baileys_messaging_1 = require("./baileys-messaging");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * Own GLOBAL presence (appear online/offline) across both engines. Unlike the per-chat
 * typing/recording indicator (sendChatState), this is NOT best-effort: the caller explicitly asked
 * to appear offline — a bot that silently stays visible online causes exactly the missed-phone-
 * notification problem the feature exists to solve (#871) — so a failure surfaces instead of being
 * swallowed. Chat state is a separate wire operation and does not republish this.
 */
const logger = (0, logger_service_1.createLogger)('own-presence.spec');
describe('WwebjsChats.setOnlinePresence', () => {
    function makeChats() {
        const client = {
            sendPresenceAvailable: jest.fn().mockResolvedValue(undefined),
            sendPresenceUnavailable: jest.fn().mockResolvedValue(undefined),
        };
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            isPageTransportError: () => false,
            logger,
        };
        return { chats: new wwebjs_chats_1.WwebjsChats(host, {}), client };
    }
    it('true publishes available', async () => {
        const { chats, client } = makeChats();
        await chats.setOnlinePresence(true);
        expect(client.sendPresenceAvailable).toHaveBeenCalledTimes(1);
        expect(client.sendPresenceUnavailable).not.toHaveBeenCalled();
    });
    it('false publishes unavailable', async () => {
        const { chats, client } = makeChats();
        await chats.setOnlinePresence(false);
        expect(client.sendPresenceUnavailable).toHaveBeenCalledTimes(1);
        expect(client.sendPresenceAvailable).not.toHaveBeenCalled();
    });
    it('propagates a failure — the caller asked for this state, so a swallow would lie', async () => {
        const { chats, client } = makeChats();
        client.sendPresenceUnavailable.mockRejectedValue(new Error('page died'));
        await expect(chats.setOnlinePresence(false)).rejects.toThrow('page died');
    });
    it('clears a chat indicator without publishing global presence', async () => {
        const clearState = jest.fn().mockResolvedValue(undefined);
        const client = {
            sendPresenceAvailable: jest.fn().mockResolvedValue(undefined),
            sendPresenceUnavailable: jest.fn().mockResolvedValue(undefined),
            getChatById: jest.fn().mockResolvedValue({ clearState }),
        };
        const messaging = {
            resolveSendId: jest.fn().mockResolvedValue('123@c.us'),
        };
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            logger,
        };
        const chats = new wwebjs_chats_1.WwebjsChats(host, messaging);
        await chats.sendChatState('123@c.us', 'paused');
        expect(clearState).toHaveBeenCalled();
        expect(client.sendPresenceAvailable).not.toHaveBeenCalled();
    });
});
describe('BaileysMessaging.setOnlinePresence', () => {
    function makeMessaging(name = 'Me') {
        const sock = {
            sendPresenceUpdate: jest.fn().mockResolvedValue(undefined),
            // The live credentials Baileys reads. null means creds.me itself is missing; '' is the empty name
            // Baileys also ignores.
            authState: { creds: name === null ? {} : { me: { id: '628999:12@s.whatsapp.net', name } } },
        };
        const host = {
            ensureReady: jest.fn(),
            getSocket: () => sock,
            getSocketOrNull: () => sock,
            toEngineJid: (jid) => jid,
            recordLidMapping: jest.fn(),
            logger,
        };
        return { messaging: new baileys_messaging_1.BaileysMessaging(host), sock };
    }
    it('true publishes a GLOBAL available update (no chat jid)', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.setOnlinePresence(true);
        expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('available');
    });
    it('false publishes a GLOBAL unavailable update', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.setOnlinePresence(false);
        expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('unavailable');
    });
    it('propagates a failure rather than swallowing it', async () => {
        const { messaging, sock } = makeMessaging();
        sock.sendPresenceUpdate.mockRejectedValue(new Error('socket closed'));
        await expect(messaging.setOnlinePresence(true)).rejects.toThrow('socket closed');
    });
    it('refuses when the push name is not set — Baileys would resolve without sending', async () => {
        const { messaging, sock } = makeMessaging(null);
        await expect(messaging.setOnlinePresence(true)).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
    });
    it('publishes once the name has synced, though the socket was built before the account had one', async () => {
        const { messaging, sock } = makeMessaging('Synced Name');
        // sock.user is the copy of creds.me taken when the socket was built, right after the link.
        sock.user = {};
        await messaging.setOnlinePresence(false);
        expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('unavailable');
    });
    it('refuses while the live credentials have no name, whatever the build-time copy holds', async () => {
        const { messaging, sock } = makeMessaging(null);
        sock.user = { name: 'Stale' };
        await expect(messaging.setOnlinePresence(true)).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
    });
    it('refuses an empty push name the same way Baileys treats a missing one', async () => {
        const { messaging, sock } = makeMessaging('');
        await expect(messaging.setOnlinePresence(false)).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(sock.sendPresenceUpdate).not.toHaveBeenCalled();
    });
    it('sends composing as a per-chat update and nothing global', async () => {
        const { messaging, sock } = makeMessaging();
        await messaging.sendChatState('628111@s.whatsapp.net', 'typing');
        expect(sock.sendPresenceUpdate).toHaveBeenCalledTimes(1);
        expect(sock.sendPresenceUpdate).toHaveBeenCalledWith('composing', '628111@s.whatsapp.net');
    });
});
