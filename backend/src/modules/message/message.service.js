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
var MessageService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MessageService = exports.DEFAULT_PIN_DURATION_SECONDS = exports.DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = exports.DEFAULT_TEMPLATE_RENDER_MAX_CHARS = void 0;
exports.resolveMessageListInlineMediaBudgetBytes = resolveMessageListInlineMediaBudgetBytes;
exports.omitInlineMedia = omitInlineMedia;
exports.createInlineMediaSpender = createInlineMediaSpender;
exports.spendInlineMediaBudget = spendInlineMediaBudget;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const stream_1 = require("stream");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const message_projector_service_1 = require("../session/message-projector.service");
const message_entity_1 = require("./entities/message.entity");
const hooks_1 = require("../../core/hooks");
const send_pacing_service_1 = require("./send-pacing.service");
const logger_service_1 = require("../../common/services/logger.service");
const jid_candidates_1 = require("../../engine/identity/jid-candidates");
const wa_id_1 = require("../../engine/identity/wa-id");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const chat_media_archive_service_1 = require("../chat-media/chat-media-archive.service");
const storage_service_1 = require("../../common/storage/storage.service");
const message_send_service_1 = require("./message-send.service");
const message_window_1 = require("./message-window");
// Re-exported for existing importers (bulk send shares the rendered-template cap with the send path).
var message_send_service_2 = require("./message-send.service");
Object.defineProperty(exports, "DEFAULT_TEMPLATE_RENDER_MAX_CHARS", { enumerable: true, get: function () { return message_send_service_2.DEFAULT_TEMPLATE_RENDER_MAX_CHARS; } });
/**
 * Aggregate budget for the inline base64 media ONE message-list response may carry, counted in the
 * encoded bytes that actually land in the JSON body. Override with
 * MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES; 0 omits every payload.
 *
 * The row count was already clamped to 1..100, but a row is not a bounded object: `metadata.media.data`
 * holds the whole base64 payload, so a hundred media rows serialise to hundreds of megabytes — past
 * V8's string ceiling the read fails outright, and the dashboard requests the maximum page size with
 * no way to ask for less. Mirrors the export path's budget rather than inventing a second policy.
 *
 * NOT a hard ceiling on the response. The newest payload is let through whatever its size (see
 * spendInlineMediaBudget), so the real bound is `max(budget, one payload)` — and one payload is
 * bounded upstream by `capInboundMedia` at MEDIA_DOWNLOAD_MAX_BYTES (50 MiB by default, ~68 MiB once
 * base64-encoded). That is well inside V8's string ceiling and is the point: the alternative is a
 * large photo no client can ever read back. Raising MEDIA_DOWNLOAD_MAX_BYTES raises this too.
 *
 * It bounds the read as well: getMessages loads a page in chunks and drops each omitted payload
 * before reading the next chunk, so payloads past the budget are never all held at once.
 */
exports.DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = 8 * 1024 * 1024;
function resolveMessageListInlineMediaBudgetBytes() {
    const parsed = Number.parseInt(process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES ?? '', 10);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : exports.DEFAULT_MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
}
/** `metadata.media.data` holds `base64 || url`, so a pointer must never be mistaken for a payload. */
const MEDIA_URL_POINTER = /^https?:\/\//i;
/**
 * The engine's own `{ omitted: true, sizeBytes }` marker for a media object whose payload is dropped,
 * the same shape `capInboundMedia` writes when inbound media is skipped on the way in, so a trimmed
 * row is not a new shape consumers must learn. Every descriptive field except `data` survives.
 */
function omitInlineMedia(media) {
    const { data, ...withoutPayload } = media;
    return {
        ...withoutPayload,
        omitted: true,
        // Decoded bytes, matching what capInboundMedia reports: the caller asked how big it WAS.
        sizeBytes: media.sizeBytes ?? Buffer.byteLength(data, 'base64'),
    };
}
/**
 * Stateful form of spendInlineMediaBudget: feed it the rows of one page newest-first, one at a time,
 * so a caller can drop each omitted payload before it reads the next row.
 */
function createInlineMediaSpender(budgetBytes) {
    let spent = 0;
    return message => {
        const metadata = message.metadata;
        if (!metadata || typeof metadata !== 'object')
            return;
        // A revoked message has no media, even on a row restored or merged after its revoke was cleared.
        if (message.type === 'revoked') {
            delete metadata.media;
            return;
        }
        const media = metadata.media;
        if (!media || typeof media.data !== 'string' || MEDIA_URL_POINTER.test(media.data))
            return;
        const encoded = Buffer.byteLength(media.data, 'utf8');
        // The newest payload is always let through when inlining is enabled at all. Without this an
        // item larger than the whole budget was omitted even as the ONLY media on the page, so a single
        // large photo or video (well inside the bytes the gateway stores inline) could never be read
        // back through this route: the dashboard thread has no other media source and caches with
        // staleTime: Infinity, leaving a permanent placeholder for media WhatsApp displays.
        // A budget of 0 means "do not inline", not "a very small budget", so it grants no allowance.
        const allowanceApplies = spent === 0 && budgetBytes > 0;
        if (spent + encoded <= budgetBytes || allowanceApplies) {
            spent += encoded;
            return;
        }
        metadata.media = omitInlineMedia({ ...media, data: media.data });
    };
}
/**
 * Spend the budget over an already-ordered (newest-first) page, replacing each payload past it with
 * the omitted marker (see omitInlineMedia). Mutates and returns the rows.
 *
 * A budget, not a blanket strip: the recent media a caller is most likely reading still arrives
 * inline, and anything dropped remains fetchable from GET /:chatId/:messageId/media.
 */
function spendInlineMediaBudget(messages, budgetBytes) {
    messages.forEach(createInlineMediaSpender(budgetBytes));
    return messages;
}
/**
 * Floor for the bytes of stored metadata one message-list read loads at once. The page is read in
 * chunks of at most `max(budget, this)` metadata bytes (at least one row each), and each chunk's
 * omitted payloads are dropped before the next chunk is read, so the heap holds about one chunk plus
 * what the budget keeps instead of every payload on the page.
 */
const MESSAGE_LIST_READ_CHUNK_MIN_BYTES = 1024 * 1024;
/** The phone digits of a user JID (`<digits>@c.us` or `@s.whatsapp.net`), as a one-item list, or none. */
function bareUserDigits(id) {
    const { kind, userPart } = (0, wa_id_1.parseWaId)(id);
    return kind === 'user' && /^\d+$/.test(userPart) ? [userPart] : [];
}
/** Pin window applied when the caller does not choose one — WhatsApp's own default of 24h. */
exports.DEFAULT_PIN_DURATION_SECONDS = 86400;
/**
 * Mimetypes an archived chat-media file may be served as. Everything else — documents, and notably
 * `image/svg+xml`, which is scriptable despite the `image/` prefix — is served as inert
 * octet-stream so the media endpoint cannot host active content on the API origin.
 */
const INERT_MEDIA_MIMETYPE = /^(image\/(jpeg|png|gif|webp|bmp)|video\/(mp4|webm|quicktime|3gpp)|audio\/(mpeg|mp4|ogg|aac|wav|webm))$/;
/**
 * The declared mimetype's normalized essence when it is safe to echo back, else inert octet-stream.
 * Parameters are dropped rather than echoed: the sender wrote them, a comma among them makes a
 * browser read a second type, and a character above U+00FF is refused as a header value.
 */
function inertMimetype(mimetype) {
    const essence = mimetype.split(';')[0].trim().toLowerCase();
    return INERT_MEDIA_MIMETYPE.test(essence) ? essence : 'application/octet-stream';
}
let MessageService = class MessageService {
    static { MessageService_1 = this; }
    messageRepository;
    engines;
    messageProjector;
    hookManager;
    lidMappingStore;
    pacing;
    sender;
    chatMediaArchive;
    storageService;
    logger = (0, logger_service_1.createLogger)('MessageService');
    constructor(messageRepository, engines, messageProjector, hookManager, lidMappingStore, 
    // Required, not @Optional: a missing pacing service would silently mean "no pacing", which is
    // the one failure mode this feature must not have. The service itself no-ops when disabled.
    pacing, sender, chatMediaArchive, storageService) {
        this.messageRepository = messageRepository;
        this.engines = engines;
        this.messageProjector = messageProjector;
        this.hookManager = hookManager;
        this.lidMappingStore = lidMappingStore;
        this.pacing = pacing;
        this.sender = sender;
        this.chatMediaArchive = chatMediaArchive;
        this.storageService = storageService;
    }
    /**
     * Second sort key for the message list: what makes the page order TOTAL without scrambling the
     * order the messages actually arrived in.
     *
     * A tiebreaker is required, because `createdAt` is not unique. But `id` is a random v4 uuid, so
     * it orders a tie group at random: five same-second messages came back shuffled, and the
     * dashboard renders whatever the server sends. It is also in no index, so SQLite sorted the whole
     * result into a temp b-tree to apply it.
     *
     * SQLite already stores the insertion sequence as `rowid`, the implicit trailing column of every
     * index, so `(createdAt DESC, rowid DESC)` is a plain backward scan of `(sessionId, createdAt)`:
     * arrival order restored, and the temp b-tree gone with it. Measured on the pinned better-sqlite3
     * with the shipped index set.
     *
     * PostgreSQL has no equivalent. `ctid` is physical position and moves on every ack UPDATE, so it
     * cannot order anything, and a monotonic column would need a table rewrite on the hottest table
     * with no recoverable insertion order to backfill from. It keeps `id`: the walk stays correct,
     * and a same-second group keeps its uuid order there.
     */
    get orderTiebreak() {
        return this.messageRepository.manager?.connection?.options?.type === 'postgres' ? 'id' : 'rowid';
    }
    /**
     * The columns of a predicate, taken out of index consideration on SQLite, so a read of rows by `id` is a
     * primary key lookup. Nothing runs ANALYZE there, and from about ten ids on it prefers an index on the session
     * (or the chat) and visits every row of it, on the event loop. PostgreSQL has statistics and the plain
     * predicate. The column is quoted because TypeORM only quotes a path that follows a space, `=` or `(`, and
     * `from` is a keyword.
     */
    byPrimaryKey(predicate) {
        return this.orderTiebreak === 'rowid'
            ? predicate.replace(/\bmessage\.(?!id\b)(\w+)/g, '+"message"."$1"')
            : predicate;
    }
    // ========== Outbound sends (delegated) ==========
    //
    // The send family lives on MessageSendService; these pass-throughs keep the MessageService
    // surface stable for the controller, agent tools, plugin capabilities and bulk send, which were
    // all wired here before the split.
    sendText(sessionId, dto) {
        return this.sender.sendText(sessionId, dto);
    }
    sendTemplate(sessionId, dto) {
        return this.sender.sendTemplate(sessionId, dto);
    }
    sendImage(sessionId, dto) {
        return this.sender.sendImage(sessionId, dto);
    }
    sendVideo(sessionId, dto) {
        return this.sender.sendVideo(sessionId, dto);
    }
    sendAudio(sessionId, dto) {
        return this.sender.sendAudio(sessionId, dto);
    }
    sendDocument(sessionId, dto) {
        return this.sender.sendDocument(sessionId, dto);
    }
    sendLocation(sessionId, dto) {
        return this.sender.sendLocation(sessionId, dto);
    }
    sendContact(sessionId, dto) {
        return this.sender.sendContact(sessionId, dto);
    }
    sendPoll(sessionId, dto) {
        return this.sender.sendPoll(sessionId, dto);
    }
    sendSticker(sessionId, dto) {
        return this.sender.sendSticker(sessionId, dto);
    }
    // Typed by the DTO rather than an inline literal, like every sibling forwarder here. The literal
    // listed three fields while the controller already handed it a fourth, so the declaration said
    // less than what flowed through, and a non-REST caller (the agent tool) could not pass it at all.
    reply(sessionId, dto) {
        return this.sender.reply(sessionId, dto);
    }
    clickButton(sessionId, dto) {
        return this.sender.clickButton(sessionId, dto);
    }
    forward(sessionId, dto) {
        return this.sender.forward(sessionId, dto);
    }
    /** Persist an outbound row; exposed for the bulk path, which reuses the send-persistence rules. */
    saveOutgoingMessage(sessionId, data, lifetime) {
        return this.sender.saveOutgoingMessage(sessionId, data, lifetime);
    }
    /**
     * Get message history for a session
     */
    async getMessages(sessionId, options = {}) {
        const { chatId, from, after, inlineMedia } = options;
        (0, message_window_1.validateMessageWindow)(options);
        const messageTimeOrder = options.orderBy === 'timestamp';
        // Sanitize pagination: a non-finite limit/offset — e.g. `?limit=abc` -> NaN —
        // must never reach TypeORM's take()/skip(). Clamp to sane bounds; fall back to defaults.
        const rawLimit = options.limit;
        const rawOffset = options.offset;
        const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 100) : 50;
        // Capped at the largest safe integer: a driver refuses an OFFSET of 2^63 or more, and any offset that
        // large is past the last row anyway.
        const offset = typeof rawOffset === 'number' && Number.isFinite(rawOffset)
            ? Math.min(Math.max(Math.trunc(rawOffset), 0), Number.MAX_SAFE_INTEGER)
            : 0;
        const tiebreak = messageTimeOrder ? 'id' : this.orderTiebreak;
        // Match across dialects: a stored chatId may be `@s.whatsapp.net` (e.g. an outbound send addressed
        // by a raw engine id) while the caller filters by the neutral `@c.us` from the chat list - same
        // chat, different dialect. Resolving both sides through the table keeps them equal.
        const chatIds = chatId ? await this.resolveJidCandidates(chatId) : undefined;
        // SQLite has no planner statistics here (nothing runs ANALYZE), so with several chatId candidates
        // it prefers the (sessionId, createdAt) index because it already yields the order, and walks the
        // whole session filtering chatId row by row. The unary `+` takes createdAt out of index-order
        // consideration, so it seeks (sessionId, chatId, createdAt) and sorts only that chat's rows, the
        // plan ANALYZE would pick. A single candidate already uses that index in order, and PostgreSQL
        // (no unary `+` on timestamps) has statistics, so both keep the plain key.
        const orderColumn = messageTimeOrder ? 'timestamp' : 'createdAt';
        const orderKey = this.orderTiebreak === 'rowid' && chatIds !== undefined && chatIds.length > 1
            ? `+message.${orderColumn}`
            : `message.${orderColumn}`;
        const query = this.messageRepository
            .createQueryBuilder('message')
            .where('message.sessionId = :sessionId', { sessionId })
            .orderBy(orderKey, 'DESC')
            // Message times and bulk ingestion times can tie. The second key keeps pages stable;
            // legacy ingestion order retains its dialect-specific tiebreaker.
            .addOrderBy(`message.${tiebreak}`, 'DESC')
            .take(limit);
        // `after` replaces the offset rather than adding to it: mixing a row anchor with a count is
        // meaningless, and silently ignoring one of the two is friendlier to an SDK that always sends
        // `offset=0` than a 400 would be.
        if (after === undefined) {
            query.skip(offset);
        }
        // The filters a page's rows are read against again once its ids are picked (readPageSpendingBudget). Not the
        // whole query: that also carries the order, the page bounds and the cursor, which the picked ids encode.
        const rowFilters = [];
        const narrow = (clause, parameters) => {
            query.andWhere(clause, parameters);
            rowFilters.push([clause, parameters]);
        };
        if (chatIds) {
            narrow('message.chatId IN (:...chatIds)', { chatIds });
        }
        if (options.direction !== undefined) {
            narrow('message.direction = :direction', { direction: options.direction });
        }
        if (options.type !== undefined)
            narrow('message.type = :messageType', { messageType: options.type });
        if (from) {
            // Resolve the filter through the lid->phone table so a phone matches not just the stored
            // `<phone>@c.us` id but also any lid that resolves to the same person - turning the prior
            // silent miss (a lid-stored author vs a phone filter) into a hit.
            // A group message stores the real sender in `author` (`from` holds the group JID), so match
            // BOTH columns against the same candidate set or the filter skips every group message the
            // person wrote. Query plan: neither `from` nor `author` is indexed - the predicate applies
            // within the (sessionId, createdAt)-narrowed scan exactly as the from-only filter did, so the
            // OR costs nothing the old plan didn't already pay. No new index: per-session narrowing
            // dominates selectivity and a single btree cannot serve an OR across two columns anyway.
            const candidates = await this.resolveJidCandidates(from);
            // An API send stored by an earlier version names the account by its bare phone digits, so a filter on the
            // account's JID still matches those rows.
            const froms = [...new Set([...candidates, ...candidates.flatMap(bareUserDigits)])];
            narrow('(message.from IN (:...froms) OR message.author IN (:...authorFroms))', {
                froms,
                authorFroms: froms,
            });
        }
        if (options.messageId !== undefined) {
            narrow('message.waMessageId = :messageId', { messageId: options.messageId });
        }
        const hasTimeSelection = messageTimeOrder || options.since !== undefined || options.until !== undefined;
        // Unknown times cannot belong to a verified time window. Count the gap within the same
        // non-time filters, before applying time bounds, without loading message bodies.
        const unknownTimestampTotal = hasTimeSelection
            ? await query.clone().andWhere('message.timestamp IS NULL').getCount()
            : undefined;
        if (messageTimeOrder)
            narrow('message.timestamp IS NOT NULL');
        // Integer seconds preserve both boundaries with ceil; fractional bigint parameters fail on PostgreSQL.
        if (options.since !== undefined) {
            narrow('message.timestamp >= :since', { since: (0, message_window_1.messageTimeBoundarySeconds)(options.since) });
        }
        if (options.until !== undefined) {
            narrow('message.timestamp < :until', { until: (0, message_window_1.messageTimeBoundarySeconds)(options.until) });
        }
        // A budget of 0 means "never inline" and grants no single-payload allowance, which is exactly
        // what an opted-out caller asks for, so the flag picks the budget rather than a second code path.
        const inlineMediaBudget = inlineMedia === false ? 0 : resolveMessageListInlineMediaBudgetBytes();
        // `total` keeps its documented meaning, rows matching the filters, so count before narrowing.
        const total = await query.clone().getCount();
        if (after !== undefined) {
            // A selection cursor must name a row inside this same selection, not merely a row from the
            // session. Otherwise an unrelated time/direction/type could silently truncate a valid walk. A chat or
            // sender filter is left out: its candidate set can change between pages (a lid mapping learned or lost),
            // and the cursor is only a position in time, so a row stored under an alias must still anchor the walk.
            if ((messageTimeOrder ||
                options.since !== undefined ||
                options.until !== undefined ||
                options.direction !== undefined ||
                options.type !== undefined ||
                options.messageId !== undefined) &&
                !(await query.clone().andWhere('message.id = :cursorId', { cursorId: after }).getCount())) {
                throw new common_1.BadRequestException('Unknown cursor for this message selection');
            }
            // The anchor's sort key is resolved INSIDE the statement. Carrying it in the cursor instead
            // would mean round-tripping a timestamp through JSON, and neither dialect survives that:
            // SQLite holds two text shapes for one instant (`datetime('now')` writes 19 chars, a stamped
            // JS Date writes 23) and compares them as text, while node-postgres truncates the column's
            // microseconds to a millisecond Date. Both mis-seek silently, which is the very failure this
            // cursor exists to remove.
            query.andWhere(`(message.${orderColumn}, message.${tiebreak}) < ` +
                `(SELECT anchor."${orderColumn}", anchor."${tiebreak}" FROM messages anchor ` +
                'WHERE anchor."id" = :after AND anchor."sessionId" = :sessionId)', { after, sessionId });
        }
        // The page is picked by id only. Each row's metadata can hold a whole base64 payload, so the
        // rows themselves are read in bounded chunks below, sized from a second, id-keyed statement.
        // The size stays out of the ordered one: a sort evaluates its result columns for every matching
        // row, so a size there would be computed across the whole chat, not just this page.
        const pageIds = (await query.select('message.id', 'id').getRawMany()).map(r => r.id);
        const page = await this.readMetadataSizes(sessionId, pageIds);
        // An anchor that does not exist (or belongs to another session) makes the row comparison NULL,
        // which returns zero rows and reads exactly like the end of the history. Only pay for the
        // lookup on an empty page, and turn that silent truncation into a loud 400.
        if (after !== undefined &&
            page.length === 0 &&
            !(await this.messageRepository.exists({ where: { id: after, sessionId } }))) {
            throw new common_1.BadRequestException(`Unknown cursor '${after}' for this session`);
        }
        // The 1..100 clamp above bounds the ROW COUNT, not the response: each row carries its inline
        // base64 in metadata.media.data. Spent newest-first in the selected order, so the
        // most recently viewed media still arrives inline and the rest keeps its omitted marker.
        return {
            messages: await this.readPageSpendingBudget(sessionId, rowFilters, page, inlineMediaBudget),
            total,
            ...(unknownTimestampTotal !== undefined ? { unknownTimestampTotal } : {}),
        };
    }
    /**
     * The stored metadata size of each page row, in page order. OCTET_LENGTH, not LENGTH: both
     * SQLite and PostgreSQL answer it from the stored header, while a character count has to read
     * (and on PostgreSQL detoast) every payload in full, which the chunked read then does again.
     */
    async readMetadataSizes(sessionId, pageIds) {
        if (pageIds.length === 0)
            return [];
        const sizes = await this.messageRepository
            .createQueryBuilder('message')
            .select('message.id', 'id')
            .addSelect('OCTET_LENGTH(message.metadata)', 'metadataLength')
            .where('message.id IN (:...pageIds)', { pageIds })
            .andWhere(`${this.byPrimaryKey('message.sessionId')} = :sessionId`, { sessionId })
            .getRawMany();
        const sizeById = new Map(sizes.map(r => [r.id, r.metadataLength]));
        return pageIds.map(id => ({ id, metadataLength: sizeById.get(id) ?? null }));
    }
    /**
     * Load the rows of a page in its order, in chunks of at most `max(budget, 1 MiB)` stored metadata
     * bytes (at least one row per chunk), spending the inline media budget on each chunk before the
     * next is read. Loading the whole page at once put every payload on the heap before the budget
     * dropped most of them. The rows are re-read against the filters of the selection, so a row deleted or
     * replaced since the page was picked, and no longer matching, is left out.
     */
    async readPageSpendingBudget(sessionId, filters, page, budgetBytes) {
        const spend = createInlineMediaSpender(budgetBytes);
        const chunkLimit = Math.max(budgetBytes, MESSAGE_LIST_READ_CHUNK_MIN_BYTES);
        const messages = [];
        let chunk = [];
        let chunkBytes = 0;
        const flush = async () => {
            const query = this.messageRepository
                .createQueryBuilder('message')
                .select('message')
                .where(`${this.byPrimaryKey('message.sessionId')} = :sessionId`, { sessionId })
                .andWhere('message.id IN (:...chunkIds)', { chunkIds: chunk });
            for (const [clause, parameters] of filters)
                query.andWhere(this.byPrimaryKey(clause), parameters);
            const rows = await query.getMany();
            const byId = new Map(rows.map(row => [row.id, row]));
            for (const id of chunk) {
                const row = byId.get(id);
                if (!row)
                    continue;
                spend(row);
                messages.push(row);
            }
            chunk = [];
            chunkBytes = 0;
        };
        for (const { id, metadataLength } of page) {
            const bytes = Number(metadataLength) || 0;
            if (chunk.length > 0 && chunkBytes + bytes > chunkLimit)
                await flush();
            chunk.push(id);
            chunkBytes += bytes;
        }
        if (chunk.length > 0)
            await flush();
        return messages;
    }
    /**
     * Expand a user JID filter into every stored id that refers to the same person: the literal input
     * (so an exact lid filter still matches), the user-part in both user dialects (`@c.us` /
     * `@s.whatsapp.net`), and every lid the resolution table maps to that phone.
     *
     * Scoped by chat kind. For a non-user kind (group/status/newsletter/broadcast) the stored id can
     * only ever be the literal JID, so no candidates are generated: expanding a group or channel id's
     * digits into the user dialects (or probing the lid table with them) could mis-resolve the filter
     * onto an unrelated entity whose phone digits happen to match — fail closed on the literal id.
     * A `@lid` input forward-resolves to its phone instead of minting `<lid-digits>@c.us` (the lid's
     * digits are NOT a phone), so rows stored under the resolved form still match a raw-lid filter.
     */
    async resolveJidCandidates(value) {
        // Rules live in the shared helper (engine/identity/jid-candidates) so this filter and the
        // API-key chat scope cannot disagree about which ids refer to the same entity. The raw input is
        // kept as a candidate too: a row stored under a non-folded spelling must still match it.
        const expanded = await (0, jid_candidates_1.resolveJidCandidates)(value, {
            resolveLid: lid => this.lidMappingStore.findPhoneForLid(lid),
            lidsForPhone: phone => this.lidMappingStore.findLidsForPhone(phone),
        });
        return [...new Set([value, ...expanded])];
    }
    // ========== Phase 3: Reactions ==========
    async reactToMessage(sessionId, dto) {
        const engine = this.getEngine(sessionId);
        await engine.reactToMessage(dto.chatId, dto.messageId, dto.emoji);
    }
    async getMessageReactions(sessionId, chatId, messageId) {
        const engine = this.getEngine(sessionId);
        return engine.getMessageReactions(chatId, messageId);
    }
    /**
     * Read a message's media: the archived file when one exists, else the inline copy persisted on
     * the message row. The fallback is what makes media sent BY the account retrievable here — the
     * archive covers outbound media only when CHAT_MEDIA_ARCHIVE_OUTBOUND=true, but outbound rows
     * carry the payload inline: the REST send persists it, wwjs downloads it for the own-send echo, and
     * Baileys downloads it for phone-composed fromMe messages (the Baileys API-send echo alone carries
     * only a marker, which the REST-persisted copy covers) — #1165. It also serves an inbound message
     * whose archived file was purged by retention while the inline copy lives on.
     *
     * Unlike status media (only ever an image, a video or a voice note), chat media includes documents
     * a sender chose the type of — so the declared mimetype is echoed back only when it is inert, and the caller
     * serves the result as an attachment regardless. Both matter: an allow-list alone would still let
     * `image/svg+xml` through as active content on the API origin.
     */
    async getChatMedia(sessionId, chatId, messageId) {
        const chatIds = await this.resolveJidCandidates(chatId);
        const media = await this.chatMediaArchive?.getMedia(sessionId, chatIds, messageId);
        if (media && this.storageService) {
            try {
                // Streamed, not read whole: an archived video can be as large as CHAT_MEDIA_ARCHIVE_MAX_BYTES.
                // A missing or unreadable file rejects here, before anything is answered.
                const { stream, size } = await this.storageService.openFile(media.path);
                return { stream, size, mimetype: inertMimetype(media.mimetype) };
            }
            catch (error) {
                // The row outlived its file: the retention purge (or a concurrent delete) removed it
                // between the DB read and this read. Not a server fault — try the inline copy instead.
                if (!(0, storage_service_1.isMissingObjectError)(error)) {
                    throw error;
                }
            }
        }
        // Match across dialects like getMessages does: an outbound row stores the caller's literal
        // chatId (REST persist) or the engine-neutral form (own-send echo) depending on which writer
        // won the persist race, so a literal match would 404 on half the rows this fallback exists for.
        const row = await this.messageRepository.findOne({
            where: { sessionId, chatId: (0, typeorm_2.In)(chatIds), waMessageId: messageId },
        });
        const inline = row?.metadata?.media;
        if (
        // A revoked message's media is gone, even on a row cleared before revokes dropped it.
        row?.type === 'revoked' ||
            !inline ||
            inline.omitted ||
            typeof inline.data !== 'string' ||
            !inline.data ||
            typeof inline.mimetype !== 'string' ||
            !inline.mimetype ||
            // A URL-based send persists the URL STRING as `data` (buildMediaInput: `data: base64 ||
            // dto.url!`) — the bytes were fetched at send time and never stored. Decoding the URL as
            // base64 would serve garbage, so report it as absent. Same discriminator as the send path.
            /^https?:\/\//i.test(inline.data)) {
            throw new common_1.NotFoundException('No media stored for this message');
        }
        const bytes = Buffer.from(inline.data, 'base64');
        return { stream: stream_1.Readable.from([bytes]), size: bytes.length, mimetype: inertMimetype(inline.mimetype) };
    }
    /** Maximum messages a single getChatHistory call may request from the engine. */
    static MAX_CHAT_HISTORY_LIMIT = 100;
    /** Higher ceiling for opt-in deep history (`deep=true`). Bounded so a caller still can't ask unbounded. */
    static MAX_DEEP_CHAT_HISTORY_LIMIT = 2000;
    /**
     * Fetch chat history live from WhatsApp (bypasses local DB).
     * Returns the most recent `limit` messages for the given chat.
     * When `includeMedia` is true, downloads media (base64) for messages that have it.
     *
     * `limit` is clamped to [1, 100] (and falls back to 50 for non-finite input) so a caller cannot ask the
     * engine to fetch an unbounded number of messages. When `deep` is true the ceiling is raised to 2000
     * (for reaching weeks/months back on whatsapp-web.js, which can load earlier messages on demand) and
     * media is forced off — downloading base64 for up to 2000 messages would be an enormous, slow payload.
     *
     * An optional `signal` (HTTP client disconnect) is threaded to the engine, which checks it between
     * media downloads. Callers without cancellation keep the exact three-argument engine call shape.
     */
    async getChatHistory(sessionId, chatId, limit = 50, includeMedia = false, deep = false, signal) {
        const engine = this.getEngine(sessionId);
        const ceiling = deep ? MessageService_1.MAX_DEEP_CHAT_HISTORY_LIMIT : MessageService_1.MAX_CHAT_HISTORY_LIMIT;
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), ceiling) : 50;
        const media = deep ? false : includeMedia;
        return signal
            ? engine.getChatHistory(chatId, safeLimit, media, undefined, signal)
            : engine.getChatHistory(chatId, safeLimit, media);
    }
    // ========== Delete Message ==========
    /**
     * Pin a message for a bounded window. Nothing is persisted locally: a pin is chat state owned by
     * WhatsApp, not a property of our message row, and it expires on WhatsApp's clock — a mirrored
     * copy here would silently go stale.
     */
    async pinMessage(sessionId, dto) {
        const engine = this.getEngine(sessionId);
        await engine.pinMessage(dto.chatId, dto.messageId, dto.durationSeconds ?? exports.DEFAULT_PIN_DURATION_SECONDS);
        return { success: true };
    }
    async unpinMessage(sessionId, dto) {
        const engine = this.getEngine(sessionId);
        await engine.unpinMessage(dto.chatId, dto.messageId);
        return { success: true };
    }
    /**
     * Star or unstar a message. Like a pin, this is WhatsApp-owned state and is not mirrored locally
     * — but unlike a pin it is private to the account and never expires.
     *
     * Best-effort on whatsapp-web.js: its star/unstar resolve void and silently do nothing when
     * WhatsApp declines the message, so a 200 here means the instruction was delivered, not that the
     * star is definitely set.
     */
    async starMessage(sessionId, dto) {
        const engine = this.getEngine(sessionId);
        await engine.starMessage(dto.chatId, dto.messageId, dto.star);
        return { success: true };
    }
    /**
     * Cast a vote on a poll. Not supported on the Baileys engine, which surfaces as a 501 from the
     * adapter. `options` are option texts — see the engine interface for why there are no ids.
     */
    async votePoll(sessionId, dto) {
        const engine = this.getEngine(sessionId);
        await engine.votePoll(dto.chatId, dto.pollMessageId, dto.options);
        return { success: true };
    }
    async deleteMessage(sessionId, dto) {
        const engine = this.getEngine(sessionId);
        await engine.deleteMessage(dto.chatId, dto.messageId, dto.forEveryone ?? true);
        // Clear the stored message the same way an engine revoke does (body, media and metadata), on
        // its mutation chain. Best-effort: never rejects. No localized display string is persisted
        // here; the dashboard renders the localized "message deleted" text.
        await this.messageProjector.recordRevoke(sessionId, dto.messageId, { kind: 'revoke', chatId: dto.chatId });
    }
    // ========== Edit Message ==========
    async editMessage(sessionId, dto) {
        const engine = this.getEngine(sessionId);
        // An edit replaces the text the recipient sees, so it is content leaving the account and goes
        // through the same moderation chokepoint as every other sender. A plugin can rewrite `body`
        // here exactly as it can for a first send.
        const finalDto = await this.applySendingGate(sessionId, 'edit', dto);
        const result = finalDto.mentions?.length
            ? await engine.editMessage(finalDto.chatId, finalDto.messageId, finalDto.body, finalDto.mentions)
            : await engine.editMessage(finalDto.chatId, finalDto.messageId, finalDto.body);
        // Best-effort: reflect the new body in the stored copy (mirrors deleteMessage's revoked flag),
        // serialized with the inbound edit/reaction writers through the session's per-message mutation
        // queue. A missing row must not fail the request — the engine edit already succeeded.
        await this.messageProjector.recordOutboundMessageEdit(sessionId, finalDto.messageId, finalDto.body, {
            kind: 'edit',
            chatId: finalDto.chatId,
            fromMe: true,
        });
        return { messageId: result.id, timestamp: result.timestamp };
    }
    /**
     * Run the pre-send `message:sending` plugin gate for one outbound message and return the
     * (possibly plugin-modified) input, or throw BadRequestException if a plugin blocked the send.
     * On this query-side class the edit path is the one sender it gates; the text, media, and
     * extended senders pass through the twin method in MessageSendService. Both funnel into the
     * same core/hooks/sending-gate implementation (shared with StatusService too), so no outbound
     * sender skips moderation.
     */
    async applySendingGate(sessionId, type, input) {
        // Pacing runs BEFORE the plugin gate, so a send that policy forbids never reaches a plugin at
        // all — plugins should not be asked to moderate, or given the chance to rewrite, traffic that is
        // not going to be sent. The consequence is deliberate and documented in the hook contract: a
        // paced-out send fires no `message:sending`, so a plugin cannot observe it. Refusals are a 429
        // carrying `code: SEND_PACING_LIMITED`; a plugin veto stays a 400.
        // Every gated sender's DTO addresses its destination as `chatId` except forward, which uses
        // `toChatId` — without the fallback a forward skipped the cold-reachout gate entirely, while
        // its persisted row still drained the cold budget. Edit carries a chatId too; the edited
        // message's own row already makes that chat warm, so the cold rule is a no-op there. An edit
        // writes no row, so it is judged against the caps without being held as a new send.
        const target = input;
        await this.pacing.assertSendAllowed(sessionId, target.chatId ?? target.toChatId, { hold: false });
        return (0, hooks_1.applySendingGate)(this.hookManager, sessionId, type, input, 'MessageService');
    }
    getEngine(sessionId) {
        return this.engines.require(sessionId, () => new common_1.BadRequestException(`Session '${sessionId}' is not active. Start the session first.`));
    }
};
exports.MessageService = MessageService;
exports.MessageService = MessageService = MessageService_1 = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(message_entity_1.Message, 'data')),
    __param(7, (0, common_1.Optional)()),
    __param(8, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        engine_registry_service_1.EngineRegistry,
        message_projector_service_1.MessageProjector,
        hooks_1.HookManager,
        lid_mapping_store_service_1.LidMappingStoreService,
        send_pacing_service_1.SendPacingService,
        message_send_service_1.MessageSendService,
        chat_media_archive_service_1.ChatMediaArchiveService,
        storage_service_1.StorageService])
], MessageService);
