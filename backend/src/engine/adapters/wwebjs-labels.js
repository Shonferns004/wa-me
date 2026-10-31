"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WwebjsLabels = void 0;
const common_1 = require("@nestjs/common");
const message_mapper_1 = require("./message-mapper");
const wa_id_1 = require("../identity/wa-id");
const chat_labels_unsupported_error_1 = require("../../common/errors/chat-labels-unsupported.error");
const label_not_found_error_1 = require("../../common/errors/label-not-found.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const wwebjs_host_1 = require("./wwebjs-host");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
/**
 * Chat-label operations (WhatsApp Business only) extracted from WhatsAppWebJsAdapter. The adapter
 * keeps the public methods as thin forwarders and injects the shared host surface (./wwebjs-host)
 * via closures, so the delegate never touches lifecycle state directly.
 */
class WwebjsLabels {
    host;
    /** The settled tail of each chat's label writes, so the next write starts after it; gone once the chat is idle. */
    chatWrites = new Map();
    constructor(host) {
        this.host = host;
    }
    /** Post-ensureReady client handle. */
    client() {
        return this.host.getClient();
    }
    async getLabels() {
        this.host.ensureReady();
        const labels = await (0, wwebjs_host_1.withPage)(this.host, 'getLabels', () => this.client().getLabels());
        if (!labels) {
            return [];
        }
        return labels.map(label => ({
            id: String(label.id),
            name: String(label.name),
            hexColor: String(label.hexColor),
        }));
    }
    /**
     * Every chat carrying a label. Mapped to the neutral ChatSummary here rather than returned raw,
     * for the same reason getChats does it: no whatsapp-web.js type may cross the engine boundary.
     * Entries without a serialized id are skipped rather than failing the whole request.
     */
    async getChatsByLabel(labelId) {
        this.host.ensureReady();
        // The upstream page code dereferences the label without checking it exists, so an unknown id —
        // and every id on a personal (non-Business) account, whose label collection is empty — throws a
        // page-side TypeError that would surface as an opaque 500. A label that is not there is a 404,
        // the same answer getLabelById gives.
        let chats;
        try {
            chats = await this.client().getChatsByLabelId(labelId);
        }
        catch (error) {
            // Same split the group read makes: a dead page is a 503, not "no such label".
            (0, wwebjs_host_1.rethrowIfNavigation)(this.host, error);
            if (this.host.isPageTransportError(error)) {
                this.host.reportIfPageTransportError(error, 'getChatsByLabel');
                throw new engine_transport_error_1.EngineTransportError(`Transport died while listing chats for label ${labelId}`);
            }
            // Nor is a command that outran the protocol budget: no answer is not "no such label".
            if ((0, wwebjs_lifecycle_1.isProtocolTimeout)(error)) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp Web did not answer the chat list for label ${labelId} in time`);
            }
            this.host.logger.debug('getChatsByLabelId rejected; treating the label as not found', {
                labelId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw new label_not_found_error_1.LabelNotFoundError(labelId);
        }
        const summaries = [];
        for (const chat of chats ?? []) {
            // The library builds this list via getChatById per label item and yields UNDEFINED entries
            // for chats that no longer resolve (Client.js getChatsByLabelId → ChatFactory) — the whole
            // entry, not just the id, so the optional chain must start at the entry itself.
            const id = chat?.id?._serialized;
            if (!id)
                continue;
            summaries.push({
                id,
                name: chat.name || id,
                isGroup: Boolean(chat.isGroup),
                kind: (0, wa_id_1.chatKind)(id),
                unreadCount: chat.unreadCount || 0,
                timestamp: chat.timestamp || 0,
                lastMessageType: chat.lastMessage ? (0, message_mapper_1.mapWwebjsMessageType)(chat.lastMessage.type) : undefined,
                archived: Boolean(chat.archived),
                pinned: Boolean(chat.pinned),
                muted: Boolean(chat.isMuted),
                // wwjs muteExpiration is epoch SECONDS with -1 = forever; expose ms (0 = indefinite), muted only.
                muteExpiration: chat.isMuted
                    ? (chat.muteExpiration ?? 0) > 0
                        ? (chat.muteExpiration ?? 0) * 1000
                        : 0
                    : undefined,
            });
        }
        return summaries;
    }
    async getLabelById(labelId) {
        this.host.ensureReady();
        // Client.getLabelById never resolves null: its page code serializes the looked-up label without
        // checking it exists, so an unknown id (every id on a personal account) throws a TypeError that
        // surfaced as a 500. Picking from the full list makes a missing label the documented 404.
        const labels = await (0, wwebjs_host_1.withPage)(this.host, 'getLabelById', () => this.client().getLabels());
        const label = labels?.find(candidate => String(candidate.id) === labelId);
        if (!label) {
            return null;
        }
        return {
            id: String(label.id),
            name: String(label.name),
            hexColor: String(label.hexColor),
        };
    }
    async getChatLabels(chatId) {
        this.host.ensureReady();
        if ((0, wa_id_1.isChannelJid)(chatId)) {
            // A channel resolves to a wwebjs `Channel`, which has no getLabels() and carries no chat labels.
            // Return empty instead of letting the unguarded call throw a TypeError (HTTP 500).
            return [];
        }
        // An unknown chat carries no labels, which is an honest answer for a read.
        return (await this.readChatLabels(chatId)) ?? [];
    }
    /** The chat's labels, or null when the page cannot resolve the chat (getChatById resolves undefined). */
    async readChatLabels(chatId) {
        const labels = await (0, wwebjs_host_1.withPage)(this.host, 'getChatLabels', async () => {
            const chat = await this.client().getChatById(chatId);
            return chat ? ((await chat.getLabels()) ?? []) : null;
        });
        if (!labels) {
            return null;
        }
        return labels.map(label => ({
            id: String(label.id),
            name: String(label.name),
            hexColor: String(label.hexColor),
        }));
    }
    async addLabelToChat(chatId, labelId) {
        this.host.ensureReady();
        await this.changeChatLabel(chatId, labelId, true);
    }
    async removeLabelFromChat(chatId, labelId) {
        this.host.ensureReady();
        await this.changeChatLabel(chatId, labelId, false);
    }
    /**
     * whatsapp-web.js has no add-/remove-one-label primitive: `client.addOrRemoveLabels(ids, chats)` REPLACES
     * a chat's label set with `ids` (adding the listed labels, removing any existing label not listed). So
     * toggle a single label by reading the current set, mutating it, and writing the whole set back.
     * Labels are a WhatsApp Business feature — the write throws `[LT01]` on a personal account; channels
     * carry no labels at all. Both are surfaced as a 422 rather than an opaque 500.
     *
     * The read and write are separate calls, and the page derives the removals from the chat's labels at the
     * moment it runs, so two single-label writes to the SAME chat that overlap would undo each other (the
     * later one removes the label the earlier one just added). They run one after the other per chat; a
     * write that waited re-reads the labels, and answers 409 if the session went away meanwhile.
     */
    async changeChatLabel(chatId, labelId, add) {
        if ((0, wa_id_1.isChannelJid)(chatId)) {
            throw new chat_labels_unsupported_error_1.ChatLabelsUnsupportedError('Channels do not support chat labels.');
        }
        // `previous` never rejects (it is the settled tail below), so a failed write does not stop the next.
        const previous = this.chatWrites.get(chatId) ?? Promise.resolve();
        const write = previous.then(() => this.writeChatLabel(chatId, labelId, add));
        const tail = write.then(() => undefined, () => undefined);
        this.chatWrites.set(chatId, tail);
        void tail.then(() => {
            if (this.chatWrites.get(chatId) === tail)
                this.chatWrites.delete(chatId);
        });
        await write;
    }
    async writeChatLabel(chatId, labelId, add) {
        // Not the read's empty answer: addOrRemoveLabels matches no chat page-side for an unknown id and
        // resolves without writing anything, which the route would report as success.
        const current = await this.readChatLabels(chatId);
        if (!current) {
            throw new common_1.NotFoundException(`Chat ${chatId} does not exist on this session`);
        }
        const ids = new Set(current.map(label => label.id));
        if (add) {
            ids.add(labelId);
        }
        else {
            ids.delete(labelId);
        }
        try {
            await (0, wwebjs_host_1.withPage)(this.host, 'changeChatLabel', () => this.client().addOrRemoveLabels([...ids], [chatId]));
        }
        catch (error) {
            // whatsapp-web.js throws `[LT01] Only Whatsapp business` from the page context on a personal account.
            if (String(error instanceof Error ? error.message : error).includes('LT01')) {
                throw new chat_labels_unsupported_error_1.ChatLabelsUnsupportedError();
            }
            throw error;
        }
        // The page drops an id it does not know and resolves, so the write left the chat unchanged. Checked
        // after the write, not before, so a personal account (no labels at all) still gets the LT01 422.
        if (add && !(await this.getLabels()).some(label => label.id === labelId)) {
            throw new label_not_found_error_1.LabelNotFoundError(labelId);
        }
        this.host.logger.debug(add ? 'Added label to chat' : 'Removed label from chat', { labelId, chatId });
    }
}
exports.WwebjsLabels = WwebjsLabels;
