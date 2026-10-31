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
exports.ChatScopeService = void 0;
const common_1 = require("@nestjs/common");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const jid_candidates_1 = require("../../engine/identity/jid-candidates");
const chat_scope_1 = require("../../common/security/chat-scope");
/**
 * Compiles an API key's `allowedChats` into an enforceable {@link ChatScope} and answers membership,
 * wiring the lid<->phone table so a phone entry matches its `@lid` form and vice versa.
 *
 * Provided by the global AuthModule so both the ApiKeyGuard (single requested id) and the list
 * endpoints (whole result set) share one definition of "inside the fence". The table is read
 * persistently rather than from the evictable in-memory mirror, so the answer is deterministic. A
 * missing store degrades to exact-dialect matching only, which fails CLOSED for an unmapped `@lid`.
 */
let ChatScopeService = class ChatScopeService {
    lidStore;
    constructor(lidStore) {
        this.lidStore = lidStore;
    }
    /** True when the key carries a non-empty allowlist and is therefore fenced. */
    isRestricted(apiKey) {
        return (0, chat_scope_1.isChatScopeRestricted)(apiKey?.allowedChats);
    }
    /**
     * Refuse a restricted key that names no chat on a route whose chat is an optional `?chatId=`. The
     * guard fences the chat id when it is present; this closes the case where it is missing or blank,
     * which the route would otherwise read as "every chat".
     */
    requireChat(apiKey, chatId) {
        if (this.isRestricted(apiKey) && !chatId?.trim()) {
            throw new common_1.ForbiddenException('chatId is required for a key restricted to selected chats');
        }
    }
    /** The literal scope for a key (no lookups), or `null` when unrestricted. */
    scopeFor(apiKey) {
        return (0, chat_scope_1.buildChatScope)(apiKey?.allowedChats ?? null);
    }
    /**
     * Whether a single requested `chatId` is inside the key's fence. Expands the REQUESTED id once
     * through the lid table (at most two lookups) instead of expanding the whole allowlist.
     */
    allows(apiKey, chatId) {
        return (0, chat_scope_1.chatIdAllowed)(this.scopeFor(apiKey), chatId, this.singleDirectory());
    }
    /**
     * Every stored form of one chat or sender id: the neutral dialects of a phone plus the lids mapped to
     * it, or the phone behind a lid. The same expansion the message list applies to its `chatId` and `from`
     * filters, so a caller-supplied filter finds the same rows on every surface: the id as given is kept too,
     * because a row stored under a spelling the expansion does not fold (a group or lid id with another case or
     * device suffix) must still match the filter that names it.
     */
    async candidatesFor(id) {
        return [...new Set([id, ...(await (0, jid_candidates_1.resolveJidCandidates)(id, this.singleDirectory()))])];
    }
    /** The allowlist expanded once with the lid table (batched), for filtering a whole list. */
    scopeForFilter(apiKey) {
        return (0, chat_scope_1.buildExpandedChatScope)(apiKey?.allowedChats ?? null, this.batchDirectory());
    }
    /**
     * The expanded allowlist as a plain id array, for surfaces that filter at the query level
     * (search's SQL `IN`), or `undefined` when the key is unrestricted. Same expansion as
     * {@link scopeForFilter}: both stored dialects of every entry, lid twins included.
     */
    async idsForFilter(apiKey) {
        const scope = await this.scopeForFilter(apiKey);
        return scope ? [...scope.allowed] : undefined;
    }
    /** The subset of `items` whose chat id is inside the key's fence (unrestricted ⇒ unchanged). */
    async filter(apiKey, items, chatIdOf) {
        return (0, chat_scope_1.filterByChatScope)(await this.scopeForFilter(apiKey), items, chatIdOf);
    }
    singleDirectory() {
        const store = this.lidStore;
        if (!store)
            return undefined;
        return {
            resolveLid: userPart => store.findPhoneForLid(userPart),
            lidsForPhone: phone => store.findLidsForPhone(phone),
        };
    }
    batchDirectory() {
        const store = this.lidStore;
        if (!store)
            return undefined;
        return {
            phonesForLids: lids => store.phonesForLidsPersisted(lids),
            lidsForPhones: phones => store.lidsForPhonesPersisted(phones),
        };
    }
};
exports.ChatScopeService = ChatScopeService;
exports.ChatScopeService = ChatScopeService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [lid_mapping_store_service_1.LidMappingStoreService])
], ChatScopeService);
