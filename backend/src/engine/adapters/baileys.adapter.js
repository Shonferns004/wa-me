"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysAdapter = exports.createProxyAgent = void 0;
const chat_labels_unsupported_error_1 = require("../../common/errors/chat-labels-unsupported.error");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const wa_id_1 = require("../identity/wa-id");
const baileys_channels_1 = require("./baileys-channels");
const baileys_catalog_1 = require("./baileys-catalog");
const baileys_contacts_1 = require("./baileys-contacts");
const baileys_events_1 = require("./baileys-events");
const baileys_groups_1 = require("./baileys-groups");
const baileys_history_1 = require("./baileys-history");
const baileys_own_sends_1 = require("./baileys-own-sends");
const baileys_lifecycle_1 = require("./baileys-lifecycle");
const baileys_messaging_1 = require("./baileys-messaging");
const baileys_status_1 = require("./baileys-status");
const engine_not_supported_error_1 = require("../../common/errors/engine-not-supported.error");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const engine_not_sent_error_1 = require("../../common/errors/engine-not-sent.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const common_1 = require("@nestjs/common");
const logger_service_1 = require("../../common/services/logger.service");
const auth_dir_paths_1 = require("../auth-dir-paths");
const baileys_session_store_1 = require("./baileys-session-store");
const inbound_media_cap_1 = require("./inbound-media-cap");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const baileys_query_deadline_1 = require("./baileys-query-deadline");
// The implementation moved with connectInner to BaileysLifecycle; it remains part of this module's
// public surface (imported from './baileys.adapter' by the spec).
var baileys_lifecycle_2 = require("./baileys-lifecycle");
Object.defineProperty(exports, "createProxyAgent", { enumerable: true, get: function () { return baileys_lifecycle_2.createProxyAgent; } });
class BaileysAdapter {
    config;
    contactPhoneLookupPersistence = 'seed';
    logger = (0, logger_service_1.createLogger)('BaileysAdapter');
    // Bound concurrent inbound media downloads: each materialises a full decrypted buffer in heap, so an
    // unbounded fire-and-forget loop lets a sender flood the gateway with N parallel multi-MB allocations.
    //
    // The QUEUE is deliberately unbounded. handleMessagesUpsert submits a whole upsert synchronously,
    // so admission is decided before any download finishes: a queue capped at the active slots admitted
    // a constant 2n regardless of batch size, and everything past it was re-processed with skipMedia —
    // a 40-message upsert lost the media of 32. A parked closure holds the message, not the file, and
    // inbound-media-cap.ts bounds what any one download may allocate, so capping the queue again needs
    // a threshold an ordinary burst does not reach. That is its own question.
    inboundLimiter = new concurrency_limiter_1.ConcurrencyLimiter((0, inbound_media_cap_1.inboundMediaConcurrency)());
    authPath;
    sessionStore;
    groups;
    messaging;
    contacts;
    statusOps;
    channels;
    catalog;
    history;
    events;
    lifecycle;
    callbacks = {};
    /** Connection-lifecycle state is owned by the lifecycle delegate; these accessors alias it by
     *  reference so delegate host closures (and an unmodified spec poking `adapter.sock` via a cast)
     *  keep working byte-identically — the liveCalls precedent below. */
    get sock() {
        return this.lifecycle.sock;
    }
    set sock(value) {
        this.lifecycle.sock = value;
    }
    /** Live-call cache handle: the map is owned by the events delegate (call events + rejectCall);
     *  lifecycle teardown clears it so a late rejectCall() reports not-found on a dead socket. The
     *  adapter keeps this alias for the unmodified spec, which reads `adapter.liveCalls` via a cast. */
    get liveCalls() {
        return this.events.liveCalls;
    }
    /** Lazily loaded @whiskeysockets/baileys module (ESM-only; loaded on first connect, not at boot). */
    loadLib() {
        return this.lifecycle.loadLib();
    }
    /** Ids of the messages this session sent through the API, until each one's library echo returns. */
    ownSends = new baileys_own_sends_1.OwnSendRegistry();
    constructor(config) {
        this.config = config;
        // Isolate each session's auth state under its own subdirectory of the shared auth dir.
        this.authPath = (0, auth_dir_paths_1.baileysAuthDir)(config.authDir, config.sessionId);
        this.sessionStore = new baileys_session_store_1.BaileysSessionStore(config.lidMappingStore, config.sessionId, config.chatStateStore);
        // Constructed before messaging: the messaging delegate's own-send echo maps through
        // events.mapMessage (and the lifecycle delegate clears that same live-call cache on teardown).
        // One host literal for every delegate (the wwebjs-host pattern): a new cross-cutting member
        // is added once here, not to nine per-delegate bags. Each delegate keeps its own narrow Host
        // interface, which this literal satisfies structurally - least privilege stays enforceable.
        const delegates = {};
        const host = {
            // Read after a delegate's awaits too, when a stop or logout may have torn the socket down since
            // its readiness check: that is a not-ready session (409), not a null dereference (500).
            getSocket: () => {
                if (!this.sock)
                    throw new engine_not_ready_error_1.EngineNotReadyError();
                return this.sock;
            },
            getSocketOrNull: () => this.sock,
            logger: this.logger,
            toNeutralJid: jid => {
                const ownLid = this.sock?.user?.lid;
                if (ownLid && (0, wa_id_1.parseWaId)(jid).kind === 'lid' && (0, wa_id_1.parseWaId)(jid).userPart === (0, wa_id_1.parseWaId)(ownLid).userPart) {
                    return (0, wa_id_1.toNeutralJid)(this.normalizedSelfJid());
                }
                return this.sessionStore.toNeutralJid(jid);
            },
            normalizedSelfJid: () => this.normalizedSelfJid(),
            loadLib: () => this.loadLib(),
            getFetchDispatcher: () => this.lifecycle.fetchDispatcher(),
            sessionProxyUrl: () => this.config.proxyUrl,
            toUnixSeconds: baileys_history_1.toUnixSeconds,
            inboundLimiter: this.inboundLimiter,
            recordKeyLidMappings: key => this.sessionStore.recordKeyLidMappings(key),
            recordMessage: (msg, type, order) => this.sessionStore.recordMessage(msg, type, order),
            nextMessageOrder: () => this.sessionStore.nextMessageOrder(),
            recordMessageEdit: (chatId, messageId, text, type, accept) => this.sessionStore.recordMessageEdit(chatId, messageId, text, type, accept),
            putStoredMessage: msg => this.config.messageStore?.put(this.config.dbSessionId, msg),
            updateStoredMessage: (messageId, change) => this.config.messageStore?.update(this.config.dbSessionId, messageId, change),
            removeStoredMessage: (messageId, shouldRemove) => this.config.messageStore?.remove(this.config.dbSessionId, messageId, shouldRemove),
            wasDeletedForEveryone: messageId => this.events.wasDeletedForEveryone(messageId),
            markDeletedForEveryone: messageId => this.events.markDeletedForEveryone(messageId),
            applyHistoryRevoke: (target, envelope) => this.events.applyHistoryRevoke(target, envelope),
            pendingEditOf: (messageId, target) => this.events.pendingEditOf(messageId, target),
            rememberOwnSend: id => this.ownSends.remember(id),
            consumeOwnSend: id => this.ownSends.consume(id),
            getAdmitInbound: () => this.callbacks.admitInbound,
            getLoadedLib: () => this.lifecycle.loadedLib,
            getOnMessage: () => this.callbacks.onMessage,
            getOnMessageCreate: () => this.callbacks.onMessageCreate,
            getOnMessageRevoked: () => this.callbacks.onMessageRevoked,
            getOnMessageEdited: () => this.callbacks.onMessageEdited,
            getOnMessageReaction: () => this.callbacks.onMessageReaction,
            getOnMessageAck: () => this.callbacks.onMessageAck,
            getOnMessageReceipt: () => this.callbacks.onMessageReceipt,
            getOnGroupEvent: () => this.callbacks.onGroupEvent,
            getOnEventResponse: () => this.callbacks.onEventResponse,
            getOnCall: () => this.callbacks.onCall,
            getOnPresenceUpdate: () => this.callbacks.onPresenceUpdate,
            getOnCallOutcome: () => this.callbacks.onCallOutcome,
            ensureReady: () => this.ensureReady(),
            toEngineJid: jid => this.sessionStore.toEngineJid(jid),
            chatJid: chatId => this.sessionStore.chatJid(chatId),
            forgetGroupMetadata: groupId => this.lifecycle.groupMetadata.invalidate(groupId),
            getEphemeralExpiration: chatId => this.sessionStore.getEphemeralExpiration(chatId),
            getStoredMessage: messageId => this.config.messageStore?.getMessage(this.config.dbSessionId, messageId),
            getStoredMessages: messageIds => this.config.messageStore?.getMessages(this.config.dbSessionId, messageIds),
            recordLidMapping: (lid, pn, isReported = true) => this.sessionStore.addLidMappings([{ lid: `${lid.split('@')[0].split(':')[0]}@lid`, pn }], isReported),
            mapMessage: (msg, contentType, opts) => this.events.mapMessage(msg, contentType, opts),
            listContacts: () => this.sessionStore.listContacts(),
            contactCount: () => this.sessionStore.listContacts().length,
            findContact: contactId => this.sessionStore.findContact(contactId),
            resolvePhone: contactId => this.sessionStore.resolvePhone(contactId),
            findPersistedLidPhone: lid => this.config.lidMappingStore?.findPhoneForLid?.(lid) ?? Promise.resolve(null),
            listChats: () => this.sessionStore.listChats(),
            lastMessage: chatId => this.sessionStore.lastMessage(chatId),
            lastInboundMessage: chatId => this.sessionStore.lastInboundMessage(chatId),
            lidOf: jid => this.sessionStore.lidOf(jid),
            chatTwins: jid => this.sessionStore.chatTwins(jid),
            chatDeletedAt: chatId => this.sessionStore.chatDeletedAt(chatId),
            upsertContacts: records => this.sessionStore.upsertContacts(records),
            upsertChats: records => this.sessionStore.upsertChats(records),
            removeChats: ids => this.sessionStore.removeChats(ids),
            extractEphemeralDuration: msg => this.sessionStore.extractEphemeralDuration(msg),
            getOnHistoryMessages: () => this.callbacks.onHistoryMessages,
            getStoredWriteGeneration: () => this.events.getStoredWriteGeneration(),
            authPath: this.authPath,
            config: this.config,
            // A getter so the events delegate exists by first read: the literal is built before the
            // delegates are constructed, and the OLD wiring captured this.events.liveCalls eagerly -
            // a stable readonly reference owned by BaileysEvents. The indirection defers the capture.
            get liveCalls() {
                // Construction order guarantees the events delegate exists before lifecycle first reads
                // this (lifecycle is constructed last and only USES the bag during socket events).
                return delegates.events.liveCalls;
            },
            extractPhone: id => this.extractPhone(id),
            addLidMappings: mappings => this.sessionStore.addLidMappings(mappings),
            handleMessagesUpsert: event => this.events.handleMessagesUpsert(event),
            handleMessagesUpdate: updates => this.events.handleMessagesUpdate(updates),
            handleMessageReceiptUpdate: updates => this.events.handleMessageReceiptUpdate(updates),
            logContactEvent: (event, records) => this.events.logContactEvent(event, records),
            handleGroupParticipantsUpdate: event => this.events.handleGroupParticipantsUpdate(event),
            handleGroupsUpdate: updates => this.events.handleGroupsUpdate(updates),
            handleGroupsUpsert: groups => this.events.handleGroupsUpsert(groups),
            handleGroupJoinRequest: event => this.events.handleGroupJoinRequest(event),
            handleCallEvents: calls => this.events.handleCallEvents(calls),
            handlePresenceUpdate: update => this.events.handlePresenceUpdate(update),
            fenceStoredWrites: () => this.events.fenceStoredWrites(),
            captureHistoryMessages: messages => this.history.captureHistoryMessages(messages),
            hydrateNames: () => this.history.hydrateNames(),
            restoreAddressbookSnapshot: () => this.history.restoreAddressbookSnapshot(),
            getOnQRCode: () => this.callbacks.onQRCode,
            getOnReady: () => this.callbacks.onReady,
            getOnDisconnected: () => this.callbacks.onDisconnected,
            getOnReconnecting: () => this.callbacks.onReconnecting,
            getOnError: () => this.callbacks.onError,
            getOnStateChanged: () => this.callbacks.onStateChanged,
            getOnCredentialTeardownStarted: () => this.callbacks.onCredentialTeardownStarted,
            getOnAccountRestriction: () => this.callbacks.onAccountRestriction,
        };
        delegates.events = this.events = new baileys_events_1.BaileysEvents(host);
        this.groups = new baileys_groups_1.BaileysGroups(host);
        this.messaging = new baileys_messaging_1.BaileysMessaging(host);
        this.contacts = new baileys_contacts_1.BaileysContacts(host);
        this.statusOps = new baileys_status_1.BaileysStatus(host);
        this.channels = new baileys_channels_1.BaileysChannels(host);
        this.catalog = new baileys_catalog_1.BaileysCatalog(host);
        this.history = new baileys_history_1.BaileysHistory(host);
        this.lifecycle = new baileys_lifecycle_1.BaileysLifecycle(host);
    }
    // ----- Lifecycle -----
    async initialize(callbacks) {
        this.callbacks = callbacks;
        await (0, baileys_messaging_1.blockSvgDecoding)();
        return this.lifecycle.initialize();
    }
    disconnect() {
        return this.lifecycle.disconnect();
    }
    async logout() {
        return this.lifecycle.logout();
    }
    destroy() {
        return this.lifecycle.destroy();
    }
    // Baileys has no separate Chromium process to SIGKILL (destroy() already ends the socket
    // synchronously), so a force-destroy is just a destroy.
    forceDestroy() {
        return this.lifecycle.forceDestroy();
    }
    // ----- Status -----
    getStatus() {
        return this.lifecycle.getStatus();
    }
    async probeLiveness() {
        return this.lifecycle.probeLiveness();
    }
    getQRCode() {
        return this.lifecycle.getQRCode();
    }
    async requestPairingCode(phoneNumber) {
        return this.lifecycle.requestPairingCode(phoneNumber);
    }
    getPhoneNumber() {
        return this.lifecycle.getPhoneNumber();
    }
    getPushName() {
        return this.lifecycle.getPushName();
    }
    // ----- Messaging -----
    async sendTextMessage(chatId, text, mentions, options) {
        return this.messaging.sendTextMessage(chatId, text, mentions, options);
    }
    async checkNumberExists(number) {
        return this.messaging.checkNumberExists(number);
    }
    async getNumberId(number) {
        return this.messaging.getNumberId(number);
    }
    async sendChatState(chatId, state) {
        return this.messaging.sendChatState(chatId, state);
    }
    async setOnlinePresence(available) {
        return this.messaging.setOnlinePresence(available);
    }
    async sendImageMessage(chatId, media) {
        return this.messaging.sendImageMessage(chatId, media);
    }
    async sendVideoMessage(chatId, media) {
        return this.messaging.sendVideoMessage(chatId, media);
    }
    async sendAudioMessage(chatId, media) {
        return this.messaging.sendAudioMessage(chatId, media);
    }
    async sendDocumentMessage(chatId, media) {
        return this.messaging.sendDocumentMessage(chatId, media);
    }
    async sendStickerMessage(chatId, media) {
        return this.messaging.sendStickerMessage(chatId, media);
    }
    async sendLocationMessage(chatId, location) {
        return this.messaging.sendLocationMessage(chatId, location);
    }
    async sendContactMessage(chatId, contact) {
        return this.messaging.sendContactMessage(chatId, contact);
    }
    async sendPollMessage(chatId, poll) {
        return this.messaging.sendPollMessage(chatId, poll);
    }
    async replyToMessage(chatId, quotedMsgId, text, mentions) {
        return this.messaging.replyToMessage(chatId, quotedMsgId, text, mentions);
    }
    async forwardMessage(fromChatId, toChatId, messageId) {
        return this.messaging.forwardMessage(fromChatId, toChatId, messageId);
    }
    async reactToMessage(chatId, messageId, emoji) {
        return this.messaging.reactToMessage(chatId, messageId, emoji);
    }
    async deleteMessage(chatId, messageId, forEveryone = true) {
        return this.messaging.deleteMessage(chatId, messageId, forEveryone);
    }
    async starMessage(chatId, messageId, star) {
        return this.messaging.starMessage(chatId, messageId, star);
    }
    async pinMessage(chatId, messageId, durationSeconds) {
        return this.messaging.pinMessage(chatId, messageId, durationSeconds);
    }
    async unpinMessage(chatId, messageId) {
        return this.messaging.unpinMessage(chatId, messageId);
    }
    async clickButton(chatId, messageId, buttonId, text) {
        return this.messaging.clickButton(chatId, messageId, buttonId, text);
    }
    async editMessage(chatId, messageId, body, mentions) {
        return this.messaging.editMessage(chatId, messageId, body, mentions);
    }
    // ----- Groups -----
    async getGroups() {
        return this.groups.getGroups();
    }
    async getGroupInfo(groupId) {
        return this.groups.getGroupInfo(groupId);
    }
    async createGroup(name, participants) {
        return this.groups.createGroup(name, participants);
    }
    async addParticipants(groupId, participants) {
        return this.groups.addParticipants(groupId, participants);
    }
    async removeParticipants(groupId, participants) {
        return this.groups.removeParticipants(groupId, participants);
    }
    async promoteParticipants(groupId, participants) {
        return this.groups.promoteParticipants(groupId, participants);
    }
    async demoteParticipants(groupId, participants) {
        return this.groups.demoteParticipants(groupId, participants);
    }
    async leaveGroup(groupId) {
        return this.groups.leaveGroup(groupId);
    }
    async setGroupSubject(groupId, subject) {
        return this.groups.setGroupSubject(groupId, subject);
    }
    async setGroupDescription(groupId, description) {
        return this.groups.setGroupDescription(groupId, description);
    }
    async getGroupInviteCode(groupId) {
        return this.groups.getGroupInviteCode(groupId);
    }
    async revokeGroupInviteCode(groupId) {
        return this.groups.revokeGroupInviteCode(groupId);
    }
    getGroupJoinInfo(inviteCode) {
        return this.groups.getGroupJoinInfo(inviteCode);
    }
    async joinGroupViaInviteCode(inviteCode) {
        return this.groups.joinGroupViaInviteCode(inviteCode);
    }
    async setGroupMessagesAdminsOnly(groupId, adminsOnly) {
        return this.groups.setGroupMessagesAdminsOnly(groupId, adminsOnly);
    }
    async setGroupInfoAdminsOnly(groupId, adminsOnly) {
        return this.groups.setGroupInfoAdminsOnly(groupId, adminsOnly);
    }
    async setGroupMemberAddMode(groupId, mode) {
        return this.groups.setGroupMemberAddMode(groupId, mode);
    }
    async setGroupPicture(groupId, media) {
        return this.groups.setGroupPicture(groupId, media);
    }
    async deleteGroupPicture(groupId) {
        return this.groups.deleteGroupPicture(groupId);
    }
    async setGroupEphemeral(groupId, durationSec) {
        return this.groups.setGroupEphemeral(groupId, durationSec);
    }
    async setGroupMemberLabel(groupId, label) {
        return this.groups.setGroupMemberLabel(groupId, label);
    }
    async getGroupMembershipRequests(groupId) {
        return this.groups.getGroupMembershipRequests(groupId);
    }
    async approveGroupMembershipRequests(groupId, participants) {
        return this.groups.approveGroupMembershipRequests(groupId, participants);
    }
    async rejectGroupMembershipRequests(groupId, participants) {
        return this.groups.rejectGroupMembershipRequests(groupId, participants);
    }
    async getProfilePicture(contactId) {
        return this.contacts.getProfilePicture(contactId);
    }
    async blockContact(contactId) {
        return this.contacts.blockContact(contactId);
    }
    async upsertContact(contactId, firstName, lastName) {
        return this.contacts.upsertContact(contactId, firstName, lastName);
    }
    async deleteContact(contactId) {
        return this.contacts.deleteContact(contactId);
    }
    async unblockContact(contactId) {
        return this.contacts.unblockContact(contactId);
    }
    async getBlockedContacts() {
        return this.contacts.getBlockedContacts();
    }
    // ----- Profile (own account) -----
    async setProfileName(name) {
        return this.contacts.setProfileName(name);
    }
    async setProfileStatus(status) {
        return this.contacts.setProfileStatus(status);
    }
    async deleteProfilePicture() {
        return this.contacts.deleteProfilePicture();
    }
    async setProfilePicture(media) {
        return this.contacts.setProfilePicture(media);
    }
    // ----- Contacts & chats -----
    async getContacts() {
        return this.contacts.getContacts();
    }
    async getContactById(contactId) {
        return this.contacts.getContactById(contactId);
    }
    async resolveContactPhone(contactId) {
        return this.contacts.resolveContactPhone(contactId);
    }
    async getChats() {
        return this.contacts.getChats();
    }
    async subscribeToPresence(chatId) {
        return this.messaging.subscribeToPresence(chatId);
    }
    async sendSeen(chatId, messageIds, authors, stored) {
        return this.contacts.sendSeen(chatId, messageIds, authors, stored);
    }
    async markUnread(chatId, stored) {
        return this.contacts.markUnread(chatId, stored);
    }
    async deleteChat(chatId, stored) {
        return this.contacts.deleteChat(chatId, stored);
    }
    async muteChat(chatId, muteUntil) {
        return this.contacts.muteChat(chatId, muteUntil);
    }
    async pinChat(chatId, pin) {
        return this.contacts.pinChat(chatId, pin);
    }
    async archiveChat(chatId, archive, stored) {
        return this.contacts.archiveChat(chatId, archive, stored);
    }
    async clearChatMessages(chatId, stored) {
        return this.contacts.clearChatMessages(chatId, stored);
    }
    // ----- Gated: unsupported on Baileys (reasons inline) -----
    /* eslint-disable @typescript-eslint/no-unused-vars */
    getMessageReactions(_chatId, _messageId) {
        return this.unsupported('getMessageReactions');
    }
    // Baileys exposes label WRITES only — chats.d.ts:69-73 has addLabel/addChatLabel/removeChatLabel
    // and no query of any kind, and Types/Label.d.ts is types-only. Listing the chats on a label would
    // mean maintaining an app-state cache fed by the label-association sync events, which is a
    // separate piece of work from this one and is tracked as such.
    getChatsByLabel(_labelId) {
        return this.unsupported('getChatsByLabel');
    }
    // No vote-send helper exists in Baileys — only decryptPollVote for RECEIVING. Sending one needs a
    // hand-built proto.Message.PollUpdateMessage with HMAC-SHA256 vote encryption keyed by the poll
    // creation's messageSecret.
    votePoll(_chatId, _pollMessageId, _options) {
        return this.unsupported('votePoll');
    }
    getChatHistory(_chatId, _limit, _includeMedia, _mediaMaxBytes, _signal) {
        return this.unsupported('getChatHistory');
    }
    getLabels() {
        return this.unsupported('getLabels');
    }
    getLabelById(_labelId) {
        return this.unsupported('getLabelById');
    }
    getChatLabels(_chatId) {
        return this.unsupported('getChatLabels');
    }
    // WhatsApp Business only — Baileys rejects these on personal accounts. The label must already
    // exist (use getLabels on an engine that lists them); addChatLabel/removeChatLabel associate it
    // with a chat, they do not create/edit the label definition.
    // Resolve to the jid the chat is keyed under first (its lid for a lid-migrated contact, the engine
    // form for a chat the store does not know): chatModify (which both calls wrap) keys the label
    // app-state index by the RAW jid, so any other spelling labels a phantom chat the phone never
    // reads, reported as success.
    /**
     * Labels are a Business-account chat feature and WhatsApp has no concept of labelling a channel.
     * whatsapp-web.js refuses a channel jid outright; this engine forwarded it and answered success
     * while nothing was labelled, so the same request reported two different outcomes per engine.
     */
    assertLabelable(chatId) {
        if ((0, wa_id_1.isChannelJid)(chatId)) {
            throw new chat_labels_unsupported_error_1.ChatLabelsUnsupportedError('Channels do not support chat labels.');
        }
    }
    async addLabelToChat(chatId, labelId) {
        this.ensureReady();
        this.assertLabelable(chatId);
        const socket = this.sock;
        const jid = await this.contacts.confirmedChatJid(chatId);
        this.ensureReady();
        if (this.sock !== socket)
            throw new engine_not_ready_error_1.EngineNotReadyError();
        await (0, baileys_query_deadline_1.withQueryDeadline)(socket.addChatLabel(jid, labelId), baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS, 'WhatsApp did not confirm the chat label add in time');
    }
    async removeLabelFromChat(chatId, labelId) {
        this.ensureReady();
        this.assertLabelable(chatId);
        const socket = this.sock;
        const jid = await this.contacts.confirmedChatJid(chatId);
        this.ensureReady();
        if (this.sock !== socket)
            throw new engine_not_ready_error_1.EngineNotReadyError();
        await (0, baileys_query_deadline_1.withQueryDeadline)(socket.removeChatLabel(jid, labelId), baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS, 'WhatsApp did not confirm the chat label removal in time');
    }
    /**
     * Create or update a label.
     *
     * WhatsApp models this as ONE app-state write — a `label_edit` patch indexed by the label id — so
     * create and update are the same operation, distinguished only by whether the id already exists.
     * That is why the id is caller-supplied rather than returned.
     *
     * The `jid` Baileys asks for is unused on this patch: `chatModifyToPatch` builds the index from
     * `['label_edit', id]` and never reads it (Utils/chat-utils.js:579-593). The account's own jid is
     * passed because the call demands one, not because it addresses anything.
     */
    async upsertLabel(label) {
        this.ensureReady();
        // Unset fields are passed through as undefined rather than stripped: the protobuf encoder skips
        // a field that is `!= null` false, exactly as it skips a missing one (WAProto/index.js,
        // LabelEditAction.encode). That does not make the write partial: the patch is an app-state SET
        // on ['label_edit', id], which replaces the stored action whole, so an omitted name is not kept
        // (Utils/chat-utils.js builds it with OP.SET and the receiver applies it without a merge). Colour 0
        // is a real WhatsApp colour and survives that check — which is why it must never be tested for
        // truthiness on the way here.
        await (0, baileys_query_deadline_1.withQueryDeadline)(this.sock.addLabel(this.ownJidForAppState(), { id: label.id, name: label.name, color: label.color }), baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS, 'WhatsApp did not confirm the label save in time');
    }
    /** Delete a label. The same `label_edit` write, with the tombstone flag set. */
    async deleteLabel(labelId) {
        this.ensureReady();
        await (0, baileys_query_deadline_1.withQueryDeadline)(this.sock.addLabel(this.ownJidForAppState(), { id: labelId, deleted: true }), baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS, 'WhatsApp did not confirm the label delete in time');
    }
    /**
     * A jid for the label-edit app-state write, which needs one but never uses it. The account's own
     * id is the honest choice — the write is about this account, not about a conversation.
     */
    ownJidForAppState() {
        return this.sock?.user?.id ?? 'status@broadcast';
    }
    createChannel(name, description) {
        return this.channels.createChannel(name, description);
    }
    deleteChannel(channelId) {
        return this.channels.deleteChannel(channelId);
    }
    muteChannel(channelId, mute) {
        return this.channels.muteChannel(channelId, mute);
    }
    demoteChannelAdmin(channelId, userId) {
        return this.channels.demoteChannelAdmin(channelId, userId);
    }
    transferChannelOwnership(channelId, newOwnerId) {
        return this.channels.transferChannelOwnership(channelId, newOwnerId);
    }
    getSubscribedChannels() {
        return this.unsupported('getSubscribedChannels');
    }
    async getChannelById(channelId) {
        return this.channels.getChannelById(channelId);
    }
    async subscribeToChannel(inviteCode) {
        return this.channels.subscribeToChannel(inviteCode);
    }
    async unsubscribeFromChannel(channelId) {
        return this.channels.unsubscribeFromChannel(channelId);
    }
    // getChannelMessages is not wired: Baileys' newsletterFetchMessages returns the RAW query
    // BinaryNode with no library parser, so mapping it to ChannelMessage[] needs a verified
    // BinaryNode walk (or a live spike) that can't be validated without a WhatsApp session. Kept as a
    // documented adapter-gap in the engine capability matrix rather than shipped as an unverified walk.
    getChannelMessages(_channelId, _limit) {
        return this.unsupported('getChannelMessages');
    }
    getContactStatuses() {
        return this.unsupported('getContactStatuses');
    }
    getContactStatus(_contactId) {
        return this.unsupported('getContactStatus');
    }
    postTextStatus(text, options) {
        return this.statusOps.postTextStatus(text, options);
    }
    postImageStatus(media, options) {
        return this.statusOps.postImageStatus(media, options);
    }
    postVideoStatus(media, options) {
        return this.statusOps.postVideoStatus(media, options);
    }
    postVoiceStatus(media, options) {
        return this.statusOps.postVoiceStatus(media, options);
    }
    async deleteStatus(statusId) {
        return this.statusOps.deleteStatus(statusId);
    }
    getCatalog() {
        return this.catalog.getCatalog();
    }
    getProducts(options) {
        return this.catalog.getProducts(options);
    }
    getProduct(productId) {
        return this.catalog.getProduct(productId);
    }
    async sendProduct(chatId, productId, body) {
        const product = await this.catalog.getProduct(productId).catch((error) => {
            // Still 403, but no longer an EngineRefusedError: the send breaker counts WhatsApp refusing a
            // send, and a catalog read it refused says nothing about the account's send standing.
            if (error instanceof engine_refused_error_1.EngineRefusedError)
                throw new common_1.ForbiddenException(error.message);
            // A lookup that timed out or was throttled failed before the message was handed to WhatsApp.
            if (error instanceof engine_transport_error_1.EngineTransportError)
                throw new engine_not_sent_error_1.EngineNotSentError(error.message);
            throw error;
        });
        if (!product) {
            throw new common_1.NotFoundException(`Product ${productId} not found in the session catalog`);
        }
        return this.messaging.sendProductMessage(chatId, product, body);
    }
    // No catalog-level message primitive exists in Baileys (only the single-product {product}
    // content), so sendCatalog stays a documented library limitation.
    sendCatalog(_chatId, _body) {
        return this.unsupported('sendCatalog');
    }
    /* eslint-enable @typescript-eslint/no-unused-vars */
    // ----- Events -----
    createCallLink(type, startTime) {
        return this.messaging.createCallLink(type, startTime);
    }
    async rejectCall(callId) {
        return this.events.rejectCall(callId);
    }
    // ----- Helpers -----
    normalizedSelfJid() {
        const phone = this.extractPhone(this.sock?.user?.id);
        return phone ? `${phone}@s.whatsapp.net` : '';
    }
    unsupported(method) {
        return Promise.reject(new engine_not_supported_error_1.EngineNotSupportedError(method));
    }
    ensureReady() {
        this.lifecycle.ensureReady();
    }
    /** `628999:12@s.whatsapp.net` / `628999@s.whatsapp.net` -> `628999`. */
    extractPhone(id) {
        if (!id) {
            return null;
        }
        return id.split(':')[0].split('@')[0] || null;
    }
}
exports.BaileysAdapter = BaileysAdapter;
