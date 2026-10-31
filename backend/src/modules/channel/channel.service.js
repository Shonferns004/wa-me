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
var ChannelService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChannelService = void 0;
const common_1 = require("@nestjs/common");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const wa_id_1 = require("../../engine/identity/wa-id");
const channel_not_found_error_1 = require("../../common/errors/channel-not-found.error");
/**
 * Owns engine access for channel/newsletter operations so the "session not started" guard
 * and channel business rules (not-found mapping) live behind the service boundary.
 */
let ChannelService = class ChannelService {
    static { ChannelService_1 = this; }
    engines;
    static MAX_CHANNEL_HISTORY_LIMIT = 100;
    constructor(engines) {
        this.engines = engines;
    }
    getEngine(sessionId) {
        // EngineRegistry.require()'s default is this exact 400 "Session is not started".
        return this.engines.require(sessionId);
    }
    getSubscribedChannels(sessionId) {
        return this.getEngine(sessionId).getSubscribedChannels();
    }
    async getChannelById(sessionId, channelId) {
        const channel = await this.getEngine(sessionId).getChannelById(channelId);
        if (!channel) {
            throw new common_1.NotFoundException(`Channel ${channelId} not found`);
        }
        return channel;
    }
    /**
     * `limit` is clamped to [1, 100] (and falls back to 50 for non-finite input) so a caller cannot
     * ask the engine for an unbounded history window — the wwjs engine treats a limit < 1 as "no
     * limit" and would return every loaded message (same clamp discipline as MessageService.getChatHistory).
     */
    getChannelMessages(sessionId, channelId, limit = 50) {
        const safeLimit = Number.isFinite(limit)
            ? Math.min(Math.max(Math.trunc(limit), 1), ChannelService_1.MAX_CHANNEL_HISTORY_LIMIT)
            : 50;
        return this.getEngine(sessionId).getChannelMessages(channelId, safeLimit);
    }
    /** Create a channel. The account owns it, which is what makes deleting it possible later. */
    createChannel(sessionId, name, description) {
        // The DTO lets a JSON null through as "no description". whatsapp-web.js echoes a non-undefined one back in
        // the created channel, which would answer `"description": null` for a field typed as an optional string.
        return this.getEngine(sessionId).createChannel(name, description ?? undefined);
    }
    /**
     * A channel id, or 404. whatsapp-web.js resolves any other id to an ordinary chat, creating one if
     * needed, before its channel delete or unsubscribe fails with a 500, and Baileys hands it to WhatsApp,
     * which refuses it with a 403 or an opaque failure. Every channel id ends in `@newsletter` on both
     * engines.
     */
    requireChannelId(channelId) {
        if (!channelId.endsWith('@newsletter'))
            throw new channel_not_found_error_1.ChannelNotFoundError(channelId);
        return channelId;
    }
    /** Delete a channel this account owns. Irreversible, and its subscribers lose it. */
    deleteChannel(sessionId, channelId) {
        const engine = this.getEngine(sessionId);
        return engine.deleteChannel(this.requireChannelId(channelId));
    }
    /** Mute or unmute a channel's notifications. Subscription is untouched either way. */
    muteChannel(sessionId, channelId, mute) {
        const engine = this.getEngine(sessionId);
        return engine.muteChannel(this.requireChannelId(channelId), mute);
    }
    /**
     * The user id both admin writes address, qualified for the engine.
     *
     * Their DTOs only require a non-empty string, and `toEngineJid` passes anything it cannot
     * classify through verbatim — so free text, a group id or a bare `@c.us` reached the socket and
     * failed opaquely, while the group participant writes reject the same input with a naming 400.
     *
     * Guarded here rather than in the DTO to match where the group guard sits, so the rule holds for
     * any caller and not only the HTTP body. Note the group guard's stated reason does NOT carry over
     * verbatim: it covers the agent tools because `AgentToolDeps` injects `GroupService`, and there is
     * no channel tool family — `src/core/agent-tools/tools/index.ts` wires session, message, contact,
     * group, webhook, labels and automation, and nothing else. Today the controller is the only
     * caller; the placement is for the next one.
     */
    addressableUser(userId) {
        if (!(0, wa_id_1.isAddressableParticipant)(userId)) {
            throw new common_1.BadRequestException(`Not an individual user id: ${userId} — pass a phone number, <phone>@c.us or <lid>@lid`);
        }
        return (0, wa_id_1.toParticipantWid)(userId);
    }
    /** Demote a channel admin back to a subscriber. There is no promote counterpart on either engine. */
    demoteChannelAdmin(sessionId, channelId, userId) {
        const engine = this.getEngine(sessionId);
        return engine.demoteChannelAdmin(channelId, this.addressableUser(userId));
    }
    /** Hand the channel to a new owner. Irreversible — the account stops being the owner. */
    transferChannelOwnership(sessionId, channelId, newOwnerId) {
        const engine = this.getEngine(sessionId);
        return engine.transferChannelOwnership(channelId, this.addressableUser(newOwnerId));
    }
    subscribeToChannel(sessionId, inviteCode) {
        return this.getEngine(sessionId).subscribeToChannel(inviteCode);
    }
    unsubscribeFromChannel(sessionId, channelId) {
        const engine = this.getEngine(sessionId);
        return engine.unsubscribeFromChannel(this.requireChannelId(channelId));
    }
};
exports.ChannelService = ChannelService;
exports.ChannelService = ChannelService = ChannelService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [engine_registry_service_1.EngineRegistry])
], ChannelService);
