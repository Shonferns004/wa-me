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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupService = void 0;
const common_1 = require("@nestjs/common");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const media_cap_util_1 = require("../message/media-cap.util");
const wa_id_1 = require("../../engine/identity/wa-id");
const wa_id_2 = require("../../engine/identity/wa-id");
const paginate_1 = require("../../common/utils/paginate");
const send_pacing_service_1 = require("../message/send-pacing.service");
const logger_service_1 = require("../../common/services/logger.service");
const engine_not_supported_error_1 = require("../../common/errors/engine-not-supported.error");
const engine_throttled_error_1 = require("../../common/errors/engine-throttled.error");
/**
 * Whether a failed paced write provably contacted nobody, so its reserved budget can go back: a
 * client or refusal status (400 bad input, 403 refused, 404 no such group, 409 not ready), a 501
 * for an operation the engine lacks, or a 503 WhatsApp rate limit (EngineThrottledError), which
 * WhatsApp turned away before it ran. Anything else (a 503 deadline that abandoned an IQ still in
 * flight, a dropped socket, a dead page) leaves the outcome unknown, and WhatsApp may already have
 * added the participants, so the batch stays charged.
 */
function contactedNobody(error) {
    return (error instanceof common_1.HttpException &&
        (error.getStatus() < 500 || error instanceof engine_not_supported_error_1.EngineNotSupportedError || error instanceof engine_throttled_error_1.EngineThrottledError));
}
/**
 * Owns engine access for group operations. Controllers depend on this service instead of
 * reaching for the raw `IWhatsAppEngine` via `sessionService.getEngine`, so the "session not
 * started" guard and group-level business rules (e.g. not-found mapping) live in one place.
 */
let GroupService = class GroupService {
    engines;
    pacing;
    logger = (0, logger_service_1.createLogger)('GroupService');
    constructor(engines, pacing) {
        this.engines = engines;
        this.pacing = pacing;
    }
    getEngine(sessionId) {
        // EngineRegistry.require()'s default is this exact 400 "Session is not started".
        return this.engines.require(sessionId);
    }
    /**
     * Reject participant ids WhatsApp cannot act on, before they reach an engine.
     *
     * This lives in the service rather than in ParticipantsDto because the MCP agent tools
     * (src/core/agent-tools/tools/group.tools.ts) call createGroup and addParticipants directly with a
     * plain `z.array(z.string())`, so a DTO-only check would leave that path unguarded. Mirrors
     * ContactService.assertAddressable.
     *
     * Runs before pacing on the two paced writes: a batch that can never reach WhatsApp must not draw
     * on the cold-reachout budget on its way to a 400.
     */
    assertAddressableParticipants(participants) {
        const invalid = participants.filter(p => !(0, wa_id_2.isAddressableParticipant)(p));
        if (invalid.length) {
            throw new common_1.BadRequestException(`Not an individual participant id: ${invalid.join(', ')} — pass a phone number, <phone>@c.us or <lid>@lid`);
        }
    }
    /** Every group before a caller applies authorization and pagination. */
    listGroups(sessionId) {
        return this.getEngine(sessionId).getGroups();
    }
    getGroups(sessionId, opts = {}) {
        // getEngine throws synchronously (sync 400 guard); the engine returns the full set and we
        // bound the HTTP response window via paginate().
        return this.listGroups(sessionId).then(groups => (0, paginate_1.paginate)(groups, opts.limit, opts.offset));
    }
    async getGroupInfo(sessionId, groupId) {
        const group = await this.getEngine(sessionId).getGroupInfo(groupId);
        if (!group) {
            throw new common_1.NotFoundException(`Group ${groupId} not found`);
        }
        return group;
    }
    /**
     * Creating a group invites every listed participant in the same call, so it carries the same
     * reachout cost as adding them one by one — and is paced accordingly.
     */
    async createGroup(sessionId, name, participants) {
        this.assertAddressableParticipants(participants);
        const reservation = await this.pacing.assertReachoutAllowed(sessionId, participants);
        try {
            return await this.getEngine(sessionId).createGroup(name, participants);
        }
        catch (error) {
            // A refusal invited nobody, so the reserved budget goes back (whatsapp-web.js always 501s here).
            // An outcome-unknown failure stays charged.
            if (contactedNobody(error))
                this.pacing.refundGroupReachouts(sessionId, reservation);
            throw error;
        }
    }
    /**
     * Paced: putting the account in front of people who did not ask for it, in bulk, is the most
     * ban-associated action this product performs. Each participant the account has no history with
     * draws on the same cold-reachout budget a first message does.
     */
    async addParticipants(sessionId, groupId, participants) {
        this.assertAddressableParticipants(participants);
        const reservation = await this.pacing.assertReachoutAllowed(sessionId, participants);
        try {
            return await this.getEngine(sessionId).addParticipants(groupId, participants);
        }
        catch (error) {
            // A refused add contacted nobody. Per-participant failures an engine reports without throwing
            // stay charged: the batch was attempted. So does an outcome-unknown failure.
            if (contactedNobody(error))
                this.pacing.refundGroupReachouts(sessionId, reservation);
            throw error;
        }
    }
    removeParticipants(sessionId, groupId, participants) {
        this.assertAddressableParticipants(participants);
        return this.getEngine(sessionId).removeParticipants(groupId, participants);
    }
    promoteParticipants(sessionId, groupId, participants) {
        this.assertAddressableParticipants(participants);
        return this.getEngine(sessionId).promoteParticipants(groupId, participants);
    }
    demoteParticipants(sessionId, groupId, participants) {
        this.assertAddressableParticipants(participants);
        return this.getEngine(sessionId).demoteParticipants(groupId, participants);
    }
    getGroupMembershipRequests(sessionId, groupId) {
        return this.getEngine(sessionId).getGroupMembershipRequests(groupId);
    }
    /**
     * Deliberately NOT paced, unlike addParticipants: the people here asked for the contact
     * themselves, so approving (or rejecting) them draws nothing from the cold-reachout budget.
     * `participants` omitted means every pending request — so the shape guard is conditional, not
     * skipped: these routes take the same participant ids as the writes above, and whatsapp-web.js
     * feeds a named requester straight to `requesterIds.map(createWid)`.
     */
    approveGroupMembershipRequests(sessionId, groupId, participants) {
        if (participants)
            this.assertAddressableParticipants(participants);
        return this.getEngine(sessionId).approveGroupMembershipRequests(groupId, participants);
    }
    rejectGroupMembershipRequests(sessionId, groupId, participants) {
        if (participants)
            this.assertAddressableParticipants(participants);
        return this.getEngine(sessionId).rejectGroupMembershipRequests(groupId, participants);
    }
    setGroupSubject(sessionId, groupId, subject) {
        return this.getEngine(sessionId).setGroupSubject(groupId, subject);
    }
    setGroupDescription(sessionId, groupId, description) {
        return this.getEngine(sessionId).setGroupDescription(groupId, description);
    }
    setGroupMemberLabel(sessionId, groupId, label) {
        this.assertGroupId(groupId);
        // Baileys relays the label as a group message only to a jid whose domain is exactly `g.us`; any
        // other spelling the check accepts (`120363@G.US`, a trailing space) went out as a 1:1 message.
        return this.getEngine(sessionId).setGroupMemberLabel((0, wa_id_1.toNeutralJid)(groupId), label);
    }
    leaveGroup(sessionId, groupId) {
        return this.getEngine(sessionId).leaveGroup(groupId);
    }
    getGroupInviteCode(sessionId, groupId) {
        return this.getEngine(sessionId).getGroupInviteCode(groupId);
    }
    revokeGroupInviteCode(sessionId, groupId) {
        return this.getEngine(sessionId).revokeGroupInviteCode(groupId);
    }
    /**
     * Preview a group from an invite code. The code is required rather than optional-with-a-default:
     * an empty one would reach the engine and come back as a confusing not-found instead of the
     * client error it is.
     */
    getGroupJoinInfo(sessionId, inviteCode) {
        const code = this.requireInviteCode(inviteCode);
        return this.getEngine(sessionId).getGroupJoinInfo(code);
    }
    /** Same rule as the preview, so a code that previews also joins. */
    joinGroupViaInviteCode(sessionId, inviteCode) {
        const code = this.requireInviteCode(inviteCode);
        return this.getEngine(sessionId).joinGroupViaInviteCode(code);
    }
    requireInviteCode(inviteCode) {
        const code = inviteCode?.trim();
        if (!code) {
            throw new common_1.BadRequestException('An invite code is required');
        }
        return code;
    }
    /**
     * Refuse an id that does not name a group before it reaches an engine.
     *
     * These three routes reuse the ACCOUNT's profile-picture primitives, and Baileys omits the `target`
     * attribute whenever the jid it is handed is the account's own — so a 1:1 id passed where a group id
     * belongs replaced or permanently deleted the account's own avatar and answered 200, while
     * whatsapp-web.js refused the same input through requireGroupChat. Guarded here rather than in either
     * adapter so both engines agree, and so no engine ever sees the wrong kind of id.
     *
     * The member label uses it too: Baileys relays that label as a message to whatever jid it is given, so
     * a 1:1 id would send a group protocol message to a person.
     *
     * One `@` only: the kind is read after the last one, while Baileys reads the domain after the first, so
     * `628123456789@c.us@g.us` passed here as a group and Baileys relayed it on its 1:1 path.
     */
    assertGroupId(groupId) {
        if ((0, wa_id_1.chatKind)(groupId) !== 'group' || groupId.indexOf('@') !== groupId.lastIndexOf('@')) {
            throw new common_1.BadRequestException(`${groupId} is not a group id`);
        }
    }
    /** Read the group's picture URL, or null when it has none. Groups reuse the profile-picture read. */
    getGroupPicture(sessionId, groupId) {
        this.assertGroupId(groupId);
        return this.getEngine(sessionId).getProfilePicture(groupId);
    }
    setGroupPicture(sessionId, groupId, dto) {
        this.assertGroupId(groupId);
        // base64 wins over url when both are present, mirroring setProfilePicture.
        const media = (0, media_cap_util_1.resolveMediaBody)(dto, {
            fallbackMimetype: 'image/jpeg',
            requireMimetypeForBase64: true,
            checkUrl: true,
        });
        return this.getEngine(sessionId).setGroupPicture(groupId, media);
    }
    deleteGroupPicture(sessionId, groupId) {
        this.assertGroupId(groupId);
        return this.getEngine(sessionId).deleteGroupPicture(groupId);
    }
    /** Read the group's announce/locked/ephemeral/member-add settings; 404s (via getGroupInfo) when unknown. */
    async getGroupSettings(sessionId, groupId) {
        const group = await this.getGroupInfo(sessionId, groupId);
        return {
            announce: group.announce,
            locked: group.locked,
            ...(group.ephemeralSeconds !== undefined ? { ephemeralSeconds: group.ephemeralSeconds } : {}),
            ...(group.memberAddMode !== undefined ? { memberAddMode: group.memberAddMode } : {}),
        };
    }
    /**
     * Apply the given settings; each present field maps to one engine call, absent fields stay
     * untouched. An empty patch is a client error. EngineNotSupportedError (e.g. ephemeralSeconds on
     * the wwjs engine) propagates as 501.
     *
     * Ordering matters: ephemeralSeconds is applied FIRST because it is the only field with a
     * deterministic per-engine refusal (wwjs always 501s it). Applying announce/locked first would
     * leave a silently half-applied patch behind when the ephemeral call then throws.
     *
     * A failure on the FIRST applied field propagates unchanged (nothing was applied, so the patch
     * simply failed, except for a 503: a WhatsApp timeout can still land the change). A failure on a
     * LATER field means the group is now in a mixed state, so the
     * error names the failed field and the ones already applied — the caller can reconcile instead
     * of guessing which subset took effect. The wrapped error keeps the underlying HTTP status, and
     * carries the underlying message only for an HTTP error; any other failure is logged here and
     * reported as an internal error.
     */
    async updateGroupSettings(sessionId, groupId, settings) {
        const { announce, locked, ephemeralSeconds, memberAddMode } = settings;
        if (announce === undefined &&
            locked === undefined &&
            ephemeralSeconds === undefined &&
            memberAddMode === undefined) {
            throw new common_1.BadRequestException('At least one of announce, locked, ephemeralSeconds, memberAddMode must be provided');
        }
        const engine = this.getEngine(sessionId);
        const steps = [];
        if (ephemeralSeconds !== undefined) {
            steps.push(['ephemeralSeconds', () => engine.setGroupEphemeral(groupId, ephemeralSeconds)]);
        }
        // After ephemeralSeconds, per the ordering rule above: this field is supported on both engines,
        // so it carries no deterministic refusal and must not displace the one field that does.
        if (memberAddMode !== undefined) {
            steps.push(['memberAddMode', () => engine.setGroupMemberAddMode(groupId, memberAddMode)]);
        }
        if (announce !== undefined) {
            steps.push(['announce', () => engine.setGroupMessagesAdminsOnly(groupId, announce)]);
        }
        if (locked !== undefined) {
            steps.push(['locked', () => engine.setGroupInfoAdminsOnly(groupId, locked)]);
        }
        const applied = [];
        for (const [field, apply] of steps) {
            try {
                await apply();
                applied.push(field);
            }
            catch (error) {
                if (applied.length === 0)
                    throw error;
                const status = error instanceof common_1.HttpException ? error.getStatus() : common_1.HttpStatus.INTERNAL_SERVER_ERROR;
                let detail = 'internal error';
                if (error instanceof common_1.HttpException) {
                    detail = error.message;
                }
                else {
                    this.logger.error('Group settings step failed after a partial apply', error instanceof Error ? error.stack : String(error), { sessionId, groupId, field, applied: applied.join(',') });
                }
                throw new common_1.HttpException(`Group settings only partially applied: '${field}' failed (${detail}); already applied: ${applied.join(', ')}`, status);
            }
        }
    }
};
exports.GroupService = GroupService;
exports.GroupService = GroupService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [engine_registry_service_1.EngineRegistry,
        send_pacing_service_1.SendPacingService])
], GroupService);
