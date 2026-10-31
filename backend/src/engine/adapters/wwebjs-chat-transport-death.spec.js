"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_chats_1 = require("./wwebjs-chats");
const logger_service_1 = require("../../common/services/logger.service");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
/**
 * Five boolean chat operations caught EVERY error and resolved `false`, including a dead-page
 * transport error — while `getChats` in the same file, and getGroupInfo / getGroupJoinInfo /
 * getChatsByLabel / getContactById elsewhere in the adapter, split that case out into
 * EngineTransportError and report the session death.
 *
 * The caller was therefore told HTTP 200 `{"success": false}` — "WhatsApp declined a valid request"
 * — while the session's browser was actually dead, and retried against a corpse instead of getting
 * the 503 the route documents. The early death signal was lost too, so handlePuppeteerDeath never
 * fired and the session kept reporting READY until the slower watchdog noticed.
 */
const logger = (0, logger_service_1.createLogger)('wwebjs-chat-transport-death.spec');
describe('boolean chat operations distinguish a dead page from a refusal', () => {
    const transportError = new Error('Protocol error (Runtime.callFunctionOn): Session closed.');
    function makeChats(reject) {
        const chat = {
            sendSeen: jest.fn().mockRejectedValue(reject),
            clearMessages: jest.fn().mockRejectedValue(reject),
            markUnread: jest.fn().mockRejectedValue(reject),
            delete: jest.fn().mockRejectedValue(reject),
        };
        const client = {
            getChatById: jest.fn().mockResolvedValue(chat),
            archiveChat: jest.fn().mockRejectedValue(reject),
            unarchiveChat: jest.fn().mockRejectedValue(reject),
        };
        const reportIfPageTransportError = jest.fn();
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            isPageTransportError: (error) => error === transportError,
            reportIfPageTransportError,
            logger,
        };
        return { chats: new wwebjs_chats_1.WwebjsChats(host, {}), reportIfPageTransportError };
    }
    const call = (chats, op) => ({
        sendSeen: () => chats.sendSeen('628123@c.us'),
        clearChatMessages: () => chats.clearChatMessages('628123@c.us'),
        archiveChat: () => chats.archiveChat('628123@c.us', true),
        markUnread: () => chats.markUnread('628123@c.us'),
        deleteChat: () => chats.deleteChat('628123@c.us'),
    })[op]();
    const OPS = ['sendSeen', 'clearChatMessages', 'archiveChat', 'markUnread', 'deleteChat'];
    it.each(OPS)('%s reports a dead page as a transport failure, not a refusal', async (op) => {
        const { chats, reportIfPageTransportError } = makeChats(transportError);
        await expect(call(chats, op)).rejects.toThrow(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, expect.any(String));
    });
    // Negative twin: an ordinary page-side refusal must still resolve false, unchanged. Without this
    // the fix could simply turn every failure into a 503.
    it.each(OPS)('%s still resolves false when the page merely declines', async (op) => {
        const { chats, reportIfPageTransportError } = makeChats(new Error('Evaluation failed: chat not found'));
        await expect(call(chats, op)).resolves.toBe(false);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
});
/**
 * Mute and pin resolve the chat first and then write. The write leg is where a renderer that dies
 * mid-call rejects, so it needs the same split: a 503 with the death reported, while any other page
 * rejection still reaches the caller unchanged. Setting the account's own presence is the same kind
 * of write and makes the same split.
 */
describe('mute, pin and presence classify a dead page on the write leg', () => {
    const transportError = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
    function makeChats(reject) {
        const client = {
            getChatById: jest.fn().mockResolvedValue({ id: { _serialized: '628123@c.us' } }),
            muteChat: jest.fn().mockRejectedValue(reject),
            unmuteChat: jest.fn().mockRejectedValue(reject),
            pinChat: jest.fn().mockRejectedValue(reject),
            unpinChat: jest.fn().mockRejectedValue(reject),
            sendPresenceAvailable: jest.fn().mockRejectedValue(reject),
            sendPresenceUnavailable: jest.fn().mockRejectedValue(reject),
        };
        const reportIfPageTransportError = jest.fn();
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            isPageTransportError: (error) => error === transportError,
            reportIfPageTransportError,
            logger,
        };
        return { chats: new wwebjs_chats_1.WwebjsChats(host, {}), reportIfPageTransportError };
    }
    const WRITES = [
        ['muteChat', chats => chats.muteChat('628123@c.us', Date.now() + 60_000)],
        ['unmuteChat', chats => chats.muteChat('628123@c.us', null)],
        ['pinChat', chats => chats.pinChat('628123@c.us', true)],
        ['unpinChat', chats => chats.pinChat('628123@c.us', false)],
        ['setOnlinePresence(true)', chats => chats.setOnlinePresence(true)],
        ['setOnlinePresence(false)', chats => chats.setOnlinePresence(false)],
    ];
    it.each(WRITES)('%s reports a dead page as a transport failure', async (_op, call) => {
        const { chats, reportIfPageTransportError } = makeChats(transportError);
        await expect(call(chats)).rejects.toThrow(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).toHaveBeenCalledWith(transportError, expect.any(String));
    });
    it.each(WRITES)('%s answers a protocol timeout as a transport failure without reporting a death', async (_op, call) => {
        const timeout = new Error("Runtime.callFunctionOn timed out. Increase the 'protocolTimeout' setting in launch/connect calls for a higher timeout if needed.");
        const { chats, reportIfPageTransportError } = makeChats(timeout);
        await expect(call(chats)).rejects.toThrow(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
    it.each(WRITES)('%s rethrows any other page rejection unchanged', async (_op, call) => {
        const refusal = new Error('Evaluation failed: TypeError: renamed internal');
        const { chats, reportIfPageTransportError } = makeChats(refusal);
        await expect(call(chats)).rejects.toBe(refusal);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
});
