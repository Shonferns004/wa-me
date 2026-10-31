"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysHistory = void 0;
exports.toUnixSeconds = toUnixSeconds;
const wa_id_1 = require("../identity/wa-id");
const baileys_message_mapper_1 = require("./baileys-message-mapper");
const baileys_query_deadline_1 = require("./baileys-query-deadline");
/**
 * Baileys timestamps are `number | Long`; normalize to unix seconds.
 *
 * A third shape reaches here that the proto type does not admit: a decimal STRING. The library
 * decodes a message off the wire with `messageTimestamp` as a Long, and a Long serializes to its
 * decimal string, so a message read back out of `baileys_messages` (a JSON round trip) carries a
 * string where the type says number. Not EVERY stored message does: one persisted straight from a
 * send return was built in process with a plain number and round-trips as one. Delete-for-me and
 * edit both read this field off a stored message, so without the string arm they threw
 * `ts.toNumber is not a function` for any message that had come off the wire.
 *
 * Never answers NaN or Infinity, from any arm: a timestamp is not worth failing an operation over,
 * but a non-finite one poisons every arithmetic consumer downstream and would reach the wire. An
 * unusable value falls back to now, like an absent one.
 */
function toUnixSeconds(ts) {
    const now = () => Math.floor(Date.now() / 1000);
    if (ts == null) {
        return now();
    }
    if (typeof ts === 'number') {
        return Number.isFinite(ts) ? ts : now();
    }
    if (typeof ts === 'string') {
        const parsed = Number(ts);
        return Number.isFinite(parsed) ? parsed : now();
    }
    const converted = ts.toNumber();
    return Number.isFinite(converted) ? converted : now();
}
class BaileysHistory {
    host;
    constructor(host) {
        this.host = host;
    }
    /**
     * Whether the address-book snapshot has been pulled for this engine instance.
     *
     * One pull per process is what the in-memory contact store needs: it is empty at construction and
     * dies with the process, so every later reconnect on the same instance would re-download the whole
     * contact collection for a store that already holds it.
     */
    addressbookRestored = false;
    /** Post-connect socket handle (hydrateNames runs on connection 'open'). */
    sock() {
        return this.host.getSocket();
    }
    /**
     * Persist the bulk history Baileys pushes on connect (`messaging-history.set`) - the only
     * pre-connection history source. Maps each message media-free and hands the batch to the dispatch-free
     * `onHistoryMessages` callback, harvesting `pushName` into contacts on the way (history `contacts`
     * carry no names) and seeding each chat's last-message preview.
     */
    async captureHistoryMessages(messages) {
        if (!messages.length) {
            return;
        }
        const generation = this.host.getStoredWriteGeneration?.();
        const current = () => generation === this.host.getStoredWriteGeneration?.();
        const b = await this.host.loadLib();
        if (!current())
            return;
        const nameUpdates = [];
        const mapped = [];
        const revokes = [];
        const targets = new Map(messages.filter(msg => msg.key?.id).map(msg => [msg.key.id, msg]));
        for (const msg of messages) {
            if (msg.key?.fromMe !== true && msg.pushName) {
                const sender = (0, baileys_message_mapper_1.keyParticipant)(msg.key ?? {}) ?? msg.key?.remoteJid;
                if (sender) {
                    nameUpdates.push({ id: sender, notify: msg.pushName });
                }
            }
            const incoming = this.mapHistoryMessage(b, msg);
            if (incoming) {
                mapped.push(incoming);
            }
            else if (msg.key?.remoteJid) {
                const content = b.normalizeMessageContent(msg.message) ?? msg.message;
                const protocol = content?.protocolMessage;
                if (protocol && protocol.type === b.proto.Message.ProtocolMessage.Type.REVOKE && protocol.key?.id) {
                    revokes.push({ message: msg, target: protocol.key });
                }
            }
        }
        // Targets can precede or follow their revokes, including across separate history chunks.
        for (const { message, target } of revokes) {
            const original = targets.get(target.id);
            const key = await this.host.applyHistoryRevoke(original?.key ?? { ...target, remoteJid: target.remoteJid ?? message.key.remoteJid }, message.key);
            if (!current())
                return;
            if (!key?.remoteJid)
                continue;
            const cleared = this.revokedMessage(key, toUnixSeconds(original?.messageTimestamp ?? message.messageTimestamp));
            mapped.push(cleared);
        }
        if (nameUpdates.length) {
            this.host.upsertContacts(nameUpdates);
        }
        if (mapped.length) {
            const storedRevokes = await this.host.getOnHistoryMessages()?.(mapped);
            if (!current())
                return;
            const revoked = (storedRevokes ?? mapped).filter(m => m.type === 'revoked');
            const revokedKeys = new Set(revoked.map(m => JSON.stringify([m.id, m.chatId, m.fromMe])));
            for (const incoming of mapped) {
                if (incoming.type === 'revoked')
                    continue;
                const original = targets.get(incoming.id);
                const deleted = revokedKeys.has(JSON.stringify([incoming.id, incoming.chatId, incoming.fromMe]));
                // History has no observed order: equal-time messages keep the first one met, and give way to a live one.
                this.host.recordMessage(original, deleted ? 'revoked' : incoming.type, 0);
            }
            for (const m of revoked) {
                this.host.recordMessageEdit(m.chatId, m.id, '', 'revoked');
                if ((0, wa_id_1.parseWaId)(m.chatId).kind === 'lid') {
                    const phone = await this.host.findPersistedLidPhone?.(m.chatId).catch(() => null);
                    if (!current())
                        return;
                    if (phone)
                        this.host.recordMessageEdit(`${phone}@s.whatsapp.net`, m.id, '', 'revoked');
                }
            }
        }
    }
    revokedMessage(key, timestamp) {
        const message = (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            id: key.id,
            remoteJid: key.remoteJid,
            fromMe: key.fromMe === true,
            participant: (0, baileys_message_mapper_1.keyParticipant)(key),
            body: '',
            contentType: undefined,
            timestamp,
            selfJid: this.host.normalizedSelfJid(),
        }, jid => this.host.toNeutralJid(jid));
        return { ...message, type: 'revoked' };
    }
    /**
     * Backfill chat/contact display names after connect. Baileys 6.7.x often skips the initial app-state
     * sync (the state machine goes Online before it runs) and the PUSH_NAME sync can fail to decrypt, so
     * names never arrive. Fetch group subjects (reliable) and best-effort re-trigger the app-state sync;
     * both are non-fatal, and DM push-names still arrive via `contacts.update` on live messages.
     *
     * On a reconnect (`accountSyncCounter > 0`) Baileys skips history sync and the address-book snapshot
     * entirely: WhatsApp assumes the linked device kept its local copy. This gateway's contact store is
     * in-memory, so a process restart leaves GET /contacts empty. Once per engine instance we therefore drop
     * the stored version of the contact collection (so the next resync asks for a snapshot, not an
     * incremental patch) and process its mutations as an initial sync, which is what emits
     * `contacts.upsert` for the saved address book. The other collections keep the incremental resync
     * below.
     *
     * Once per engine instance, not "only when no saved contact is held": during the initial sync the event
     * buffer folds an app-state `contacts.upsert` into a `messaging-history.set` record it is already
     * holding for that id (`absorbed contact upsert in contact set` in Baileys' event-buffer), and the
     * whole initial sync is buffered as one batch, so those saved names arrive only inside the history
     * event, where the handler strips `name` because a history name is a chat title. The address book
     * is then PARTIAL rather than empty, and a count-based gate reads partial as "nothing to do" and
     * never repairs it. The snapshot pull is the only source that cannot be absorbed, so it runs on its
     * own schedule instead of on a count.
     *
     * A first link opens with the counter still at 0, so this method skips the pull there; the
     * lifecycle pulls once the initial history sync has gone quiet instead (see
     * BaileysLifecycle.scheduleAddressbookRestore). That pull does not count as this instance's one, so
     * a first reconnect still repairs whatever a late history chunk absorbed again.
     */
    async hydrateNames() {
        try {
            // Same ambiguity getGroups is bounded against: an unanswered query and an account with no groups
            // both yield `{}`, and query() resolves rather than throwing, so neither the catch below nor an
            // empty result can tell them apart. Without a clock of our own this step finishes silently — no
            // warn, because nothing threw, and no debug, because there was nothing to hydrate.
            const groups = await (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupFetchAllParticipating(), baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS, 'WhatsApp did not answer the group list query in time');
            const named = Object.values(groups)
                .filter(g => g?.id && g.subject)
                .map(g => ({ id: g.id, name: g.subject }));
            if (named.length) {
                this.host.upsertChats(named);
                this.host.logger.debug('Hydrated group names', { action: 'baileys_hydrate_groups', count: named.length });
            }
        }
        catch (err) {
            this.host.logger.warn('Group name hydration failed', { error: err instanceof Error ? err.message : String(err) });
        }
        try {
            const b = await this.host.loadLib();
            const collections = b.ALL_WA_PATCH_NAMES;
            if (!collections?.length) {
                return;
            }
            const alreadySynced = (this.sock().authState?.creds?.accountSyncCounter ?? 0) > 0;
            if (alreadySynced && !this.addressbookRestored) {
                // Set before the await so a second connect cannot start a concurrent pull, and cleared again
                // if it fails, so one bad attempt does not count as the one pull this instance gets.
                this.addressbookRestored = true;
                try {
                    await this.restoreAddressbookSnapshot();
                }
                catch (err) {
                    this.addressbookRestored = false;
                    throw err;
                }
            }
            await this.sock().resyncAppState(collections, false);
            this.host.logger.debug('Re-synced app state for contact names', { action: 'baileys_resync_appstate' });
        }
        catch (err) {
            this.host.logger.warn('App-state resync for contact names failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    /**
     * The app-state collection that carries `contactAction` mutations, i.e. the saved address book
     * (Baileys files its own contact edits under this name too). The other four collections carry chat
     * and message actions; a snapshot of those would re-emit every archive, pin, mute and star on each
     * restart for nothing, since only contacts are missing from the store.
     */
    static ADDRESSBOOK_COLLECTION = 'critical_unblock_low';
    /**
     * Drop the persisted version of the contact collection and resync it from a snapshot so
     * `contactAction` mutations fire again. `null` in `keys.set` is Baileys' own delete; the next resync
     * then sets `return_snapshot` because the collection has no version. `isInitialSync: true` keeps
     * delete-chat mutations from wiping conversations that history is not about to rebuild.
     */
    async restoreAddressbookSnapshot() {
        const name = BaileysHistory.ADDRESSBOOK_COLLECTION;
        await this.sock().authState.keys.set({ 'app-state-sync-version': { [name]: null } });
        await this.sock().resyncAppState([name], true);
        this.host.logger.debug('Restored address-book snapshot', {
            action: 'baileys_restore_addressbook',
            contacts: this.host.contactCount(),
        });
    }
    /**
     * Media-free WAMessage -> IncomingMessage map for bulk history (downloading media for thousands of
     * messages would be ruinous; the type is kept, the payload dropped). Returns null for protocol /
     * reaction / key / empty messages and for BAILEYS_NON_CONTENT_TYPES, which carry nothing for the
     * chat view.
     */
    mapHistoryMessage(b, msg) {
        const raw = msg.message;
        if (!raw || !msg.key?.remoteJid || !msg.key.id) {
            return null;
        }
        // Unwrap ephemeral/viewOnce/documentWithCaption/edited wrappers so the real type and body surface —
        // else a disappearing-chat message maps to type 'unknown' with an empty body. Identity no-op when
        // already unwrapped. Derive ONE contentType from the normalized content for both the skip-filter and
        // the type mapping, and reuse extractBaileysBody (the same body extraction the live path uses).
        const content = b.normalizeMessageContent(raw) ?? raw;
        const contentType = b.getContentType(content);
        if (!contentType ||
            contentType === 'protocolMessage' ||
            contentType === 'reactionMessage' ||
            contentType === 'senderKeyDistributionMessage' ||
            baileys_message_mapper_1.BAILEYS_NON_CONTENT_TYPES.has(contentType)) {
            return null;
        }
        const body = (0, baileys_message_mapper_1.extractBaileysBody)(content);
        const context = (0, baileys_message_mapper_1.extractBaileysContext)(content);
        const commerce = (0, baileys_message_mapper_1.extractBaileysCommerce)(content, contentType);
        const button = (0, baileys_message_mapper_1.extractBaileysButtonReply)(content, contentType);
        const buttons = (0, baileys_message_mapper_1.extractBaileysButtons)(content, contentType);
        return (0, baileys_message_mapper_1.buildIncomingMessageFromBaileys)({
            id: msg.key.id,
            remoteJid: msg.key.remoteJid,
            fromMe: msg.key.fromMe === true,
            participant: (0, baileys_message_mapper_1.keyParticipant)(msg.key),
            body,
            contentType,
            isPtt: content.audioMessage?.ptt === true,
            timestamp: toUnixSeconds(msg.messageTimestamp),
            pushName: msg.pushName ?? undefined,
            selfJid: this.host.normalizedSelfJid(),
            // Same commerce mapping as the live path, so a whole-catalog share is `unknown` on both.
            order: commerce.order,
            product: commerce.product,
            poll: (0, baileys_message_mapper_1.extractBaileysPoll)(content),
            button,
            buttons,
            quotedMessage: context.quotedMessage,
            mentionedJids: context.mentionedJids,
            isCatalogShare: (0, baileys_message_mapper_1.isBaileysCatalogShare)(content),
            // Populate the disappearing-messages timer using the same extraction the live path and the
            // session-store cache share (`msg.ephemeralDuration` primary, `contextInfo.expiration` fallback),
            // so the history sink can apply the STORE_EPHEMERAL_MESSAGES opt-out symmetrically with onMessage.
            ephemeralDuration: this.host.extractEphemeralDuration(msg),
        }, jid => this.host.toNeutralJid(jid));
    }
}
exports.BaileysHistory = BaileysHistory;
