"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.WwebjsChats = void 0;
exports.readChatModels = readChatModels;
exports.listChats = listChats;
const common_1 = require("@nestjs/common");
const wwebjs = __importStar(require("whatsapp-web.js"));
const whatsapp_web_js_1 = require("whatsapp-web.js");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const wa_id_1 = require("../identity/wa-id");
const wwebjs_host_1 = require("./wwebjs-host");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const message_mapper_1 = require("./message-mapper");
/**
 * Build the chat list IN-PAGE with the same `window.WWebJS.getChatModel` whatsapp-web.js's own
 * `client.getChats()` maps, yielding to the page event loop every 256 chats so the liveness probe's
 * queued `getState()` evaluate can interleave. The library starts every getChatModel in one `map`,
 * and a personal chat reaches no await at all (serialize() plus its last message), so on a large chat
 * list that map is one uninterrupted synchronous stretch that starves the probe and lets the watchdog
 * tear a healthy session down mid-read: the #1501 shape readLeanContacts fixed for contacts.
 *
 * The models and their order are unchanged and the group metadata updates still overlap. A group
 * whose model fails one of WhatsApp Web's own invariants is served from the metadata the page already
 * holds (see the fallback below), so one group WhatsApp Web cannot refresh no longer fails the whole
 * list; any other rejection still rejects the whole read, as upstream does.
 */
async function readChatModels() {
    const w = window;
    // A group's model refreshes its metadata from the server first (groupMetadata.update), and WhatsApp
    // Web itself can throw while processing the reply: invariant 76137, raised by its device-list sync
    // for a member whose hosted (coexistence) device lacks the hosted flag, fails one group on every
    // read. Rebuild the model getChatModel would return from the metadata already loaded, without the
    // last-message preview, so the group stays listed. The marker lets listChats report it. Only an
    // invariant (WhatsApp Web rejecting its own data) is recovered: a logout, a network loss or any
    // other failure still fails the read instead of answering every group from stale metadata. If even
    // the local read throws, the original rejection stands.
    const localGroupModel = (chat, error) => {
        const failure = error;
        const description = `${String(failure?.name)}: ${String(failure?.message ?? error)}`;
        if (!chat?.groupMetadata || !/Invariant Violation|Minified invariant/.test(description))
            throw error;
        try {
            const model = chat.serialize();
            model.isGroup = true;
            model.isMuted = chat.mute?.expiration !== 0;
            model.formattedTitle = chat.formattedTitle;
            const { toPn } = w.require('WAWebLidMigrationUtils');
            const metadata = chat.groupMetadata.serialize();
            for (const p of metadata.participants || [])
                p.id = toPn(p.id) ?? p.id;
            model.groupMetadata = metadata;
            model.isReadOnly = chat.groupMetadata.announce;
            model.lastMessage = null;
            delete model.msgs;
            delete model.msgUnsyncedButtonReplyMsgs;
            delete model.unsyncedButtonReplies;
            model.metadataRefreshError = description.slice(0, 200);
            return model;
        }
        catch {
            throw error;
        }
    };
    // A copy: getModelsArray() is the collection's live array, which re-sorts on a new message and
    // grows on a new chat, so indexing it across the yields below would read one chat twice and skip
    // another. Upstream's single synchronous map never let it change underneath.
    const chats = w.require('WAWebCollections').Chat.getModelsArray().slice();
    const pending = [];
    for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const model = w.WWebJS.getChatModel(chat).catch(error => localGroupModel(chat, error));
        // Handled here so a rejection that lands during a yield is not reported as unhandled; the
        // Promise.all below still rejects with it.
        model.catch(() => undefined);
        pending.push(model);
        if ((i & 0xff) === 0xff)
            await new Promise(resolve => setTimeout(resolve));
    }
    return Promise.all(pending);
}
const { GroupChat, PrivateChat } = wwebjs;
/**
 * Turn a failure that says the page is gone into the retryable 503 every chat operation answers: a dead
 * page (reported as the early death signal) or a read that outran the protocol budget. Anything else
 * returns, for the caller to handle. A chat action that reported a dead page as "WhatsApp declined" (an
 * opaque `false`) let the caller retry against a corpse.
 */
function rethrowTransportFailure(host, error, context, activity, timedOutMessage = `WhatsApp Web did not answer in time while ${activity}`) {
    // A session that stopped during the lookup is the retryable 409, never a `false` refusal.
    if (error instanceof engine_not_ready_error_1.EngineNotReadyError)
        throw error;
    (0, wwebjs_host_1.rethrowIfNavigation)(host, error);
    if (host.isPageTransportError(error)) {
        host.reportIfPageTransportError(error, context);
        throw new engine_transport_error_1.EngineTransportError(`Transport died while ${activity}`);
    }
    if ((0, wwebjs_lifecycle_1.isProtocolTimeout)(error)) {
        throw new engine_transport_error_1.EngineTransportError(timedOutMessage);
    }
}
/**
 * The whole chat list through {@link readChatModels}, rehydrated the way whatsapp-web.js's
 * ChatFactory does for these entries, so every mapped field reads exactly as `client.getChats()`
 * gave it. Shared by the chat and group lists. A dead page answers 503 with the death signal, a read
 * that outran the protocol budget answers 503 without one, and anything else is rethrown.
 */
async function listChats(host, context) {
    const client = host.getClient();
    const page = client.pupPage;
    let models;
    try {
        models = await page.evaluate(readChatModels);
    }
    catch (error) {
        // Same split every sibling read makes (see getChatsByLabel): a dead page is a 503 and an
        // early death signal, not an opaque 500 under a status that still says READY (#1081).
        rethrowTransportFailure(host, error, context, 'listing chats', 'WhatsApp Web did not answer the chat list read in time');
        throw error;
    }
    const local = models.filter(data => typeof data.metadataRefreshError === 'string');
    if (local.length > 0) {
        // Bounded: the list is polled, so name at most ten groups and each distinct error once.
        host.logger.warn(`Listed ${local.length} group(s) from local metadata; WhatsApp Web could not refresh them`, {
            context,
            groups: local.slice(0, 10).map(data => data.id?._serialized),
            errors: [...new Set(local.map(data => data.metadataRefreshError))].slice(0, 3),
        });
    }
    return models.map(data => data.isGroup ? new GroupChat(client, data) : new PrivateChat(client, data));
}
/**
 * Chat-list operations extracted from WhatsAppWebJsAdapter. The adapter keeps the public methods as
 * thin forwarders and injects the shared host surface (./wwebjs-host) via closures, so the delegate
 * never touches lifecycle state directly. Presence (sendChatState) resolves the recipient through
 * the messaging delegate's send-id cache, exactly like a send.
 */
class WwebjsChats {
    host;
    messaging;
    constructor(host, messaging) {
        this.host = host;
        this.messaging = messaging;
    }
    /** Post-ensureReady client handle. */
    client() {
        return this.host.getClient();
    }
    async getChats() {
        this.host.ensureReady();
        const chats = await listChats(this.host, 'getChats');
        const summaries = [];
        let skipped = 0;
        // Map the raw whatsapp-web.js chat objects to the library-agnostic ChatSummary
        // shape so that no library types leak past the engine boundary. Some WA system
        // or channel-like entries can lack the normal serialized id; skip those instead
        // of failing the whole dashboard chats request.
        for (const chat of chats) {
            const id = chat.id?._serialized;
            if (!id) {
                skipped++;
                continue;
            }
            summaries.push({
                id,
                name: chat.name || id,
                isGroup: Boolean(chat.isGroup),
                kind: (0, wa_id_1.chatKind)(id),
                unreadCount: chat.unreadCount || 0,
                timestamp: chat.timestamp || 0,
                // A location message's body is the base64 map thumbnail; don't surface it as the chat preview.
                lastMessage: chat.lastMessage?.type === whatsapp_web_js_1.MessageTypes.LOCATION ? '📍' : chat.lastMessage?.body || undefined,
                lastMessageType: chat.lastMessage ? (0, message_mapper_1.mapWwebjsMessageType)(chat.lastMessage.type) : undefined,
                archived: Boolean(chat.archived),
                pinned: Boolean(chat.pinned),
                // Chat.isMuted is the current verdict; muteExpiration is wwjs epoch SECONDS with -1 = forever.
                muted: Boolean(chat.isMuted),
                // Expose the expiry as ms (0 = indefinite), present only when muted, per ChatSummary.
                muteExpiration: chat.isMuted
                    ? (chat.muteExpiration ?? 0) > 0
                        ? (chat.muteExpiration ?? 0) * 1000
                        : 0
                    : undefined,
            });
        }
        if (skipped > 0) {
            this.host.logger.warn(`Skipped ${skipped} chat(s) without a serialized id`);
        }
        return summaries;
    }
    async sendSeen(chatId) {
        this.host.ensureReady();
        try {
            const chat = await this.client().getChatById(chatId);
            // The chat acts through its own client, which getClient's readiness check never sees again.
            this.host.ensureReady();
            return await chat.sendSeen();
        }
        catch (error) {
            // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
            rethrowTransportFailure(this.host, error, 'sendSeen', 'marking a chat as read');
            this.host.logger.error(`Error marking chat ${chatId} as read`, String(error));
            return false;
        }
    }
    async clearChatMessages(chatId) {
        this.host.ensureReady();
        try {
            // An unknown chat needs no special case: getChatById resolves undefined for one, and the
            // resulting TypeError lands in the catch below as the same `false` the injected helper
            // returns for a chat it cannot find. Same shape as sendSeen/archiveChat above.
            const chat = await this.client().getChatById(chatId);
            this.host.ensureReady();
            return await chat.clearMessages();
        }
        catch (error) {
            // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
            rethrowTransportFailure(this.host, error, 'clearChatMessages', 'clearing a chat');
            this.host.logger.error(`Error clearing messages in chat ${chatId}`, String(error));
            return false;
        }
    }
    async archiveChat(chatId, archive) {
        this.host.ensureReady();
        try {
            // Client.archiveChat/unarchiveChat, NOT Chat.archive() — the Chat method resolves void.
            //
            // Their return value is deliberately DISCARDED. Despite looking like a success flag they
            // resolve the chat's NEW ARCHIVE STATE, hard-coded: archiveChat always returns true and
            // unarchiveChat always returns false (Client.js:2009-2031, "Changes and returns the archive
            // state of the Chat"). Surfacing that as `success` reports every successful UNARCHIVE as
            // success:false — which this API's contract defines as "the engine declined to act".
            //
            // whatsapp-web.js offers no refusal signal here at all, so the honest answer is "it did not
            // throw": an unknown chat makes the page-side Cmd.archiveChat reject, which lands below.
            if (archive) {
                await this.client().archiveChat(chatId);
            }
            else {
                await this.client().unarchiveChat(chatId);
            }
            return true;
        }
        catch (error) {
            // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
            rethrowTransportFailure(this.host, error, 'archiveChat', 'archiving a chat');
            this.host.logger.error(`Error ${archive ? 'archiving' : 'unarchiving'} chat ${chatId}`, String(error));
            return false;
        }
    }
    /**
     * whatsapp-web.js signals a chat it cannot resolve by rejecting deep inside the page — `No LID for
     * user` from pin's WID lookup, a TypeError from the evaluate inside `Client._muteUnmuteChat` for
     * mute. Both surfaced as a bare 500, a status neither route declares, while every older member of
     * this family answers an unknown chat gracefully.
     *
     * Resolving the chat first turns that into the 400 the contract already promises. It deliberately
     * does NOT wrap the pin/mute call itself: a page-side rejection for a chat that DOES exist is the
     * one signal a renamed page internal produces, and demoting it to "bad input" would hide a total
     * capability failure — the shape `createGroup` turned out to have. `getChatById` is the same
     * resolution five neighbours here already trust, and it reports an unknown chat either way it can,
     * by resolving undefined or by rejecting.
     */
    async requireResolvableChat(chatId) {
        let chat;
        try {
            chat = await this.client().getChatById(chatId);
        }
        catch (error) {
            // A dead page resolves NOTHING, so swallowing every rejection here reported it as "no such
            // chat" and named the caller's chatId as the problem. The other chat operations split that case
            // out; without this, the same file answered a dead page two different ways.
            rethrowTransportFailure(this.host, error, 'requireResolvableChat', 'resolving a chat');
            chat = undefined; // an unknown chat rejects too — that is the 400 below
        }
        if (!chat)
            throw new common_1.BadRequestException(`Chat ${chatId} does not exist on this session`);
    }
    /**
     * The write leg of mute, pin and the account's own presence. A dead page or an expired protocol
     * timeout is a 503 (mute, unmute, pin, unpin and a presence change all converge when repeated) and
     * a dead page is reported as the early death signal. Any other rejection is rethrown untouched,
     * for the reason above.
     */
    async chatWrite(context, op) {
        try {
            return await op();
        }
        catch (error) {
            (0, wwebjs_host_1.rethrowIfNavigation)(this.host, error);
            if (this.host.isPageTransportError(error)) {
                this.host.reportIfPageTransportError(error, context);
                throw new engine_transport_error_1.EngineTransportError(`Transport died during ${context}`);
            }
            if ((0, wwebjs_lifecycle_1.isProtocolTimeout)(error)) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp Web did not answer in time during ${context}`);
            }
            throw error;
        }
    }
    async muteChat(chatId, muteUntil) {
        this.host.ensureReady();
        await this.requireResolvableChat(chatId);
        if (muteUntil === null) {
            await this.chatWrite('muteChat', () => this.client().unmuteChat(chatId));
            return;
        }
        // muteUntil is epoch milliseconds, which is what Date wants; Client.muteChat floors it to the
        // seconds its page-side call expects. The Baileys side takes the same milliseconds unmodified.
        await this.chatWrite('muteChat', () => this.client().muteChat(chatId, new Date(muteUntil)));
    }
    async pinChat(chatId, pin) {
        this.host.ensureReady();
        // Not `return false` for an unknown chat: `false` is already taken here, and means the three-pin
        // cap refused a real chat. Conflating the two would tell a caller with a stale chatId that its
        // pin quota is full.
        await this.requireResolvableChat(chatId);
        if (!pin) {
            // unpinChat resolves the chat's NEW pin state, which is `false` for every successful unpin —
            // both on its early-out for an already-unpinned chat and after actually unpinning
            // (Client.js:2073-2084). Forwarding it would report every success as a refusal, the same trap
            // archiveChat documents. Discard it: an unpin that did not throw succeeded.
            await this.chatWrite('pinChat', () => this.client().unpinChat(chatId));
            return true;
        }
        // In this direction the return value IS information. WhatsApp caps pinned chats at three
        // (MAX_PIN_COUNT, Client.js:2054-2063) and the page returns false without pinning once that is
        // met, so a false here is a real refusal the caller needs to see.
        return await this.chatWrite('pinChat', () => this.client().pinChat(chatId));
    }
    async markUnread(chatId) {
        this.host.ensureReady();
        if ((0, wa_id_1.isChannelJid)(chatId)) {
            // A channel resolves to a wwebjs `Channel`, which has no markUnread() — there is no unread
            // state to toggle on a channel. Report the no-op rather than throwing a TypeError.
            return false;
        }
        try {
            const chat = await this.client().getChatById(chatId);
            this.host.ensureReady();
            // Chat.markUnread() resolves void, so synthesize the boolean from a clean call.
            await chat.markUnread();
            return true;
        }
        catch (error) {
            // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
            rethrowTransportFailure(this.host, error, 'markUnread', 'marking a chat as unread');
            this.host.logger.error(`Error marking chat ${chatId} as unread`, String(error));
            return false;
        }
    }
    async deleteChat(chatId) {
        this.host.ensureReady();
        if ((0, wa_id_1.isChannelJid)(chatId)) {
            // A channel resolves to a wwebjs `Channel`, which has no delete() (only the destructive
            // deleteChannel()); a generic chat-delete must not silently unsubscribe a channel.
            return false;
        }
        try {
            const chat = await this.client().getChatById(chatId);
            this.host.ensureReady();
            return await chat.delete();
        }
        catch (error) {
            // A dead page is a 503 and an early death signal, not an opaque `false` (see rethrowTransportFailure).
            rethrowTransportFailure(this.host, error, 'deleteChat', 'deleting a chat');
            this.host.logger.error(`Error deleting chat ${chatId}`, String(error));
            return false;
        }
    }
    /**
     * Publish the account's own GLOBAL presence. Not best-effort, unlike sendChatState: the caller
     * asked for a specific visibility, and swallowing a failure would leave the account silently
     * online after the API reported otherwise (#871 — an always-online bot suppresses the phone's
     * own notifications).
     */
    async setOnlinePresence(available) {
        this.host.ensureReady();
        await this.chatWrite('setOnlinePresence', () => available ? this.client().sendPresenceAvailable() : this.client().sendPresenceUnavailable());
    }
    async sendChatState(chatId, state) {
        this.host.ensureReady();
        if ((0, wa_id_1.isChannelJid)(chatId)) {
            // A channel resolves to a wwebjs `Channel`, which has no presence methods
            // (sendStateTyping/sendStateRecording/clearState). Presence is best-effort, so no-op.
            return;
        }
        try {
            const to = await this.messaging.resolveSendId(chatId);
            const chat = await this.client().getChatById(to);
            if (state === 'typing') {
                await chat.sendStateTyping();
            }
            else if (state === 'recording') {
                await chat.sendStateRecording();
            }
            else {
                await chat.clearState();
            }
        }
        catch (error) {
            // Presence is best-effort and already swallowed here — it never breaks the surrounding send —
            // so log at WARN, not ERROR: a migrated contact routinely yields `No LID for user` on the
            // presence path and an ERROR line reads as a fault when nothing actually failed (#582).
            this.host.logger.warn(`Could not set chat state '${state}' for ${chatId} (best-effort)`, {
                error: String(error),
            });
        }
    }
}
exports.WwebjsChats = WwebjsChats;
