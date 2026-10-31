"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysGroups = void 0;
exports.refusedStatusCode = refusedStatusCode;
exports.mapServerRefusal = mapServerRefusal;
exports.toEngineParticipants = toEngineParticipants;
exports.collectGroupLidTwins = collectGroupLidTwins;
const baileys_group_mapper_1 = require("./baileys-group-mapper");
const group_not_found_error_1 = require("../../common/errors/group-not-found.error");
const baileys_messaging_1 = require("./baileys-messaging");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const engine_throttled_error_1 = require("../../common/errors/engine-throttled.error");
const invalid_invite_code_error_1 = require("../../common/errors/invalid-invite-code.error");
const baileys_query_deadline_1 = require("./baileys-query-deadline");
const wa_id_1 = require("../identity/wa-id");
/**
 * WA error code of a SERVER-refused Baileys query, or undefined for a transport/local failure.
 *
 * A numeric `data` is the whole discriminator, and it is sufficient: `query()` runs
 * `assertNodeErrorFree(result)` before it returns (Socket/socket.js:133-135), and that throws
 * `new Boom(text, { data: +errNode.attrs.code })` (WABinary/generic-utils.js:57). So every refusal
 * that can reach a caller through `query()` already carries its WA code as a number.
 *
 * There used to be a second branch reading `output.statusCode` whenever `data !== undefined`,
 * meant for `extractGroupMetadata`'s error-node throw (Socket/groups.js). It did the opposite of
 * its purpose: Boom's constructor destructures `data = null` (@hapi/boom lib/index.js:77), so NO
 * Boom ever has `data === undefined` and the guard was always true. Every transport Boom therefore
 * matched — `Boom('Connection Closed', { statusCode: 428 })` returned 428, inside the 4xx window,
 * so a dead socket was reported as `403 admin rights or permissions may be missing`. The branch was
 * also unnecessary: its target throw cannot be reached through `query()`, because a result carrying
 * an `<error>` child has already thrown from assertNodeErrorFree's identical lookup.
 *
 * Only the IQ error channel is decoded here. WhatsApp's w:mex surface reports a refusal as a
 * GraphQL error inside a SUCCESSFUL iq, which never passes through assertNodeErrorFree and carries
 * an object rather than a numeric `data` — see wmexRefusalCode in baileys-channels.ts. Widening this
 * function to accept an object `data` would also swallow promiseTimeout's Boom, which carries
 * `{ stack }` alongside a 4xx DisconnectReason code, so the two channels stay separate.
 */
function refusedStatusCode(error) {
    const err = error;
    return typeof err?.data === 'number' ? err.data : undefined;
}
/**
 * Run a socket write and map a SERVER refusal (a 4xx-class WA code: admin rights missing, not
 * permitted, not acceptable) to EngineRefusedError — HTTP 403, the same status the whatsapp-web.js
 * adapter gives these causes — instead of letting the raw Boom escape as a 500. Transport/local
 * failures (dropped socket, timeout) propagate untouched: folding them in would report a dead
 * connection as a permissions problem.
 *
 * WA codes 408 and 429 (timed out, rate limited) become EngineTransportError (503) instead: a
 * throttled caller has not been refused, and a retry may succeed. A 429 is the EngineThrottledError
 * subclass, since a throttled request was not applied and a paced write can give its budget back.
 *
 * `notFound`, when given, takes WA code 404 (item-not-found) instead: a caller whose request names a
 * single resource maps it to that resource's not-found error rather than a permissions refusal.
 */
async function mapServerRefusal(operation, op, classify = refusedStatusCode, notFound) {
    try {
        return await op();
    }
    catch (error) {
        const code = classify(error);
        if (code === 404 && notFound) {
            throw notFound();
        }
        if (code === 429) {
            throw new engine_throttled_error_1.EngineThrottledError(`${operation} was rate-limited by WhatsApp (code ${code})`);
        }
        if (code === 408) {
            throw new engine_transport_error_1.EngineTransportError(`${operation} was timed out by WhatsApp (code ${code})`);
        }
        if (code !== undefined && code >= 400 && code < 500) {
            throw new engine_refused_error_1.EngineRefusedError(`${operation} was refused by WhatsApp (code ${code}) — admin rights or permissions may be missing`);
        }
        throw error;
    }
}
/**
 * Fold neutral `<phone>@c.us` participant ids back to the engine wire dialect (`@s.whatsapp.net`) before
 * a group write. `@lid` (a first-class addressing mode) and the group id itself are left untouched.
 *
 * A BARE number is qualified first. `toEngineJid` folds only an already-domained user id, so a bare
 * number used to travel verbatim into the participant node — and Baileys' encoder writes an
 * un-domained string as a packed nibble rather than a JID_PAIR, so WhatsApp received an attribute
 * that was not a JID and the write did nothing. The bare form is the documented convenience input on
 * these routes and the service guard accepts it, so it has to be addressable by the time it lands here.
 */
function toEngineParticipants(participants, toEngineJid) {
    return participants.map(p => toEngineJid((0, wa_id_1.toParticipantWid)(p)));
}
/** The neutral method tokens — Baileys' wire tokens are already this vocabulary. */
const MEMBERSHIP_REQUEST_METHODS = [
    'invite_link',
    'non_admin_add',
    'linked_group_join',
];
/**
 * The lid->phone twins a group roster carries inline (`participant.phoneNumber`, `metadata.ownerPn`).
 *
 * `resolvePhone` (session store) reads only the lid map that 1:1 traffic, message keys, history and
 * directed sends feed, so a member present solely in a group roster (never messaged, not a saved
 * contact) resolves to `null` on `GET /contacts/{lid}/phone`, even though the roster just fetched
 * carries their number (#1510). Harvesting the roster twins makes a fetched group's `@lid` members
 * resolvable thereafter, reusing the same write-through the message-key path uses. Only `@lid`-addressed
 * ids are harvested: a phone-addressed participant has no lid to key, and its `phoneNumber` would
 * otherwise key a bogus phone->phone pair.
 */
function collectGroupLidTwins(metadata) {
    const twins = [];
    for (const p of metadata.participants ?? []) {
        if (p.id?.endsWith('@lid') && p.phoneNumber) {
            twins.push({ lid: p.id, pn: p.phoneNumber });
        }
    }
    if (metadata.owner?.endsWith('@lid') && metadata.ownerPn) {
        twins.push({ lid: metadata.owner, pn: metadata.ownerPn });
    }
    return twins;
}
class BaileysGroups {
    host;
    queryBudgetMs;
    constructor(host, queryBudgetMs = baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS) {
        this.host = host;
        this.queryBudgetMs = queryBudgetMs;
    }
    /** Bound a write whose confirmation the library discards; see baileys-query-deadline.ts. */
    confirmed(work, operation) {
        return (0, baileys_query_deadline_1.confirmedWrite)(work, this.queryBudgetMs, operation);
    }
    /** Post-ensureReady socket handle. */
    sock() {
        return this.host.getSocket();
    }
    /**
     * {@link mapServerRefusal} for a request that names one group: WhatsApp's item-not-found (404)
     * means the group does not exist or is not visible to the account, which getGroupInfo already
     * reads as not-found, so it answers 404 as whatsapp-web.js does rather than a 403 permissions
     * refusal. The w:g2 group IQs are addressed to the group jid, and a leave names only that group.
     */
    async groupWrite(groupId, operation, op) {
        try {
            return await mapServerRefusal(operation, op, refusedStatusCode, () => new group_not_found_error_1.GroupNotFoundError(groupId));
        }
        finally {
            // A group write may change who is in the group and how it sends, confirmed or not, so the next send
            // to it reads the group again instead of reusing the participant list cached before.
            this.host.forgetGroupMetadata?.(groupId);
        }
    }
    /** Neutral → engine id fold for participant/mention lists. */
    toEngineParticipants(participants) {
        return toEngineParticipants(participants, jid => this.host.toEngineJid(jid));
    }
    async getGroups() {
        this.host.ensureReady();
        // groupFetchAllParticipating yields {} for BOTH an unanswered query and an account with no
        // groups, so the empty list carries no signal — only our own clock separates them, and an
        // empty list is the shape a caller is least able to question.
        let all;
        try {
            all = await (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupFetchAllParticipating(), this.queryBudgetMs, 'WhatsApp did not answer the group list query in time');
        }
        catch (err) {
            // A throttle is retryable, as on getGroupInfo. Any other refusal keeps its old shape: folding
            // it into mapServerRefusal's 403 would claim a permissions problem for a plain list read.
            const code = refusedStatusCode(err);
            if (code === 408 || code === 429) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp rate-limited or timed out the group list query (code ${code})`);
            }
            throw err;
        }
        const self = this.host.normalizedSelfJid();
        return Object.values(all).map(metadata => (0, baileys_group_mapper_1.mapBaileysGroup)(metadata, self, jid => this.host.toNeutralJid(jid)));
    }
    async getGroupInfo(groupId) {
        this.host.ensureReady();
        try {
            const metadata = await (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupMetadata(groupId), this.queryBudgetMs, 'WhatsApp did not answer the group metadata query in time');
            // Feed the roster's inline phone twins into the lid map so this group's @lid members become
            // resolvable via GET /contacts/{lid}/phone even if they have never messaged this account (#1510).
            this.host.addLidMappings(collectGroupLidTwins(metadata));
            return (0, baileys_group_mapper_1.mapBaileysGroupInfo)(metadata, jid => this.host.toNeutralJid(jid), this.host.normalizedSelfJid());
        }
        catch (err) {
            // Only a SERVER refusal may become null (→ service 404): the group does not exist or the
            // account cannot see it. Anything else — a dropped socket, a timeout, a protocol error —
            // folded into null makes a dead transport look like a missing group, so it propagates.
            const code = refusedStatusCode(err);
            if (code === 408 || code === 429) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp rate-limited or timed out the group metadata query (code ${code})`);
            }
            if (code === 401 || code === 403 || code === 404) {
                this.host.logger.debug('groupMetadata refused; treating as not-found', {
                    groupId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return null; // not a group / not visible to this account
            }
            throw err;
        }
    }
    /**
     * Deliberately NOT bounded by a deadline, unlike the reads either side of it. Creating a group is
     * the one non-idempotent operation here, and 503 is a backpressure status the Go SDK retries three
     * times for POST (sdk/go/retry.go) — an OpenWA deadline abandons the call without cancelling it,
     * so a slow-but-succeeding create could be issued four times and leave duplicate groups. An
     * unanswered query therefore still surfaces opaquely rather than as something retryable, and so
     * does WA code 408: a server timeout does not say whether the group was created.
     */
    async createGroup(name, participants) {
        this.host.ensureReady();
        const metadata = await mapServerRefusal('Creating the group', () => this.sock().groupCreate(name, this.toEngineParticipants(participants)), error => {
            const code = refusedStatusCode(error);
            return code === 408 ? undefined : code;
        });
        return (0, baileys_group_mapper_1.mapBaileysGroup)(metadata, this.host.normalizedSelfJid(), jid => this.host.toNeutralJid(jid));
    }
    async addParticipants(groupId, participants) {
        return this.runParticipantsUpdate(groupId, participants, 'add');
    }
    async removeParticipants(groupId, participants) {
        return this.runParticipantsUpdate(groupId, participants, 'remove');
    }
    async promoteParticipants(groupId, participants) {
        return this.runParticipantsUpdate(groupId, participants, 'promote');
    }
    async demoteParticipants(groupId, participants) {
        return this.runParticipantsUpdate(groupId, participants, 'demote');
    }
    /**
     * Baileys `groupParticipantsUpdate` resolves a per-participant `[{status, jid}]` array where
     * `status` is the server's error attr or '200' (Socket/groups.js:153-155) — discarding it turned
     * every not-admin/not-registered/already-member refusal into a reported success. Map the entries
     * verbatim; THROW only when the operation failed for every requested participant (a refusal of
     * the operation itself → HTTP 403) or the server returned no outcome at all.
     *
     * The per-participant array is not the only refusal channel: WhatsApp can reject the IQ itself,
     * and `assertNodeErrorFree` then throws with the WA code on `data`. Every other write in this file
     * routes through {@link mapServerRefusal} for exactly that; this one did not, so a batch-level
     * refusal escaped as an unhandled error (HTTP 500) instead of the 403 its siblings give. The
     * deadline stays INSIDE the mapping so a timeout is still reported as a timeout — `refusedStatusCode`
     * only classifies a numeric `data`, so a transport Boom passes through untouched.
     */
    async runParticipantsUpdate(groupId, participants, action) {
        this.host.ensureReady();
        // An unanswered query yields [], which the empty-results guard below would report as a refusal
        // — a dead transport sold to the caller as a permissions problem.
        const raw = await this.groupWrite(groupId, `The participant ${action}`, () => (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupParticipantsUpdate(groupId, this.toEngineParticipants(participants), action), this.queryBudgetMs, `WhatsApp did not answer the participant ${action} in time`));
        const results = (raw ?? []).map(entry => ({
            id: entry.jid ? this.host.toNeutralJid(entry.jid) : '',
            success: entry.status === '200',
            status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : undefined,
        }));
        if (results.length === 0) {
            throw new engine_refused_error_1.EngineRefusedError(`groupParticipantsUpdate(${action}) returned no per-participant outcome for group ${groupId}`);
        }
        if (results.every(r => !r.success)) {
            const detail = results.map(r => `${r.id || '?'} (${r.status ?? '?'})`).join(', ');
            throw new engine_refused_error_1.EngineRefusedError(`${action}Participants failed for all ${results.length} participant(s) in group ${groupId}: ${detail}`);
        }
        return results;
    }
    async leaveGroup(groupId) {
        this.host.ensureReady();
        // Wrapped like every other group write in this file. Without it WhatsApp's refusal for an
        // unknown or already-left group reached the client as an opaque 500; its not-found answers 404,
        // as whatsapp-web.js does after resolving the chat.
        await this.groupWrite(groupId, 'Leaving the group', () => this.confirmed(this.sock().groupLeave(groupId), 'leaving the group'));
    }
    async setGroupSubject(groupId, subject) {
        this.host.ensureReady();
        await this.groupWrite(groupId, 'Setting the group subject', () => this.confirmed(this.sock().groupUpdateSubject(groupId, subject), 'the group subject change'));
    }
    async setGroupDescription(groupId, description) {
        this.host.ensureReady();
        await this.groupWrite(groupId, 'Setting the group description', () => this.confirmed(this.sock().groupUpdateDescription(groupId, description), 'the group description change'));
    }
    /**
     * Fetching an invite code is admin-only, but every group the account belongs to is listed by
     * getGroups regardless of role — so the refusal lands on ids the caller has just been handed.
     * Both failure shapes are surfaced rather than flattened into a code: a refusal rejects with a
     * Boom carrying the WA code (403, like every other admin-gated group operation), while an
     * unanswered query resolves undefined, which coalescing to '' turned into the meaningless link
     * "https://chat.whatsapp.com/" behind a 200.
     */
    async getGroupInviteCode(groupId) {
        this.host.ensureReady();
        const code = await this.groupWrite(groupId, 'Fetching the group invite code', () => (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupInviteCode(groupId), this.queryBudgetMs, 'WhatsApp did not answer the group invite-code query in time'));
        if (!code) {
            throw new engine_transport_error_1.EngineTransportError('WhatsApp did not answer the group invite-code query');
        }
        return code;
    }
    async revokeGroupInviteCode(groupId) {
        this.host.ensureReady();
        // Bounded like the read: a revoke WhatsApp applies after the deadline only mints a code nobody holds,
        // and a retry mints another.
        const code = await this.groupWrite(groupId, 'Revoking the group invite code', () => (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupRevokeInvite(groupId), this.queryBudgetMs, 'WhatsApp did not answer the group invite-code revocation in time'));
        if (!code) {
            throw new engine_transport_error_1.EngineTransportError('WhatsApp did not answer the group invite-code revocation');
        }
        return code;
    }
    /**
     * Preview a group from its invite code. Read-only — nothing about membership changes, which is
     * what makes it safe to call on a code from an untrusted source.
     *
     * Unlike whatsapp-web.js this comes back typed (GroupMetadata), so the mapping is direct. The
     * participant LIST is dropped even when present: a preview reports a count, and passing a list
     * through would say more about a group the account has not joined than the other engine can.
     */
    async getGroupJoinInfo(inviteCode) {
        this.host.ensureReady();
        let meta;
        try {
            meta = await (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupGetInviteInfo(inviteCode), this.queryBudgetMs, 'WhatsApp did not answer the invite-info query in time');
        }
        catch (error) {
            // Baileys throws a Boom carrying the WA code for an invalid/expired/revoked invite — the
            // route's documented 404 (matching whatsapp-web.js), not a 500. Transport failures propagate.
            const code = refusedStatusCode(error);
            if (code === 408 || code === 429) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp rate-limited or timed out the invite-info query (code ${code})`);
            }
            if (code !== undefined && code >= 400 && code < 500) {
                throw new group_not_found_error_1.GroupNotFoundError(inviteCode);
            }
            throw error;
        }
        if (!meta?.id) {
            throw new group_not_found_error_1.GroupNotFoundError(inviteCode);
        }
        const count = typeof meta.size === 'number' ? meta.size : meta.participants?.length;
        return {
            id: this.host.toNeutralJid(meta.id),
            name: String(meta.subject ?? ''),
            ...(meta.desc ? { description: String(meta.desc) } : {}),
            // ownerPn is the phone-dialect twin of a lid owner: prefer it so the neutral id does not
            // depend on whether the lid->pn mapping happens to be learned yet.
            ...((meta.ownerPn ?? meta.owner) ? { owner: this.host.toNeutralJid(meta.ownerPn ?? meta.owner) } : {}),
            ...(typeof meta.creation === 'number' ? { createdAt: meta.creation } : {}),
            ...(typeof count === 'number' ? { participantCount: count } : {}),
        };
    }
    async joinGroupViaInviteCode(inviteCode) {
        this.host.ensureReady();
        // Baileys resolves undefined when the invite is invalid/expired/revoked — no group id surfaces —
        // and rejects with an IQ error (e.g. not-authorized / gone) for the same client-facing cause.
        // Both map to a 400. A transport failure (dropped socket, timeout) is NOT a refused invite:
        // folding it into the 400 makes a dead connection look like a bad code, so it propagates.
        //
        // That guarantee needs the deadline to hold at all. An UNANSWERED query also resolves undefined
        // — it never reaches the catch — so without a clock of our own it lands on the same `if (!jid)`
        // as a genuinely bad code and answers 400, which is precisely what the paragraph above forbids.
        let jid;
        try {
            jid = await (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupAcceptInvite(inviteCode), this.queryBudgetMs, 'WhatsApp did not answer the group join in time');
        }
        catch (error) {
            const code = refusedStatusCode(error);
            if (code === undefined || code < 400 || code >= 500) {
                throw error;
            }
            if (code === 408 || code === 429) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp rate-limited or timed out the group join (code ${code})`);
            }
            this.host.logger.warn('Group invite refused', { error: String(error) });
            jid = undefined;
        }
        if (!jid) {
            throw new invalid_invite_code_error_1.InvalidInviteCodeError();
        }
        // The returned group JID crosses the engine boundary, so it is neutralized like every other emission.
        return this.host.toNeutralJid(jid);
    }
    async setGroupMessagesAdminsOnly(groupId, adminsOnly) {
        this.host.ensureReady();
        await this.groupWrite(groupId, 'Setting who may send messages', () => this.confirmed(this.sock().groupSettingUpdate(groupId, adminsOnly ? 'announcement' : 'not_announcement'), 'the who-may-send change'));
    }
    async setGroupInfoAdminsOnly(groupId, adminsOnly) {
        this.host.ensureReady();
        await this.groupWrite(groupId, 'Setting who may edit group info', () => this.confirmed(this.sock().groupSettingUpdate(groupId, adminsOnly ? 'locked' : 'unlocked'), 'the who-may-edit change'));
    }
    async setGroupPicture(groupId, media) {
        this.host.ensureReady();
        // Same socket call as the own-account picture, addressed at the group JID.
        const { data } = await (0, baileys_messaging_1.resolveMediaBuffer)(media, this.host.sessionProxyUrl());
        await (0, baileys_messaging_1.assertReadableImage)(data);
        await this.pictureWrite(groupId, 'Setting the group picture', () => this.confirmed(this.sock().updateProfilePicture(groupId, data), 'the group picture change'));
    }
    async deleteGroupPicture(groupId) {
        this.host.ensureReady();
        await this.pictureWrite(groupId, 'Removing the group picture', () => this.confirmed(this.sock().removeProfilePicture(groupId), 'the group picture removal'));
    }
    /**
     * Not groupWrite: the w:profile:picture IQ goes to the server with the group as `target`, so a
     * 404 there is not known to mean the group is gone (on a removal it may mean "no picture"). A
     * refusal is therefore checked against the group metadata, and only a metadata item-not-found (404)
     * answers 404; a group the account left or was removed from (401/403) stays a 403 refusal, as in
     * groupWrite. The extra query is paid on the refusal path alone.
     */
    async pictureWrite(groupId, operation, op) {
        try {
            await mapServerRefusal(operation, op);
        }
        catch (err) {
            if (err instanceof engine_refused_error_1.EngineRefusedError) {
                // Inside the chain so a socket torn down meanwhile (sock() throwing) is a failed lookup too.
                const lookupCode = await Promise.resolve()
                    .then(() => (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupMetadata(groupId), this.queryBudgetMs, 'WhatsApp did not answer the group metadata query in time'))
                    .then(() => undefined, (lookupErr) => refusedStatusCode(lookupErr));
                if (lookupCode === 404)
                    throw new group_not_found_error_1.GroupNotFoundError(groupId);
            }
            throw err;
        }
    }
    async setGroupMemberAddMode(groupId, mode) {
        this.host.ensureReady();
        // A dedicated socket call, not a groupSettingUpdate option.
        await this.groupWrite(groupId, 'Setting the member-add mode', () => this.confirmed(this.sock().groupMemberAddMode(groupId, mode === 'admins' ? 'admin_add' : 'all_member_add'), 'the member-add-mode change'));
    }
    async setGroupEphemeral(groupId, durationSec) {
        this.host.ensureReady();
        await this.groupWrite(groupId, 'Setting the disappearing-message timer', () => this.confirmed(this.sock().groupToggleEphemeral(groupId, durationSec), 'the disappearing-message timer change'));
    }
    /**
     * Not an IQ: `updateMemberLabel` relays a GROUP_MEMBER_LABEL_CHANGE protocol message to the group and
     * resolves with its message id once sent, so a 4xx here is the group lookup the relay depends on.
     */
    async setGroupMemberLabel(groupId, label) {
        this.host.ensureReady();
        await this.groupWrite(groupId, 'Setting the member label', () => this.confirmed(this.sock().updateMemberLabel(groupId, label), 'the member label change'));
    }
    async getGroupMembershipRequests(groupId) {
        this.host.ensureReady();
        const raw = await this.groupWrite(groupId, 'Listing the membership requests', () => (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupRequestParticipantsList(groupId), this.queryBudgetMs, 'WhatsApp did not answer the membership-request list query in time'));
        // Bare wire attrs: engine-dialect `jid`, snake_case `request_method`, stringly `request_time`.
        // Fields that do not parse are omitted rather than defaulted; an entry without a jid carries
        // nothing addressable and is dropped.
        return (raw ?? []).flatMap(attrs => {
            if (!attrs.jid) {
                return [];
            }
            const method = MEMBERSHIP_REQUEST_METHODS.includes(attrs.request_method)
                ? attrs.request_method
                : undefined;
            const requestedAt = Number(attrs.request_time);
            return [
                {
                    participantId: this.host.toNeutralJid(attrs.jid),
                    ...(method ? { method } : {}),
                    ...(Number.isFinite(requestedAt) && requestedAt > 0 ? { requestedAt: Math.floor(requestedAt) } : {}),
                },
            ];
        });
    }
    approveGroupMembershipRequests(groupId, participants) {
        return this.runMembershipRequestsUpdate(groupId, participants, 'approve');
    }
    rejectGroupMembershipRequests(groupId, participants) {
        return this.runMembershipRequestsUpdate(groupId, participants, 'reject');
    }
    /**
     * `groupRequestParticipantsUpdate` resolves the same per-jid `[{status, jid}]` shape as the
     * participant writes (status is the server's error attr or '200', Socket/groups.js:116-139), and
     * the same guards apply — but only when the caller NAMED requesters. Baileys has no act-on-all
     * form, so an omitted list enumerates the pending queue first; an empty queue is a legitimate
     * no-op that resolves [], not a refusal.
     */
    async runMembershipRequestsUpdate(groupId, participants, action) {
        this.host.ensureReady();
        let targets;
        if (participants) {
            targets = this.toEngineParticipants(participants);
        }
        else {
            const pending = await this.groupWrite(groupId, `Listing the membership requests to ${action}`, () => (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupRequestParticipantsList(groupId), this.queryBudgetMs, 'WhatsApp did not answer the membership-request list query in time'));
            targets = (pending ?? []).map(attrs => attrs.jid).filter((jid) => Boolean(jid));
            if (targets.length === 0) {
                return [];
            }
        }
        const raw = await this.groupWrite(groupId, `Membership-request ${action}`, () => (0, baileys_query_deadline_1.withQueryDeadline)(this.sock().groupRequestParticipantsUpdate(groupId, targets, action), this.queryBudgetMs, `WhatsApp did not answer the membership-request ${action} in time`));
        const results = (raw ?? []).map(entry => ({
            id: entry.jid ? this.host.toNeutralJid(entry.jid) : '',
            success: entry.status === '200',
            status: Number.isFinite(Number(entry.status)) ? Number(entry.status) : undefined,
        }));
        if (!participants) {
            return results;
        }
        if (results.length === 0) {
            throw new engine_refused_error_1.EngineRefusedError(`groupRequestParticipantsUpdate(${action}) returned no per-participant outcome for group ${groupId}`);
        }
        if (results.every(r => !r.success)) {
            const detail = results.map(r => `${r.id || '?'} (${r.status ?? '?'})`).join(', ');
            throw new engine_refused_error_1.EngineRefusedError(`Membership-request ${action} failed for all ${results.length} participant(s) in group ${groupId}: ${detail}`);
        }
        return results;
    }
}
exports.BaileysGroups = BaileysGroups;
