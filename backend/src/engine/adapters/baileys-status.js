"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysStatus = void 0;
const common_1 = require("@nestjs/common");
const baileys_messaging_1 = require("./baileys-messaging");
const baileys_audio_probe_1 = require("./baileys-audio-probe");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const baileys_query_deadline_1 = require("./baileys-query-deadline");
/** How long WhatsApp keeps a status up. */
const STATUS_TTL_MS = 24 * 3_600_000;
class BaileysStatus {
    host;
    /** The recipients of each status posted here, until it expires, oldest first. */
    audiences = new Map();
    constructor(host) {
        this.host = host;
    }
    /** Post-ensureReady socket handle. */
    sock() {
        return this.host.getSocket();
    }
    /**
     * Send to `status@broadcast`. A send that fails after a stop or logout has torn its socket down is
     * not ready (409), as a chat send is; a failure on a socket still in place propagates. A proxied
     * session's media upload gets a deadline, as a chat send's does (BaileysMessaging.uploadTimeoutMs).
     */
    async sendStatus(content, options) {
        const sock = this.sock();
        const deadline = this.host.sessionProxyUrl() ? { mediaUploadTimeoutMs: baileys_query_deadline_1.BAILEYS_QUERY_BUDGET_MS } : {};
        try {
            return await sock.sendMessage('status@broadcast', content, { ...options, ...deadline });
        }
        catch (error) {
            if (this.host.getSocketOrNull() !== sock)
                throw new engine_not_ready_error_1.EngineNotReadyError();
            throw (0, baileys_messaging_1.mapSendRefusal)(error);
        }
    }
    postTextStatus(text, options) {
        // `linkPreview: null` is Baileys' explicit "no preview": with the key absent it runs its own
        // generator (link-preview-js, unfixed SSRF advisory) on any URL in the status text.
        return this.postStatus({ text, linkPreview: null }, options);
    }
    postImageStatus(media, options) {
        return this.postMediaStatus('image', media, options);
    }
    postVideoStatus(media, options) {
        return this.postMediaStatus('video', media, options);
    }
    postVoiceStatus(media, options) {
        return this.postMediaStatus('voice', media, options);
    }
    async postMediaStatus(kind, media, options) {
        this.host.ensureReady();
        // The kind's default labels a URL whose host serves a generic type, rather than octet-stream.
        const fallbackType = kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'audio/ogg; codecs=opus';
        const { data, mimetype } = await (0, baileys_messaging_1.resolveMediaBuffer)(media, this.host.sessionProxyUrl(), fallbackType);
        // A voice status carries no caption: WhatsApp has nowhere to render one on a status voice note,
        // and `ptt` is what makes it a voice note rather than an audio file. Baileys reads that same flag
        // to decide a status may take a background colour, so the colour `postStatus` already forwards
        // applies here for free.
        const content = kind === 'image'
            ? { image: data, caption: options.caption, mimetype }
            : kind === 'video'
                ? { video: data, caption: options.caption, mimetype }
                : { audio: data, mimetype, ptt: true, ...(await (0, baileys_audio_probe_1.describeAudio)(data, true)) };
        return this.postStatus(content, options);
    }
    /**
     * Best-effort status revoke. Unlike deleteMessage, status messages are NOT persisted, so the revoke
     * key must be constructed from statusId alone (no messageStore lookup). The participant is the
     * engine-dialect self JID (`<me>@s.whatsapp.net`). The revoke shape is empirically UNVERIFIED — the
     * live spike only tested posting; if WhatsApp rejects it, fall back to EngineNotSupportedError.
     *
     * Baileys sends a status stanza, the revoke included, to exactly its `statusJidList`: without one
     * the revoke reaches nobody, yet the send resolves and the status stays up for every viewer. Only
     * the recipients of a status this adapter posted are known, so any other id is refused.
     */
    async deleteStatus(statusId) {
        this.host.ensureReady();
        const audience = this.audiences.get(statusId);
        if (!audience || audience.expiresAt <= Date.now()) {
            throw new engine_refused_error_1.EngineRefusedError(`status ${statusId} was not posted by this session in the last 24 hours, so its recipients are ` +
                'unknown and the revoke cannot be addressed to them');
        }
        const sent = await this.sendStatus({
            delete: {
                remoteJid: 'status@broadcast',
                fromMe: true,
                id: statusId,
                participant: this.host.toEngineJid(this.host.normalizedSelfJid()),
            },
        }, { statusJidList: audience.jids });
        this.host.rememberOwnSend(sent?.key?.id);
    }
    /**
     * Post a status (story) to `status@broadcast` with a denormalized `statusJidList` (the allow-list of
     * neutral recipients folded back to the engine dialect). Image/video variants route through here too.
     * The outbound status echo is NOT persisted: status isn't a chat message (its id is recorded below
     * so handleMessagesUpsert skips the `type:'append'` echo as ours).
     */
    async postStatus(content, options) {
        this.host.ensureReady();
        // Baileys posts to exactly the statusJidList allow-list, so unlike whatsapp-web.js (which
        // broadcasts) an absent/empty recipients list would publish to nobody — reject it as a client
        // error here rather than send a status no contact can see.
        if (!options.recipients?.length) {
            throw new common_1.BadRequestException('recipients is required to post a status on the Baileys engine');
        }
        const statusJidList = options.recipients.map(r => this.host.toEngineJid(r));
        const sent = await this.sendStatus(content, {
            statusJidList,
            backgroundColor: options.backgroundColor,
            font: options.font,
        });
        this.host.rememberOwnSend(sent?.key?.id);
        const now = Date.now();
        for (const [id, audience] of this.audiences) {
            if (audience.expiresAt > now)
                break;
            this.audiences.delete(id);
        }
        if (sent?.key?.id)
            this.audiences.set(sent.key.id, { jids: statusJidList, expiresAt: now + STATUS_TTL_MS });
        return this.toStatusResult(sent);
    }
    /** Shape a Baileys send result into a StatusResult; expiresAt is timestamp + 24h (WhatsApp status TTL). */
    toStatusResult(sent) {
        const ts = sent?.messageTimestamp ? new Date(this.host.toUnixSeconds(sent.messageTimestamp) * 1000) : new Date();
        return {
            statusId: sent?.key?.id ?? '',
            timestamp: ts,
            expiresAt: new Date(ts.getTime() + STATUS_TTL_MS),
        };
    }
}
exports.BaileysStatus = BaileysStatus;
