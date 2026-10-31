"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationMappingService = exports.ConversationMappingConflict = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const conversation_mapping_entity_1 = require("./entities/conversation-mapping.entity");
const db_errors_1 = require("../../common/utils/db-errors");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const wa_id_1 = require("../../engine/identity/wa-id");
/**
 * Thrown when a providerConversationId is already bound to a DIFFERENT chat for the same plugin+instance
 * (the reverse unique key). Unlike a forward-key race — which converges by updating the existing row —
 * this is a genuine conflict with no row to fall back to, so it surfaces instead of corrupting state.
 */
class ConversationMappingConflict extends Error {
    key;
    providerConversationId;
    constructor(key, providerConversationId) {
        super(`conversation mapping conflict: providerConversationId "${providerConversationId}" is already bound to ` +
            `a different chat for plugin "${key.pluginId}" instance "${key.instanceId}"`);
        this.key = key;
        this.providerConversationId = providerConversationId;
        this.name = 'ConversationMappingConflict';
    }
}
exports.ConversationMappingConflict = ConversationMappingConflict;
let ConversationMappingService = class ConversationMappingService {
    repo;
    lidMappingStore;
    constructor(repo, lidMappingStore) {
        this.repo = repo;
        this.lidMappingStore = lidMappingStore;
    }
    async upsert(key, providerConversationId, patch) {
        const existing = await this.repo.findOne({ where: key });
        if (existing) {
            await this.updateById(existing.id, key, providerConversationId, patch);
            return;
        }
        try {
            const handoverState = await this.inheritedHandover(key);
            // A bare INSERT, not save(): save() wraps it in a transaction, and on SQLite's single shared
            // connection the rollback of the unique violation handled below would also discard any other
            // write made while it was open.
            await this.repo.insert({
                ...key,
                providerConversationId,
                handoverState,
                ...patch,
            });
            // A hand-back on the other form between the read above and this insert did not reach the new row;
            // read again now that the row exists (a later decision updates it directly).
            if (!patch?.handoverState && handoverState !== 'bot') {
                const current = await this.inheritedHandover(key);
                if (current !== handoverState)
                    await this.repo.update({ ...key }, { handoverState: current });
            }
        }
        catch (err) {
            if (!(0, db_errors_1.isUniqueViolation)(err))
                throw err;
            // A concurrent writer inserted between our findOne and save (forward-key race) OR the reverse
            // unique (pluginId,instanceId,providerConversationId) is bound to another chat. Re-read the
            // FORWARD key: found → converge by updating it; not found → genuine reverse conflict → surface.
            const raced = await this.repo.findOne({ where: key });
            if (raced) {
                await this.updateById(raced.id, key, providerConversationId, patch);
                return;
            }
            throw new ConversationMappingConflict(key, providerConversationId);
        }
    }
    // Update guarded against a reverse-unique collision: moving a row's providerConversationId onto a value
    // already bound to another chat throws ConversationMappingConflict rather than a raw QueryFailedError.
    async updateById(id, key, providerConversationId, patch) {
        try {
            await this.repo.update({ id }, {
                providerConversationId,
                ...patch,
            });
        }
        catch (err) {
            if ((0, db_errors_1.isUniqueViolation)(err))
                throw new ConversationMappingConflict(key, providerConversationId);
            throw err;
        }
    }
    /**
     * A takeover is scoped to the chat, not to the plugin, and silences every other plugin there. The
     * mappings stay, so a plugin installed again keeps its provider conversations; only the takeovers go.
     */
    async releaseTakeovers(pluginId) {
        await this.repo.update({ pluginId, handoverState: (0, typeorm_2.In)(['human', 'closed']) }, { handoverState: 'bot' });
    }
    get(key) {
        return this.repo.findOne({ where: key });
    }
    // Session+chat-scoped handover lookup for the core gate: a human/closed state held by any row for this
    // chat, IGNORING pluginId. A handover taken by one plugin (e.g. the Chatwoot relay) then governs every
    // plugin on that chat — the gate exempts the owner and silences the rest.
    //
    // A 1:1 chat's neutral id is `<lid>@lid` while its lid is unresolved and `<phone>@c.us` once the
    // mapping is learned, so a row written under one form is matched from the other as well. Keyed on
    // the literal id alone, a takeover recorded before the mapping was learned stopped applying after
    // it, and the bot answered a chat a human had taken over. Rows stay keyed on the literal id, so one
    // plugin instance can hold a row under each form; setHandover writes the decision to every one of
    // them, and a new row under another form starts in the state the instance already holds, so they agree.
    async findHandoverForChat(sessionId, chatId) {
        const rows = await this.repo.find({
            where: { sessionId, chatId: (0, typeorm_2.In)(await this.chatIdAliases(chatId)) },
            order: { updatedAt: 'DESC' },
        });
        const held = rows.find(row => row.handoverState === 'human' || row.handoverState === 'closed');
        return held ? { pluginId: held.pluginId, handoverState: held.handoverState } : null;
    }
    // A plugin instance's first row under a chat's other id form starts in the handover the instance holds
    // under the old form. The adapter finds no mapping for the new form and links a fresh one; starting
    // it as 'bot' would leave the two forms disagreeing about a takeover.
    async inheritedHandover(key) {
        const others = (await this.chatIdAliases(key.chatId)).filter(id => id !== key.chatId);
        if (!others.length)
            return 'bot';
        const prior = await this.repo.find({ where: { ...key, chatId: (0, typeorm_2.In)(others) } });
        return prior.find(row => row.handoverState !== 'bot')?.handoverState ?? 'bot';
    }
    /**
     * The chat id plus its other individual forms: the phone it belongs to and every lid of that phone.
     * A number WhatsApp recycled keeps its earlier owner's lid in the table too, and the table cannot
     * tell which lid is current (a mapping is re-stamped whenever it is seen again), so for handover the
     * two owners' chats are one chat: a takeover or a hand-back on either reaches both.
     */
    async chatIdAliases(chatId) {
        const ids = new Set([chatId]);
        const { kind, userPart } = (0, wa_id_1.parseWaId)(chatId);
        const store = this.lidMappingStore;
        const phone = kind === 'lid' ? await store?.findPhoneForLid(userPart) : kind === 'user' ? userPart : null;
        if (phone && store) {
            // The whole set: the phone and every lid of it, so a lid reaches its sibling lids as the phone does.
            ids.add(`${phone}@c.us`);
            for (const lid of await store.findLidsForPhone(phone))
                ids.add(`${lid}@lid`);
        }
        return [...ids];
    }
    getByProvider(pluginId, instanceId, providerConversationId) {
        return this.repo.findOne({ where: { pluginId, instanceId, providerConversationId } });
    }
    // A handover decision is about the chat, not one id form of it: it is written to every row this plugin
    // instance holds for the chat in the session, so a later write to one form (an idempotent upsert)
    // cannot revive or drop the decision through the other. A row rebound from a deleted session keeps
    // the state it carried; where that disagrees with its other form, the gate reads the chat as taken
    // over until the next decision, which errs on the side of keeping the bot quiet.
    async setHandover(id, state) {
        const row = await this.repo.findOne({ where: { id } });
        if (!row)
            return;
        const { sessionId, pluginId, instanceId } = row;
        const chatId = (0, typeorm_2.In)(await this.chatIdAliases(row.chatId));
        await this.repo.update({ sessionId, pluginId, instanceId, chatId }, { handoverState: state });
    }
    /** Remove a mapping row by id — the supersede half of the stale-session repair path. */
    async delete(id) {
        await this.repo.delete({ id });
    }
    /**
     * Rebind a mapping whose session was deleted (and re-paired under a new id) onto the caller's
     * current session, so the stale row stops failing every reverse-key resolution. If the current
     * session ALREADY holds a forward-key row for the same chat+plugin+instance, the update hits
     * UQ_conversation_mappings_forward — the only index a sessionId-only update can collide with (the
     * row already owns its reverse key). That existing row is the fresher binding for the same chat,
     * so the stale row is superseded by deleting it instead.
     */
    async rebindSession(id, sessionId) {
        try {
            await this.repo.update({ id }, { sessionId });
        }
        catch (err) {
            if (!(0, db_errors_1.isUniqueViolation)(err))
                throw err;
            await this.repo.delete({ id });
        }
    }
};
exports.ConversationMappingService = ConversationMappingService;
exports.ConversationMappingService = ConversationMappingService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(conversation_mapping_entity_1.ConversationMapping, 'data')),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        lid_mapping_store_service_1.LidMappingStoreService])
], ConversationMappingService);
