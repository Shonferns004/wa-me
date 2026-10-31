"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysChannels = void 0;
exports.wmexRefusalCode = wmexRefusalCode;
const channel_not_found_error_1 = require("../../common/errors/channel-not-found.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const baileys_groups_1 = require("./baileys-groups");
const baileys_query_deadline_1 = require("./baileys-query-deadline");
/**
 * WA error code of a w:mex refusal, or undefined for anything else.
 *
 * executeWMexQuery (lib/Socket/mex.js) parses a GraphQL payload out of a SUCCESSFUL iq, so a
 * refusal never reaches assertNodeErrorFree and never carries the numeric `data` refusedStatusCode
 * reads. It throws `Boom(msg, { statusCode: errorCode, data: firstError })` instead — the code on
 * the Boom, the error node as `data`.
 *
 * The discriminator is a `data` that is a GraphQL error node, one carrying `message` or
 * `extensions`. Any object is not enough: promiseTimeout (Utils/generics.js) rejects a stalled send
 * or an unanswered query with `Boom('Timed Out', { statusCode: 408, data: { stack } })`, and
 * executeWMexQuery's OTHER throw carries the raw result node as `data`. Both are transport
 * failures, and reading their 4xx code as a refusal would turn a stalled socket into a 403 or 404.
 */
function wmexRefusalCode(error) {
    const err = error;
    if (typeof err?.data === 'number') {
        return err.data;
    }
    const node = err?.data;
    const isGraphQlError = typeof node === 'object' && node !== null && ('message' in node || 'extensions' in node);
    if (isGraphQlError && typeof err?.output?.statusCode === 'number') {
        return err.output.statusCode;
    }
    return undefined;
}
/** A wire number that may come as a string, or as NaN from the create parser; undefined unless finite. */
function finiteNumber(value) {
    const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    return n !== undefined && Number.isFinite(n) ? n : undefined;
}
class BaileysChannels {
    host;
    queryBudgetMs;
    constructor(host, queryBudgetMs = baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS) {
        this.host = host;
        this.queryBudgetMs = queryBudgetMs;
    }
    /**
     * Bound a channel call. executeWMexQuery throws Boom(..., { statusCode: 400, data: result }) when
     * nothing came back, and with result undefined Boom normalises data to null — so the refusal
     * classifier cannot place it and the raw Boom escapes as a bare 500.
     */
    bounded(work, operation) {
        return (0, baileys_query_deadline_1.withQueryDeadline)(work, this.queryBudgetMs, `WhatsApp did not answer ${operation} in time`);
    }
    /** Post-ensureReady socket handle. */
    sock() {
        return this.host.getSocket();
    }
    async getChannelById(channelId) {
        this.host.ensureReady();
        // newsletterMetadata resolves ANY channel by jid (richer than the wwjs subscribed-list lookup).
        const meta = await this.lookup('jid', channelId, 'the channel lookup');
        return meta ? this.toChannel(meta) : null;
    }
    async subscribeToChannel(inviteCode) {
        this.host.ensureReady();
        const meta = await this.lookup('invite', inviteCode, 'the invite lookup');
        if (!meta) {
            throw new channel_not_found_error_1.ChannelNotFoundError(inviteCode);
        }
        await (0, baileys_groups_1.mapServerRefusal)('Subscribing to the channel', () => this.bounded(this.sock().newsletterFollow(meta.id), 'the channel subscribe'), wmexRefusalCode);
        return this.toChannel(meta);
    }
    /**
     * A channel lookup that WhatsApp refuses (an unknown id, a bad invite code) comes back as a w:mex
     * GraphQL error rather than an empty node, so a 4xx refusal is read as "no such channel", the same
     * way the group invite lookup reads one. A rate limit (429) or a timeout (408) says nothing about
     * the channel, so it answers 503, as the deadline does.
     */
    async lookup(type, key, operation) {
        try {
            return await this.bounded(this.sock().newsletterMetadata(type, key), operation);
        }
        catch (error) {
            const code = wmexRefusalCode(error);
            if (code === 408 || code === 429) {
                throw new engine_transport_error_1.EngineTransportError(`WhatsApp rate-limited or timed out ${operation} (code ${code})`);
            }
            if (code !== undefined && code >= 400 && code < 500) {
                return null;
            }
            throw error;
        }
    }
    /**
     * Deliberately NOT bounded, unlike every other call here: creating a channel is non-idempotent,
     * and 503 is a backpressure status the Go SDK retries three times for POST (sdk/go/retry.go).
     * A deadline abandons without cancelling, so a slow-but-succeeding create could leave duplicates.
     * An unanswered query therefore still surfaces opaquely rather than as something retryable, and so
     * does WA code 408: a server timeout does not say whether the channel was created.
     */
    async createChannel(name, description) {
        this.host.ensureReady();
        const meta = await (0, baileys_groups_1.mapServerRefusal)('Creating the channel', () => this.sock().newsletterCreate(name, description), error => {
            const code = wmexRefusalCode(error);
            return code === 408 ? undefined : code;
        });
        return this.toChannel(meta);
    }
    /**
     * Demote a channel admin back to a plain subscriber. `userId` arrives in the NEUTRAL dialect and
     * is mapped here, the way the contact and messaging delegates map theirs.
     *
     * There is no promote counterpart to pair this with, and that is upstream rather than ours:
     * Baileys exposes `newsletterDemote`, `newsletterChangeOwner` and `newsletterAdminCount` but no
     * promote, and whatsapp-web.js has no `promoteChannelAdmin` at all. An admin is promoted from the
     * WhatsApp app and can then be demoted through this API.
     */
    async demoteChannelAdmin(channelId, userId) {
        this.host.ensureReady();
        const userJid = this.host.toEngineJid(userId);
        await (0, baileys_groups_1.mapServerRefusal)('Demoting the channel admin', () => this.bounded(this.sock().newsletterDemote(channelId, userJid), 'the channel admin demotion'), wmexRefusalCode);
    }
    /**
     * Hand the channel to a new owner. IRREVERSIBLE: the account stops being the owner and cannot
     * take it back through this API.
     *
     * Bounded, unlike `createChannel` above. That one stays unbounded because a retried create leaves
     * a duplicate channel behind; here a retry after a transfer that actually landed is refused, since
     * the account no longer owns the channel. So the deadline costs an ambiguous 503 ("may or may not
     * have applied") and buys a request that ends.
     */
    async transferChannelOwnership(channelId, newOwnerId) {
        this.host.ensureReady();
        const newOwnerJid = this.host.toEngineJid(newOwnerId);
        await (0, baileys_groups_1.mapServerRefusal)('Transferring the channel ownership', () => this.bounded(this.sock().newsletterChangeOwner(channelId, newOwnerJid), 'the channel ownership transfer'), wmexRefusalCode);
    }
    async deleteChannel(channelId) {
        this.host.ensureReady();
        await (0, baileys_groups_1.mapServerRefusal)('Deleting the channel', () => this.bounded(this.sock().newsletterDelete(channelId), 'the channel delete'), wmexRefusalCode);
    }
    async muteChannel(channelId, mute) {
        this.host.ensureReady();
        await (0, baileys_groups_1.mapServerRefusal)(mute ? 'Muting the channel' : 'Unmuting the channel', () => this.bounded(mute ? this.sock().newsletterMute(channelId) : this.sock().newsletterUnmute(channelId), mute ? 'the channel mute' : 'the channel unmute'), wmexRefusalCode);
    }
    async unsubscribeFromChannel(channelId) {
        this.host.ensureReady();
        // Unfollowing a channel the account no longer follows is refused like the other channel writes,
        // on either refusal channel, and answers the documented 403 as whatsapp-web.js does.
        await (0, baileys_groups_1.mapServerRefusal)('Unsubscribing from the channel', () => this.bounded(this.sock().newsletterUnfollow(channelId), 'the channel unsubscribe'), wmexRefusalCode);
    }
    /**
     * Map a channel to the neutral Channel shape (optionals only when present).
     *
     * Two shapes arrive here. newsletterCreate flattens its response (parseNewsletterCreateResponse),
     * but newsletterMetadata returns the raw GraphQL node untouched: fields nested under
     * `thread_metadata`, name and description as `{ text }`, counts and timestamps as strings. The
     * flat fields are read first and the nested ones fill the gaps. The flat parse uses parseInt, so
     * a missing number arrives as NaN and is dropped rather than serialized as null.
     *
     * No `picture`: neither shape carries a URL, only a CDN direct path.
     */
    toChannel(meta) {
        const thread = meta.thread_metadata;
        const description = meta.description ?? thread?.description?.text;
        const invite = meta.invite ?? thread?.invite;
        const subscriberCount = finiteNumber(meta.subscribers) ?? finiteNumber(thread?.subscribers_count);
        const verification = meta.verification ?? thread?.verification;
        const createdAt = finiteNumber(meta.creation_time) ?? finiteNumber(thread?.creation_time);
        return {
            id: meta.id,
            name: meta.name ?? thread?.name?.text ?? '',
            ...(description ? { description } : {}),
            ...(invite ? { inviteCode: invite } : {}),
            ...(subscriberCount !== undefined ? { subscriberCount } : {}),
            ...(verification ? { verified: verification === 'VERIFIED' } : {}),
            ...(createdAt !== undefined ? { createdAt } : {}),
        };
    }
}
exports.BaileysChannels = BaileysChannels;
