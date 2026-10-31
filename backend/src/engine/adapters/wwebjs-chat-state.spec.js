"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_chats_1 = require("./wwebjs-chats");
const wwebjs_labels_1 = require("./wwebjs-labels");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * `archived`, `pinned` and `muted` on the whatsapp-web.js side of `ChatSummary`.
 *
 * Both places that build a summary have to carry the three, and they are built independently:
 * `getChats` maps the library's `Chat` model, while `getChatsByLabel` maps the entries
 * `getChatsByLabelId` returns. A field added to one and forgotten in the other is invisible until
 * a Business account lists a label, so both mappers are held to the same shape here.
 *
 * The library reports mute as a verdict (`Chat.isMuted`) plus the stamp behind it
 * (`Chat.muteExpiration`, epoch SECONDS, `-1` = forever). `muted` maps the verdict; `muteExpiration`
 * maps the stamp as epoch ms (`0` = indefinite), present only when muted. Boolean fields read through
 * `Boolean()` because the page can leave any of them undefined on a chat built from a partial record,
 * and `undefined` must land as `false` rather than escape into a required boolean.
 */
const logger = (0, logger_service_1.createLogger)('wwebjs-chat-state.spec');
function makeHost(client) {
    return {
        ensureReady: jest.fn(),
        getClient: () => client,
        logger,
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
    };
}
const RAW = {
    id: { _serialized: '628123@c.us' },
    name: 'Alice',
    isGroup: false,
    unreadCount: 0,
    timestamp: 1_700_000_000,
};
/** The page model a listed chat is rehydrated from: Chat._patch reads formattedTitle, t, archive and pin. */
const toPageModel = ({ name, timestamp, archived, pinned, ...rest }) => ({
    ...rest,
    formattedTitle: name,
    t: timestamp,
    archive: archived,
    pin: pinned,
});
describe('WwebjsChats.getChats chat state', () => {
    const listWith = async (over) => {
        const client = { pupPage: { evaluate: jest.fn().mockResolvedValue([toPageModel({ ...RAW, ...over })]) } };
        const chats = new wwebjs_chats_1.WwebjsChats(makeHost(client), {});
        return (await chats.getChats())[0];
    };
    it('carries archived, pinned and muted through from the library model', async () => {
        const summary = await listWith({ archived: true, pinned: true, isMuted: true });
        expect(summary).toMatchObject({ archived: true, pinned: true, muted: true });
    });
    it('reports false, not undefined, when the page left the fields unset', async () => {
        const summary = await listWith({});
        // Required fields on ChatSummary: a caller reading `chat.muted` must never get undefined and
        // silently treat "unknown" as a mute.
        expect(summary).toMatchObject({ archived: false, pinned: false, muted: false });
    });
    // Chat.isMuted is the verdict; muteExpiration is the stamp behind it. Mapping the stamp instead
    // would report every chat that has ever been muted as muted.
    it('reads the verdict, not the expiry stamp behind it', async () => {
        const summary = await listWith({ isMuted: false, muteExpiration: 1_700_000_000 });
        expect(summary.muted).toBe(false);
    });
    // The all-true and all-false cases above stay green if a mapper reads archived off pinned, or
    // muted off the wrong flag. These mixed cases pin each field to its own source: the first breaks
    // an archived/pinned swap, the second breaks muted reading either boolean.
    it('maps archived, pinned and muted each from its own field', async () => {
        expect(await listWith({ archived: true, pinned: false, isMuted: false })).toMatchObject({
            archived: true,
            pinned: false,
            muted: false,
        });
        expect(await listWith({ archived: false, pinned: false, isMuted: true })).toMatchObject({
            archived: false,
            pinned: false,
            muted: true,
        });
    });
    it('maps muteExpiration to ms when muted, 0 for -1 (forever), absent when not muted', async () => {
        const secs = 1_786_003_600;
        expect(await listWith({ isMuted: true, muteExpiration: secs })).toMatchObject({
            muted: true,
            muteExpiration: secs * 1000,
        });
        expect((await listWith({ isMuted: true, muteExpiration: -1 })).muteExpiration).toBe(0);
        expect((await listWith({ isMuted: false, muteExpiration: secs })).muteExpiration).toBeUndefined();
    });
});
describe('WwebjsLabels.getChatsByLabel chat state', () => {
    const listWith = async (over) => {
        const client = { getChatsByLabelId: jest.fn().mockResolvedValue([{ ...RAW, ...over }]) };
        const labels = new wwebjs_labels_1.WwebjsLabels(makeHost(client));
        return (await labels.getChatsByLabel('1'))[0];
    };
    it('carries the same three fields as getChats', async () => {
        const summary = await listWith({ archived: true, pinned: true, isMuted: true });
        expect(summary).toMatchObject({ archived: true, pinned: true, muted: true });
    });
    it('reports false when the label entry left them unset', async () => {
        const summary = await listWith({});
        expect(summary).toMatchObject({ archived: false, pinned: false, muted: false });
    });
    it('maps archived, pinned and muted each from its own field', async () => {
        expect(await listWith({ archived: true, pinned: false, isMuted: false })).toMatchObject({
            archived: true,
            pinned: false,
            muted: false,
        });
        expect(await listWith({ archived: false, pinned: false, isMuted: true })).toMatchObject({
            archived: false,
            pinned: false,
            muted: true,
        });
    });
    it('maps muteExpiration the same way as getChats', async () => {
        const secs = 1_786_003_600;
        expect(await listWith({ isMuted: true, muteExpiration: secs })).toMatchObject({
            muted: true,
            muteExpiration: secs * 1000,
        });
        expect((await listWith({ isMuted: true, muteExpiration: -1 })).muteExpiration).toBe(0);
        expect((await listWith({ isMuted: false, muteExpiration: secs })).muteExpiration).toBeUndefined();
    });
});
