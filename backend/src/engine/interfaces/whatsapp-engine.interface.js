"use strict";
// WhatsApp Engine Interface - Abstract layer for WA engines
//
// Identity contract (the engine boundary is an anti-corruption layer for WhatsApp's id dialects):
// every JID an engine EMITS in a neutral field (`from` / `to` / `chatId` / `author` / contact + chat
// `id`, etc.) is in the NEUTRAL dialect, so application code never has to know which engine produced
// it. The neutral dialect is small:
//   - `<phone>@c.us`  a user known by phone (the raw `@s.whatsapp.net` form folds into this)
//   - `<id>@g.us`     a group
//   - `<lid>@lid`     a user known ONLY by privacy id - phone genuinely unknown (a first-class state)
//   - `status@broadcast` / `<id>@newsletter` / `<id>@broadcast`  special channels
//   - never `@s.whatsapp.net`, never a `:device` suffix
// Resolution rule: prefer `@c.us` (resolve a lid to its phone when the mapping is known), fall back to
// `@lid` only when it can't be resolved. See `engine/identity/wa-id.ts` for the shared implementation.
// (Ids the engine ACCEPTS - e.g. `sendTextMessage(chatId)` - may be neutral; the adapter de-normalizes
// to its own dialect. Full inbound + outbound conformance is being rolled out per-engine.)
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineStatus = void 0;
var EngineStatus;
(function (EngineStatus) {
    EngineStatus["DISCONNECTED"] = "disconnected";
    EngineStatus["INITIALIZING"] = "initializing";
    EngineStatus["QR_READY"] = "qr_ready";
    EngineStatus["AUTHENTICATING"] = "authenticating";
    EngineStatus["READY"] = "ready";
    EngineStatus["ACTION_REQUIRED"] = "action_required";
    EngineStatus["FAILED"] = "failed";
})(EngineStatus || (exports.EngineStatus = EngineStatus = {}));
/**
 * The `IWhatsAppEngine` method inventory.
 *
 * The TypeScript interface that used to declare these members is erased at runtime, so the names
 * are kept here as data. `engine-capability-matrix.js` derives one row per name, and
 * `engine-parity.spec.js` checks that every adapter implements each one and that no curated
 * exception names a method that is not listed here.
 *
 * Keep this list sorted. Adding a method here without implementing it on both adapters is a test
 * failure, not a silently missing capability.
 */
exports.IWHATSAPP_ENGINE_METHODS = Object.freeze([
    'addLabelToChat',
    'addParticipants',
    'approveGroupMembershipRequests',
    'archiveChat',
    'blockContact',
    'checkNumberExists',
    'clearChatMessages',
    'clickButton',
    'createCallLink',
    'createChannel',
    'createGroup',
    'deleteChannel',
    'deleteChat',
    'deleteContact',
    'deleteGroupPicture',
    'deleteLabel',
    'deleteMessage',
    'deleteProfilePicture',
    'deleteStatus',
    'demoteChannelAdmin',
    'demoteParticipants',
    'destroy',
    'disconnect',
    'editMessage',
    'forceDestroy',
    'forwardMessage',
    'getBlockedContacts',
    'getCatalog',
    'getChannelById',
    'getChannelMessages',
    'getChatHistory',
    'getChatLabels',
    'getChats',
    'getChatsByLabel',
    'getContactById',
    'getContactStatus',
    'getContactStatuses',
    'getContacts',
    'getGroupInfo',
    'getGroupInviteCode',
    'getGroupJoinInfo',
    'getGroupMembershipRequests',
    'getGroups',
    'getLabelById',
    'getLabels',
    'getMessageReactions',
    'getNumberId',
    'getPhoneNumber',
    'getProduct',
    'getProducts',
    'getProfilePicture',
    'getPushName',
    'getQRCode',
    'getStatus',
    'getSubscribedChannels',
    'initialize',
    'joinGroupViaInviteCode',
    'leaveGroup',
    'logout',
    'markUnread',
    'muteChannel',
    'muteChat',
    'pinChat',
    'pinMessage',
    'postImageStatus',
    'postTextStatus',
    'postVideoStatus',
    'postVoiceStatus',
    'probeLiveness',
    'promoteParticipants',
    'reactToMessage',
    'rejectCall',
    'rejectGroupMembershipRequests',
    'removeLabelFromChat',
    'removeParticipants',
    'replyToMessage',
    'requestPairingCode',
    'resolveContactPhone',
    'revokeGroupInviteCode',
    'sendAudioMessage',
    'sendCatalog',
    'sendChatState',
    'sendContactMessage',
    'sendDocumentMessage',
    'sendImageMessage',
    'sendLocationMessage',
    'sendPollMessage',
    'sendProduct',
    'sendSeen',
    'sendStickerMessage',
    'sendTextMessage',
    'sendVideoMessage',
    'setGroupDescription',
    'setGroupEphemeral',
    'setGroupInfoAdminsOnly',
    'setGroupMemberAddMode',
    'setGroupMemberLabel',
    'setGroupMessagesAdminsOnly',
    'setGroupPicture',
    'setGroupSubject',
    'setOnlinePresence',
    'setProfileName',
    'setProfilePicture',
    'setProfileStatus',
    'starMessage',
    'subscribeToChannel',
    'subscribeToPresence',
    'transferChannelOwnership',
    'unblockContact',
    'unpinMessage',
    'unsubscribeFromChannel',
    'upsertContact',
    'upsertLabel',
    'votePoll',
]);
