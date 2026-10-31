"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsAppWebJsAdapter = void 0;
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const engine_not_supported_error_1 = require("../../common/errors/engine-not-supported.error");
const wa_id_1 = require("../identity/wa-id");
const logger_service_1 = require("../../common/services/logger.service");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const channel_media_not_supported_error_1 = require("../../common/errors/channel-media-not-supported.error");
const wwebjs_groups_1 = require("./wwebjs-groups");
const wwebjs_message_events_1 = require("./wwebjs-message-events");
const wwebjs_messaging_1 = require("./wwebjs-messaging");
const wwebjs_contacts_1 = require("./wwebjs-contacts");
const wwebjs_profile_1 = require("./wwebjs-profile");
const wwebjs_labels_1 = require("./wwebjs-labels");
const wwebjs_channels_1 = require("./wwebjs-channels");
const wwebjs_status_1 = require("./wwebjs-status");
const wwebjs_chats_1 = require("./wwebjs-chats");
const wwebjs_catalog_1 = require("./wwebjs-catalog");
const wwebjs_group_events_1 = require("./wwebjs-group-events");
const wwebjs_onboarding_1 = require("./wwebjs-onboarding");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const wwebjs_reconcile_1 = require("./wwebjs-reconcile");
const wwebjs_stuck_auth_1 = require("./wwebjs-stuck-auth");
const wwebjs_calls_1 = require("./wwebjs-calls");
const inbound_media_cap_1 = require("./inbound-media-cap");
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const whatsapp_web_js_types_1 = require("../types/whatsapp-web-js.types");
// WhatsApp Web version resolution (the #488 auto-resolve) lives in a dependency-free module so infra
// status can import it without loading whatsapp-web.js (engine lazy-loading). The lifecycle delegate
// imports resolveWebVersionPin for use in initialize().
class WhatsAppWebJsAdapter {
    config;
    contactPhoneLookupPersistence = 'seed';
    logger = (0, logger_service_1.createLogger)('WhatsAppWebJsAdapter');
    // Bound concurrent inbound media downloads: each one holds the whole decrypted file in the browser
    // page and, when within the cap, its base64 in Node, so an unbounded burst could stack many multi-MB
    // allocations.
    // The queue is UNBOUNDED. A cap equal to the active slots made admission a constant
    // (active + queued) whatever the batch size, so a burst lost the media of everything past the
    // eighth — the same defect repaired on the Baileys side. Parking costs one held Message per
    // waiting download, and only the download runs inside the limiter: each message awaits its own
    // capInboundMediaFor, so a parked one delays itself and a text message never enters the gate.
    inboundLimiter = new concurrency_limiter_1.ConcurrencyLimiter((0, inbound_media_cap_1.inboundMediaConcurrency)());
    callbacks = {};
    host;
    groups;
    messaging;
    contacts;
    profile;
    labels;
    channels;
    statuses;
    chats;
    catalog;
    lifecycle;
    reconcile;
    stuckAuth;
    calls;
    onboardingWatcher;
    // Connection-lifecycle state is owned by the lifecycle delegate (./wwebjs-lifecycle); these
    // accessors alias it by reference so the host closures below, and a spec poking `adapter.client`,
    // `adapter.status` or `adapter.tearingDown` through a cast, all see the delegate's state.
    get client() {
        return this.lifecycle.client;
    }
    set client(value) {
        this.lifecycle.client = value;
    }
    get status() {
        return this.lifecycle.status;
    }
    set status(value) {
        this.lifecycle.status = value;
    }
    get qrCode() {
        return this.lifecycle.qrCode;
    }
    get tearingDown() {
        return this.lifecycle.tearingDown;
    }
    set tearingDown(value) {
        this.lifecycle.tearingDown = value;
    }
    get logoutInitiated() {
        return this.lifecycle.logoutInitiated;
    }
    set logoutInitiated(value) {
        this.lifecycle.logoutInitiated = value;
    }
    get disconnectReported() {
        return this.lifecycle.disconnectReported;
    }
    set disconnectReported(value) {
        this.lifecycle.disconnectReported = value;
    }
    constructor(config) {
        this.config = config;
        // API-surface clusters live in ./wwebjs-* delegates; the public methods below forward to them.
        // The host is one object literal shared by every delegate, and closures (not a `this` reference)
        // keep the delegates' surface exactly this narrow. Built in the constructor, not as a field
        // initializer: `config` is a parameter property, which field initializers read before assignment.
        this.host = {
            ensureReady: () => this.ensureReady(),
            // A delegate reads the client after ensureReady() and often after awaits of its own (a recipient
            // lookup, a media fetch, a chat lookup). A teardown in that gap leaves the client set but closing,
            // or nulls it, so readiness is checked again here: the retryable 409 instead of a closed-target or
            // TypeError 500 that a send also counts toward the send breaker.
            getClient: () => {
                this.ensureReady();
                return this.client;
            },
            logger: this.logger,
            isPageTransportError: error => this.isPageTransportError(error),
            reportIfPageTransportError: (error, context) => this.reportIfPageTransportError(error, context),
            reportOnceGone: (error, context) => this.lifecycle.reportOnceGone(error, context),
            ensureNotChannelRecipient: chatId => this.ensureNotChannelRecipient(chatId),
            // The raw answer, `@lid` included: the send resolver addresses a migrated contact by it, while the
            // public getNumberId reports the neutral phone id.
            getNumberId: number => this.contacts.lookupNumberId(number),
            capInboundMediaFor: (msg, maxBytesOverride, ticket) => this.capInboundMediaFor(msg, maxBytesOverride, ticket),
            config: this.config,
            getCallbacks: () => this.callbacks,
        };
        this.groups = new wwebjs_groups_1.WwebjsGroups(this.host);
        this.messaging = new wwebjs_messaging_1.WwebjsMessaging(this.host);
        this.contacts = new wwebjs_contacts_1.WwebjsContacts(this.host);
        this.profile = new wwebjs_profile_1.WwebjsProfile(this.host);
        this.labels = new wwebjs_labels_1.WwebjsLabels(this.host);
        this.channels = new wwebjs_channels_1.WwebjsChannels(this.host);
        this.statuses = new wwebjs_status_1.WwebjsStatus(this.host);
        this.chats = new wwebjs_chats_1.WwebjsChats(this.host, this.messaging);
        this.catalog = new wwebjs_catalog_1.WwebjsCatalog(this.host);
        // Lifecycle collaborators, each with its own narrow host slice of closures. Constructed before
        // the lifecycle delegate, whose host closes over them; every closure reads adapter state live,
        // so construction order carries no initialization requirements.
        this.reconcile = new wwebjs_reconcile_1.WwebjsReadyReconcile({
            logger: this.logger,
            config: this.config,
            getClient: () => this.client,
            getStatus: () => this.status,
            setStatus: status => this.lifecycle.setStatus(status),
            getCallbacks: () => this.callbacks,
            markReadyFromClientInfo: () => this.lifecycle.markReadyFromClientInfo(),
            wasFreshPairing: () => this.lifecycle.qrShown,
            recoverFromStuckAuth: () => this.recoverFromStuckAuth(),
        });
        this.stuckAuth = new wwebjs_stuck_auth_1.WwebjsStuckAuth({
            logger: this.logger,
            config: this.config,
            getClient: () => this.client,
            setClient: client => (this.lifecycle.client = client),
            setStatus: status => this.lifecycle.setStatus(status),
            getCallbacks: () => this.callbacks,
        });
        this.calls = new wwebjs_calls_1.WwebjsCalls({
            logger: this.logger,
            isTearingDown: () => this.tearingDown,
            getCallbacks: () => this.callbacks,
        });
        this.onboardingWatcher = new wwebjs_onboarding_1.WwebjsOnboardingWatcher({
            logger: this.logger,
            config: this.config,
            getClient: () => this.client,
            getStatus: () => this.status,
            setStatus: status => this.lifecycle.setStatus(status),
            isTearingDown: () => this.tearingDown,
            isDisconnectReported: () => this.disconnectReported,
            getCallbacks: () => this.callbacks,
        });
        this.lifecycle = new wwebjs_lifecycle_1.WwebjsLifecycle({
            logger: this.logger,
            config: this.config,
            getCallbacks: () => this.callbacks,
            scheduleReadyReconcile: () => this.reconcile.scheduleReadyReconcile(),
            clearReadyReconcile: () => this.reconcile.clearReadyReconcile(),
            startOnboardingWatcher: () => this.onboardingWatcher.startOnboardingWatcher(),
            clearOnboardingWatcher: () => this.onboardingWatcher.clearOnboardingWatcher(),
            clearLiveCalls: () => this.calls.clearLiveCalls(),
            clearLocalAuth: () => this.clearLocalAuth(),
            attachDomainEvents: client => this.attachDomainEvents(client),
        });
    }
    /**
     * Download inbound media safely. The page decrypts the whole file before anything can measure it, so
     * (1) pre-gate on the sender-declared size and skip the download entirely when it exceeds the cap,
     * (2) let the page drop a decrypted payload over the cap before encoding it (downloadMediaInPage),
     * and (3) run the download through the concurrency limiter for backpressure. Resolves an envelope
     * whenever it has one to build: the payload, or the declared-only marker when no blob is available.
     * With a ticket (PostgreSQL), the download waits for a slot of the session's room first, and that
     * slot is held until the page download settles, since it cannot be aborted.
     */
    async capInboundMediaFor(msg, maxBytesOverride, ticket) {
        if (!(0, inbound_media_cap_1.isMediaDownloadEnabled)()) {
            return (0, wwebjs_messaging_1.declaredOnlyMedia)(msg);
        }
        // Read the id once, through readWid: a bare `_serialized` read yields undefined on the WA Web build
        // that renamed it to `$1` (#747), which is the same build whose page-side rename makes these
        // downloads fail. The warnings below are the diagnostic for it, so they must carry a real id.
        const msgId = (0, whatsapp_web_js_types_1.readWid)(msg.id);
        // An override (the status seed's STATUS_MEDIA_MAX_BYTES) only tightens the global cap: a larger one
        // would let a download the cap below always drops run anyway, past the memory guard it exists for.
        const maxBytes = Math.min(maxBytesOverride ?? Number.POSITIVE_INFINITY, (0, inbound_media_cap_1.inboundMediaMaxBytes)());
        const declared = (0, wwebjs_messaging_1.declaredMediaSize)(msg);
        if (declared > maxBytes) {
            this.logger.warn('Inbound media declared size exceeds the cap; skipped download', {
                msgId,
                sizeBytes: declared,
                maxBytes,
            });
            return (0, wwebjs_messaging_1.declaredOnlyMedia)(msg);
        }
        if (ticket) {
            const granted = ticket.reserve();
            if (!(granted === true || (granted !== false && (await granted)))) {
                this.logger.warn('No room for inbound media within the wait; emitting the omitted marker', { msgId });
                return (0, wwebjs_messaging_1.declaredOnlyMedia)(msg);
            }
        }
        let resolveBounded = () => undefined;
        const boundedReady = new Promise(resolve => {
            resolveBounded = resolve;
        });
        // Set when the caller's wait below expires. A task still queued at that point has nobody left to
        // read its result, so once admitted it gives the slot straight back instead of pulling a full
        // base64 blob over CDP and holding the slot for it: after a burst, that backlog is what made
        // later messages miss their own deadline. A download that already started is unaffected.
        let abandoned = false;
        const downloadInSlot = () => {
            if (abandoned) {
                resolveBounded(null);
                return Promise.resolve();
            }
            // The page download is async, so a page-side throw (a detached target, a WA Web field rename) arrives
            // as a rejection, which boundedReady adopts and rethrows past the only exit that builds the marker,
            // leaving every call site to emit with no media field at all. It is the same "no usable media"
            // outcome as the timeout below, so it takes the same null sentinel.
            const download = (0, wwebjs_messaging_1.downloadCappedMedia)(msg, maxBytes)
                .then(result => {
                // The page answers null or undefined for media it cannot serve (re-uploading, a failed resolve, a
                // 404), and the omitted marker alone gives nobody a line to post.
                if (!result) {
                    this.logger.warn('Inbound media download returned nothing; emitting the omitted marker', {
                        msgId,
                        answer: String(result),
                    });
                }
                return result;
            })
                .catch((error) => {
                this.logger.warn('Inbound media download failed; emitting the omitted marker', {
                    msgId,
                    error: String(error),
                });
                return null;
            });
            resolveBounded((0, inbound_media_cap_1.withInboundDownloadTimeout)(download, (0, inbound_media_cap_1.inboundMediaTimeoutMs)(), () => this.logger.warn('Inbound media download timed out (MEDIA_DOWNLOAD_TIMEOUT_MS); emitting message without media', {
                msgId,
            })));
            // Keep the slot occupied until the underlying download truly settles, not the timeout race.
            return download.then(() => undefined, () => undefined);
        };
        // Per-session slot first, then the process-wide one, so a session parks at most its own
        // INBOUND_MEDIA_CONCURRENCY waiters on the shared gate. Both are held until the download settles.
        const slotHeld = this.inboundLimiter.run(() => (0, inbound_media_cap_1.runUnderGlobalMediaGate)(downloadInSlot));
        // The payload can reach Node after the wait below gave up on it: keep the room until it settles.
        ticket?.holdUntil(slotHeld);
        // Defensive only, and deliberately kept. `run()` rejects on a full queue (gone — the queue is
        // unbounded) or on close(), which nothing calls on this limiter; the task itself swallows both
        // download outcomes. So nothing is expected here — but an unhandled rejection from a
        // fire-and-forget promise is not an acceptable way to find that out.
        void slotHeld.catch((error) => {
            this.logger.warn('Inbound media slot holder rejected unexpectedly; emitting message without media', {
                msgId,
                error: String(error),
            });
            resolveBounded(null);
        });
        // The caller's wait spans the QUEUE as well as the download, and BOTH are unbounded: the queue by
        // design now, and the wait for a slot because a slot is held until its download really settles —
        // which a hung page never does. The inner race only starts once this message is admitted, so it
        // cannot cover the waiting. Without a bound here, a burst behind stuck slots parks forever and
        // those messages are never emitted AT ALL — strictly worse than the media loss this change set
        // out to fix. The old queue cap provided that degradation by rejecting; this restores it without
        // shedding at a fixed batch size.
        const media = await (0, inbound_media_cap_1.withInboundDownloadTimeout)(boundedReady, (0, inbound_media_cap_1.inboundMediaTimeoutMs)(), () => {
            abandoned = true;
            this.logger.warn('Inbound media did not arrive within MEDIA_DOWNLOAD_TIMEOUT_MS; emitting message without media', {
                msgId,
            });
        });
        if (!media) {
            return (0, wwebjs_messaging_1.declaredOnlyMedia)(msg);
        }
        // An over-cap payload arrives without data, carrying the size the page measured. Anything that did
        // arrive is counted here as received, so a page that sends more than the cap is still caught.
        const capped = (0, inbound_media_cap_1.capInboundMedia)({
            mimetype: media.mimetype,
            filename: media.filename || undefined,
            sizeBytes: media.data ? Buffer.byteLength(media.data, 'base64') : media.sizeBytes,
            toBase64: () => media.data,
            maxBytes,
        });
        if (capped.omitted) {
            this.logger.warn('Inbound media exceeds MEDIA_DOWNLOAD_MAX_BYTES; dropped payload, kept envelope', {
                msgId,
                sizeBytes: capped.sizeBytes,
            });
        }
        return capped;
    }
    // ----- Lifecycle (./wwebjs-lifecycle and its sibling collaborators) -----
    async initialize(callbacks) {
        this.callbacks = callbacks;
        return this.lifecycle.initialize();
    }
    isPageTransportError(error) {
        return this.lifecycle.isPageTransportError(error);
    }
    reportIfPageTransportError(error, context) {
        this.lifecycle.reportIfPageTransportError(error, context);
    }
    async disconnect() {
        return this.lifecycle.disconnect();
    }
    async logout() {
        return this.lifecycle.logout();
    }
    async destroy() {
        return this.lifecycle.destroy();
    }
    async forceDestroy() {
        return this.lifecycle.forceDestroy();
    }
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
    recoverFromStuckAuth() {
        return this.stuckAuth.recoverFromStuckAuth();
    }
    clearLocalAuth() {
        return this.stuckAuth.clearLocalAuth();
    }
    /**
     * Register the message/group/call domain events on a freshly built client — the one seam the
     * lifecycle's setupEventHandlers() uses for everything that is pure payload mapping. The
     * connection-state events (qr/authenticated/ready/disconnected/auth_failure) stay in the
     * lifecycle module: they drive the latches these registrars never touch.
     */
    attachDomainEvents(client) {
        (0, wwebjs_message_events_1.registerWwebjsMessageEvents)(client, this.host);
        (0, wwebjs_group_events_1.registerWwebjsGroupEvents)(client, this.host);
        client.on('call', call => this.calls.handleIncomingCall(call));
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
    getChatsByLabel(labelId) {
        return this.labels.getChatsByLabel(labelId);
    }
    /**
     * whatsapp-web.js 1.34.7 can read labels and assign them, but cannot create, rename, recolour or
     * delete one — `index.d.ts` exposes getLabels / getLabelById / getChatLabels / getChatsByLabelId /
     * addOrRemoveLabels and nothing that edits the label itself.
     */
    // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
    async upsertLabel(_label) {
        throw new engine_not_supported_error_1.EngineNotSupportedError('upsertLabel');
    }
    // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
    async deleteLabel(_labelId) {
        throw new engine_not_supported_error_1.EngineNotSupportedError('deleteLabel');
    }
    /**
     * whatsapp-web.js exposes no way to observe another party's presence: WAWebPresenceChatAction
     * offers only sendPresenceAvailable/sendPresenceUnavailable, which publish the ACCOUNT's own
     * presence, and the library surfaces no presence event at all.
     */
    // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-unused-vars
    async subscribeToPresence(_chatId) {
        throw new engine_not_supported_error_1.EngineNotSupportedError('subscribeToPresence');
    }
    createCallLink(type, startTime) {
        return this.profile.createCallLink(type, startTime);
    }
    /** Always EngineNotSupportedError (HTTP 501): a rejection did not stop a live call ringing. See
     *  ./wwebjs-calls. */
    async rejectCall(callId) {
        return this.calls.rejectCall(callId);
    }
    sendTextMessage(chatId, text, mentions, options) {
        return this.messaging.sendTextMessage(chatId, text, mentions, options);
    }
    sendImageMessage(chatId, media) {
        return this.messaging.sendImageMessage(chatId, media);
    }
    sendVideoMessage(chatId, media) {
        return this.messaging.sendVideoMessage(chatId, media);
    }
    sendAudioMessage(chatId, media) {
        return this.messaging.sendAudioMessage(chatId, media);
    }
    sendDocumentMessage(chatId, media) {
        return this.messaging.sendDocumentMessage(chatId, media);
    }
    getContacts() {
        return this.contacts.getContacts();
    }
    getContactById(contactId) {
        return this.contacts.getContactById(contactId);
    }
    getNumberId(number) {
        return this.contacts.getNumberId(number);
    }
    checkNumberExists(number) {
        return this.contacts.checkNumberExists(number);
    }
    resolveContactPhone(contactId) {
        return this.contacts.resolveContactPhone(contactId);
    }
    getGroups() {
        return this.groups.getGroups();
    }
    // ============= Phase 3: Extended Messaging =============
    sendLocationMessage(chatId, location) {
        return this.messaging.sendLocationMessage(chatId, location);
    }
    sendContactMessage(chatId, contact) {
        return this.messaging.sendContactMessage(chatId, contact);
    }
    sendStickerMessage(chatId, media) {
        return this.messaging.sendStickerMessage(chatId, media);
    }
    sendPollMessage(chatId, poll) {
        return this.messaging.sendPollMessage(chatId, poll);
    }
    replyToMessage(chatId, quotedMsgId, text, mentions) {
        return this.messaging.replyToMessage(chatId, quotedMsgId, text, mentions);
    }
    forwardMessage(fromChatId, toChatId, messageId) {
        return this.messaging.forwardMessage(fromChatId, toChatId, messageId);
    }
    // ============= Phase 3: Group Management =============
    getGroupInfo(groupId) {
        return this.groups.getGroupInfo(groupId);
    }
    createGroup(name, participants) {
        return this.groups.createGroup(name, participants);
    }
    addParticipants(groupId, participants) {
        return this.groups.addParticipants(groupId, participants);
    }
    removeParticipants(groupId, participants) {
        return this.groups.removeParticipants(groupId, participants);
    }
    promoteParticipants(groupId, participants) {
        return this.groups.promoteParticipants(groupId, participants);
    }
    demoteParticipants(groupId, participants) {
        return this.groups.demoteParticipants(groupId, participants);
    }
    leaveGroup(groupId) {
        return this.groups.leaveGroup(groupId);
    }
    setGroupSubject(groupId, subject) {
        return this.groups.setGroupSubject(groupId, subject);
    }
    setGroupDescription(groupId, description) {
        return this.groups.setGroupDescription(groupId, description);
    }
    // Reactions (Phase 3)
    reactToMessage(chatId, messageId, emoji) {
        return this.messaging.reactToMessage(chatId, messageId, emoji);
    }
    getMessageReactions(chatId, messageId) {
        return this.messaging.getMessageReactions(chatId, messageId);
    }
    // Labels (Phase 3) - WhatsApp Business only
    getLabels() {
        return this.labels.getLabels();
    }
    getLabelById(labelId) {
        return this.labels.getLabelById(labelId);
    }
    getChatLabels(chatId) {
        return this.labels.getChatLabels(chatId);
    }
    addLabelToChat(chatId, labelId) {
        return this.labels.addLabelToChat(chatId, labelId);
    }
    removeLabelFromChat(chatId, labelId) {
        return this.labels.removeLabelFromChat(chatId, labelId);
    }
    // Channels/Newsletter (Phase 3)
    getSubscribedChannels() {
        return this.channels.getSubscribedChannels();
    }
    getChannelById(channelId) {
        return this.channels.getChannelById(channelId);
    }
    subscribeToChannel(_inviteCode) {
        return this.channels.subscribeToChannel(_inviteCode);
    }
    unsubscribeFromChannel(channelId) {
        return this.channels.unsubscribeFromChannel(channelId);
    }
    getChannelMessages(channelId, limit = 50) {
        return this.channels.getChannelMessages(channelId, limit);
    }
    // ========== Gap Quick Wins Implementation ==========
    getChatHistory(chatId, limit = 50, includeMedia = false, mediaMaxBytes, signal) {
        return this.messaging.getChatHistory(chatId, limit, includeMedia, mediaMaxBytes, signal);
    }
    starMessage(chatId, messageId, star) {
        return this.messaging.starMessage(chatId, messageId, star);
    }
    pinMessage(chatId, messageId, durationSeconds) {
        return this.messaging.pinMessage(chatId, messageId, durationSeconds);
    }
    votePoll(chatId, pollMessageId, options) {
        return this.messaging.votePoll(chatId, pollMessageId, options);
    }
    // whatsapp-web.js has no interactive button-reply send path; the parameters are not named so the
    // method reads as the 501 it is, and TypeScript accepts the narrower signature for the interface.
    // eslint-disable-next-line @typescript-eslint/require-await
    async clickButton() {
        throw new engine_not_supported_error_1.EngineNotSupportedError('clickButton');
    }
    unpinMessage(chatId, messageId) {
        return this.messaging.unpinMessage(chatId, messageId);
    }
    deleteMessage(chatId, messageId, forEveryone = true) {
        return this.messaging.deleteMessage(chatId, messageId, forEveryone);
    }
    // Edit Message
    editMessage(chatId, messageId, body, mentions) {
        return this.messaging.editMessage(chatId, messageId, body, mentions);
    }
    // Get Profile Picture
    getProfilePicture(contactId) {
        return this.contacts.getProfilePicture(contactId);
    }
    // Block Contact
    blockContact(contactId) {
        return this.contacts.blockContact(contactId);
    }
    upsertContact(contactId, firstName, lastName) {
        return this.contacts.upsertContact(contactId, firstName, lastName);
    }
    deleteContact(contactId) {
        return this.contacts.deleteContact(contactId);
    }
    // Unblock Contact
    unblockContact(contactId) {
        return this.contacts.unblockContact(contactId);
    }
    getBlockedContacts() {
        return this.contacts.getBlockedContacts();
    }
    // ========== Profile (own account) ==========
    setProfileName(name) {
        return this.profile.setProfileName(name);
    }
    setProfileStatus(status) {
        return this.profile.setProfileStatus(status);
    }
    deleteProfilePicture() {
        return this.profile.deleteProfilePicture();
    }
    setProfilePicture(media) {
        return this.profile.setProfilePicture(media);
    }
    // Get Group Invite Code
    getGroupInviteCode(groupId) {
        return this.groups.getGroupInviteCode(groupId);
    }
    // Revoke Group Invite Code
    revokeGroupInviteCode(groupId) {
        return this.groups.revokeGroupInviteCode(groupId);
    }
    // Join Group via Invite Code
    getGroupJoinInfo(inviteCode) {
        return this.groups.getGroupJoinInfo(inviteCode);
    }
    joinGroupViaInviteCode(inviteCode) {
        return this.groups.joinGroupViaInviteCode(inviteCode);
    }
    // Set "only admins can send messages" (announce)
    setGroupMessagesAdminsOnly(groupId, adminsOnly) {
        return this.groups.setGroupMessagesAdminsOnly(groupId, adminsOnly);
    }
    // Set "only admins can edit group info" (locked/restrict)
    setGroupInfoAdminsOnly(groupId, adminsOnly) {
        return this.groups.setGroupInfoAdminsOnly(groupId, adminsOnly);
    }
    setGroupMemberAddMode(groupId, mode) {
        return this.groups.setGroupMemberAddMode(groupId, mode);
    }
    setGroupPicture(groupId, media) {
        return this.groups.setGroupPicture(groupId, media);
    }
    deleteGroupPicture(groupId) {
        return this.groups.deleteGroupPicture(groupId);
    }
    setGroupEphemeral(groupId, durationSec) {
        return this.groups.setGroupEphemeral(groupId, durationSec);
    }
    setGroupMemberLabel(groupId, label) {
        return this.groups.setGroupMemberLabel(groupId, label);
    }
    getGroupMembershipRequests(groupId) {
        return this.groups.getGroupMembershipRequests(groupId);
    }
    approveGroupMembershipRequests(groupId, participants) {
        return this.groups.approveGroupMembershipRequests(groupId, participants);
    }
    rejectGroupMembershipRequests(groupId, participants) {
        return this.groups.rejectGroupMembershipRequests(groupId, participants);
    }
    // ========== Status/Stories (Phase 3) ==========
    getContactStatuses() {
        return this.statuses.getContactStatuses();
    }
    getContactStatus(contactId) {
        return this.statuses.getContactStatus(contactId);
    }
    postTextStatus(text, options) {
        return this.statuses.postTextStatus(text, options);
    }
    postImageStatus(media, options) {
        return this.statuses.postImageStatus(media, options);
    }
    postVideoStatus(media, options) {
        return this.statuses.postVideoStatus(media, options);
    }
    postVoiceStatus(media, options) {
        return this.statuses.postVoiceStatus(media, options);
    }
    deleteStatus(statusId) {
        return this.statuses.deleteStatus(statusId);
    }
    // ========== Catalog (Phase 3) ==========
    // whatsapp-web.js has no Catalog API at all (no Client.getCatalog/getProducts/getProduct symbol in
    // index.d.ts). These used to be phantom stubs — a warn log plus null/empty results — so the API
    // reported "no catalog" / "no products" for a capability that never ran. Honest 501s instead,
    // matching sendProduct/sendCatalog below.
    getCatalog() {
        return this.catalog.getCatalog();
    }
    getProducts(_options) {
        return this.catalog.getProducts(_options);
    }
    getProduct(_productId) {
        return this.catalog.getProduct(_productId);
    }
    sendProduct(_chatId, _productId, _body) {
        return this.catalog.sendProduct(_chatId, _productId, _body);
    }
    sendCatalog(_chatId, _body) {
        return this.catalog.sendCatalog(_chatId, _body);
    }
    getChats() {
        return this.chats.getChats();
    }
    // messageIds is dropped on purpose: whatsapp-web.js exposes only a chat-level sendSeen, which
    // already marks every message in the chat.
    sendSeen(chatId) {
        return this.chats.sendSeen(chatId);
    }
    muteChat(chatId, muteUntil) {
        return this.chats.muteChat(chatId, muteUntil);
    }
    pinChat(chatId, pin) {
        return this.chats.pinChat(chatId, pin);
    }
    archiveChat(chatId, archive) {
        return this.chats.archiveChat(chatId, archive);
    }
    clearChatMessages(chatId) {
        return this.chats.clearChatMessages(chatId);
    }
    markUnread(chatId) {
        return this.chats.markUnread(chatId);
    }
    deleteChat(chatId) {
        return this.chats.deleteChat(chatId);
    }
    sendChatState(chatId, state) {
        return this.chats.sendChatState(chatId, state);
    }
    setOnlinePresence(available) {
        return this.chats.setOnlinePresence(available);
    }
    ensureReady() {
        if (this.status !== whatsapp_engine_interface_1.EngineStatus.READY || !this.client) {
            // Typed so the global filter returns 409 Conflict ("session not connected")
            // instead of a 500 when an engine op is attempted while the session is
            // disconnected / reconnecting / still initializing (#100).
            throw new engine_not_ready_error_1.EngineNotReadyError();
        }
        // Post-READY navigation window: window.WWebJS is gone until the re-inject completes, so every
        // delegate evaluate would die as a raw TypeError 500 (and five raw send failures latch the send
        // breaker for its 15-minute cooldown). Answer the same retryable 409 the pre-READY states get,
        // naming the reload so the operator can tell this state from a plain disconnect (#1081). Past the
        // window the same holds for a reloaded page a liveness probe has read without its helpers.
        if (this.lifecycle.isInNavigationReinjectWindow() || this.lifecycle.isPageWithoutHelpers()) {
            throw new engine_not_ready_error_1.EngineNotReadyError(wwebjs_lifecycle_1.PAGE_RELOADING_MESSAGE);
        }
    }
    ensureNotChannelRecipient(chatId) {
        // whatsapp-web.js crashes building a channel media message (`msg.avParams is not a function`,
        // upstream wwebjs#201823 — WA Web removed Msg.avParams). Text→channel works; media does not.
        // Fail fast with a typed 501 instead of surfacing the raw TypeError as a 500 (#673).
        if ((0, wa_id_1.isChannelJid)(chatId)) {
            throw new channel_media_not_supported_error_1.ChannelMediaNotSupportedError();
        }
    }
}
exports.WhatsAppWebJsAdapter = WhatsAppWebJsAdapter;
