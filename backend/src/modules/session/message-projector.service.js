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
exports.MessageProjector = exports.PERSIST_RETRY_DELAY_MS = exports.ACK_RECONCILE_DELAY_MS = void 0;
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const session_entity_1 = require("./entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const keyed_mutation_queue_1 = require("../../common/utils/keyed-mutation-queue");
const shared_connection_1 = require("../../common/utils/shared-connection");
const session_write_scope_1 = require("../../common/utils/session-write-scope");
const session_lid_resolver_service_1 = require("./session-lid-resolver.service");
const message_row_mapper_1 = require("./message-row.mapper");
const message_mutation_projector_1 = require("./message-mutation-projector");
const message_mutation_guard_1 = require("./message-mutation-guard");
const message_metadata_1 = require("../message/message-metadata");
const message_history_projector_1 = require("./message-history-projector");
const db_errors_1 = require("../../common/utils/db-errors");
const feature_flags_1 = require("../../config/feature-flags");
const status_store_service_1 = require("../status-store/status-store.service");
const chat_media_archive_service_1 = require("../chat-media/chat-media-archive.service");
const automation_rules_service_1 = require("../automation/automation-rules.service");
const incoming_status_1 = require("../status-store/incoming-status");
const inbound_room_1 = require("./inbound-room");
const logger_service_1 = require("../../common/services/logger.service");
const events_gateway_1 = require("../events/events.gateway");
const webhook_service_1 = require("../webhook/webhook.service");
const hooks_1 = require("../../core/hooks");
const message_status_util_1 = require("../message/message-status.util");
const hook_results_1 = require("../../core/hooks/hook-results");
/**
 * Projects engine message events into the `messages` table and out to webhooks/WebSocket.
 *
 * This is the data path for messages: inbound arrivals, own-send echoes, delivery acks, revokes,
 * reactions, edits, and the pre-connection history backfill. It is deliberately separate from
 * SessionEngineLifecycle, which owns the session *lifecycle* (start/stop/delete/reconnect). The two
 * share
 * only the engine identity guard — a late event from a superseded engine must never mutate a
 * session that now belongs to a different one, or to none — which both read from EngineRegistry.
 *
 * Every entry point takes the captured `(sessionId, engine)` pair its engine callback closed over,
 * so those staleness checks behave exactly as they did while this code sat inline in
 * initializeEngine.
 */
/**
 * Delay before retrying an ack UPDATE that matched 0 rows. A fast delivered/read ack can arrive before
 * the send's 2nd save (which writes waMessageId) has committed, so the first UPDATE finds no row. One
 * retry after this delay closes that race; the forward-only transition guard keeps it idempotent.
 */
exports.ACK_RECONCILE_DELAY_MS = 750;
/**
 * Delay before the single retry of a message insert that failed transiently (lock contention, a
 * dropped connection, a pool timeout). The engine delivers each message once, so without the retry
 * one busy moment loses the row for good.
 */
exports.PERSIST_RETRY_DELAY_MS = 300;
/** How many of its messages marked edited a session remembers as marked (see markedEdited). */
const EDITED_MARKS_KEPT_PER_SESSION = 500;
const quoteOf = (m) => ({ chatId: m.chatId, body: m.body });
/** A deleted message as hooks and consumers see it: nothing of its content survives, as in REVOKED_ROW_PATCH. */
const deletedPlaceholder = (message) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { media, quotedMessage, call, buttons, button, location, order, product, poll, mentionedIds, ...kept } = message;
    return { ...kept, body: '', type: 'revoked' };
};
/** Where a message lives and who wrote it: what a change aimed at it is held to (see mutationTargetsForeignRow). */
const refOf = (m) => ({
    chatId: m.chatId,
    direction: m.fromMe ? message_entity_1.MessageDirection.OUTGOING : message_entity_1.MessageDirection.INCOMING,
    author: m.author,
});
/** What a delivery claims to be, as the rule that refuses a change aimed at a stored row reads it. */
const claimOf = (m) => ({
    kind: 'edit',
    chatId: m.chatId,
    fromMe: m.fromMe,
    author: m.author,
});
/**
 * A message admitted on arrival (PostgreSQL only): its place in the chat's hook and commit order, its
 * claim on the session's room when it downloads media, and its in-flight entry, so a change that
 * targets it before its emit is kept for its row.
 */
class InboundTurn {
    engine;
    entry;
    room;
    s;
    state = 'pending';
    /** The commit to run in the chat's turn, or null when the message will not be emitted. */
    outcome = (0, inbound_room_1.deferred)();
    emitted = (0, inbound_room_1.deferred)();
    /** Resolved once every earlier message of the chat was emitted or dropped: the hook may start. */
    hookGate = (0, inbound_room_1.deferred)();
    preparing;
    constructor(engine, entry, room, s) {
        this.engine = engine;
        this.entry = entry;
        this.room = room;
        this.s = s;
    }
    get revoked() {
        return this.entry.revoked === true;
    }
    /** A cross-form repeat inherits changes only once its directory comparison has finished. */
    prepareIdentity(pending) {
        this.preparing = Promise.race([pending, this.outcome.promise.then(() => undefined)]);
    }
    // A message revoked before its download needs none: its row is stored cleared.
    reserve() {
        if (!this.s || !this.room || this.state === 'dropped')
            return false;
        if (this.preparing) {
            const preparing = this.preparing;
            return preparing.then(() => {
                if (this.preparing === preparing)
                    this.preparing = undefined;
                return this.reserve();
            });
        }
        if (this.entry.revoked)
            return this.giveUp();
        return this.s.granted || this.room.wait(this.s).then(granted => granted && !this.entry.revoked);
    }
    /** Leave the room's queue, if still in it: once admitted, the claim passes the slot straight on. */
    giveUp() {
        if (this.s && !this.s.granted) {
            this.s.abandoned = true;
            this.s.grant.resolve(false);
        }
        return false;
    }
    holdUntil(p) {
        this.s?.holds.push(p.catch(() => undefined));
    }
    emit(job) {
        if (this.state !== 'pending')
            return;
        this.state = 'emitted';
        this.emitted.resolve();
        this.outcome.resolve(job);
    }
    drop() {
        if (this.state !== 'pending')
            return;
        this.state = 'dropped';
        this.outcome.resolve(null);
        this.emitted.resolve();
        this.giveUp();
    }
}
let MessageProjector = class MessageProjector {
    messageRepository;
    sessionRepository;
    engines;
    eventsGateway;
    webhookService;
    hookManager;
    statusStore;
    lidResolver;
    configService;
    chatMediaArchive;
    automationRules;
    lidMappingStore;
    logger = (0, logger_service_1.createLogger)('MessageProjector');
    // Serializes stored-message mutations per `${sessionId}:${waMessageId}`. Reactions perform a
    // read-modify-write and rapid edits must remain latest-write-wins; sharing one chain also preserves
    // order when different mutation kinds for the same message arrive together.
    messageMutations = new keyed_mutation_queue_1.KeyedMutationQueue((key, err) => {
        // Both current mutation implementations contain their own contextual error handling. Keep a
        // final guard here so a future implementation cannot leak a rejected fire-and-forget promise
        // or permanently block the message's later mutations.
        this.logger.error(`Unexpected failure applying message mutation: ${key}`, String(err));
    });
    // Serializes the insert and dispatch of each chat's messages, by `${sessionId}:${chatId}`: hook
    // chains finish in any order, but a chat's rows, websocket events and webhooks follow arrival.
    chatCommits = new keyed_mutation_queue_1.KeyedMutationQueue((key, err) => {
        this.logger.error(`Unexpected failure committing a message: ${key}`, String(err));
    });
    // PostgreSQL only: a chat's `message:received` / `message:sent` chains start in arrival order, each
    // once every earlier admitted message of the chat was emitted or dropped (see admitInbound).
    chatEmits = new keyed_mutation_queue_1.KeyedMutationQueue((key, err) => {
        this.logger.error(`Unexpected failure ordering a message: ${key}`, String(err));
    });
    // Per session, not per engine: a replaced engine's payloads still waiting for their rows keep
    // counting, so a reconnect cannot multiply the room.
    rooms = new Map();
    // Admitted messages not yet committed, by session, so retiring an engine can release its own.
    tickets = new Map();
    // Messages not yet written, by `${sessionId}:${waMessageId}`: inbound ones from the start of their
    // `message:received` chain, own-send echoes from the start of their `message:sent` chain, each until
    // its commit (which may wait behind earlier messages of the chat) ends. A handler that quotes the
    // message reads it from here, and a revoke, edit or ack landing meanwhile finds no row to update: it
    // is recorded here and applied once the row is written (see applyChangesMadeInFlight).
    // On PostgreSQL the entry exists from the message's arrival (admitInbound), before its emit.
    inboundInFlight = new Map();
    // Ids whose row was marked edited, by session, while it has an engine: an own message delivered again loses its
    // insert to that row, and is announced with the mark without reading it (see commitOwnSendEcho). Never stored; past
    // EDITED_MARKS_KEPT_PER_SESSION the oldest is forgotten, and a repeat of it goes out unmarked.
    markedEdited = new Map();
    // Reaction/edit applies, extracted to a plain collaborator. It shares this instance's
    // messageMutations queue, so the public enqueue path and the queued applies serialize on one chain.
    mutationProjector;
    constructor(messageRepository, sessionRepository, engines, eventsGateway, webhookService, hookManager, statusStore, lidResolver, configService, chatMediaArchive, automationRules, lidMappingStore) {
        this.messageRepository = messageRepository;
        this.sessionRepository = sessionRepository;
        this.engines = engines;
        this.eventsGateway = eventsGateway;
        this.webhookService = webhookService;
        this.hookManager = hookManager;
        this.statusStore = statusStore;
        this.lidResolver = lidResolver;
        this.configService = configService;
        this.chatMediaArchive = chatMediaArchive;
        this.automationRules = automationRules;
        this.lidMappingStore = lidMappingStore;
        this.mutationProjector = new message_mutation_projector_1.MessageMutationProjector(this.messageRepository, this.eventsGateway, this.webhookService, this.messageMutations, this.logger, (sessionId, waMessageId) => this.noteMarkedEdited(sessionId, waMessageId), this.lidMappingStore ? jid => this.lidMappingStore.findPhoneForLid(jid) : undefined, (sessionId, waMessageId) => this.announceChangedRow(sessionId, waMessageId));
        this.engines.onRetire((id, engine) => {
            for (const t of this.tickets.get(id) ?? [])
                if (t.engine === engine)
                    t.drop();
            this.deleteRoomIfIdle(id);
            if (!this.engines.has(id))
                this.markedEdited.delete(id);
        });
    }
    noteMarkedEdited(sessionId, waMessageId) {
        let marks = this.markedEdited.get(sessionId);
        if (!marks)
            this.markedEdited.set(sessionId, (marks = new Set()));
        marks.add(waMessageId);
        if (marks.size > EDITED_MARKS_KEPT_PER_SESSION)
            marks.delete(marks.values().next().value);
    }
    /**
     * Whether the engines hold each inbound message from its arrival until its row is written. Only
     * PostgreSQL needs it: a downloaded payload waits in memory for its asynchronous insert, while
     * better-sqlite3 writes synchronously, so the backlog drains within the arrival's own task.
     */
    get holdsInbound() {
        return this.messageRepository.manager?.connection?.options?.type === 'postgres';
    }
    /**
     * Admit a message as it arrives (see EngineEventCallbacks.admitInbound), synchronously, in arrival
     * order. The engine passes the ticket to its emit or drops it. Each admitted message of a chat
     * starts its hook chain and is committed in this order, and changes that target it before its emit
     * are recorded on its in-flight entry. One that downloads media asks the session's room for a slot
     * now, granted in arrival order and held until its row is written.
     */
    admitInbound(id, engine, a) {
        if (!this.engines.isLive(id, engine))
            return undefined;
        const key = a.status || !a.id ? null : `${id}:${a.id}`;
        let entry = {};
        if (key) {
            entry = this.inboundInFlight.get(key) ?? entry;
            this.inboundInFlight.set(key, entry);
            // From the arrival, so a change that reaches the message while it downloads media is held to the rule
            // of the row it will become. Only when the engine says whose message it is: a guessed direction
            // would refuse the account's own change.
            if (a.fromMe !== undefined)
                entry.ref ??= refOf({ chatId: a.chatId, fromMe: a.fromMe, author: a.author });
        }
        entry.holders = (entry.holders ?? 0) + 1;
        const room = a.needsRoom ? this.room(id) : undefined;
        const source = { kind: 'edit', chatId: a.chatId, fromMe: a.fromMe, author: a.author };
        const separate = entry.ref && (0, message_mutation_guard_1.mutationTargetsForeignRow)(entry.ref, source) !== null;
        const scoped = separate
            ? { ref: a.fromMe === undefined ? undefined : refOf({ chatId: a.chatId, fromMe: a.fromMe, author: a.author }) }
            : entry;
        const t = new InboundTurn(engine, scoped, room, room && (0, inbound_room_1.roomState)());
        let set = this.tickets.get(id);
        if (!set)
            this.tickets.set(id, (set = new Set()));
        set.add(t);
        const finish = () => {
            if (entry.holders)
                entry.holders--;
            if (key && !entry.holders && this.inboundInFlight.get(key) === entry)
                this.inboundInFlight.delete(key);
            set.delete(t);
            if (!set.size && this.tickets.get(id) === set)
                this.tickets.delete(id);
            t.s?.done.resolve();
        };
        if (a.status) {
            void t.outcome.promise.then(finish);
        }
        else {
            const chatKey = `${id}:${a.chatId}`;
            this.chatEmits.enqueue(chatKey, () => {
                t.hookGate.resolve();
                return t.emitted.promise;
            });
            this.chatCommits.enqueue(chatKey, async () => {
                try {
                    const job = await t.outcome.promise;
                    if (job)
                        await job();
                }
                finally {
                    finish();
                }
            });
        }
        if (room && t.s) {
            void room.request(t.s).then(() => {
                if (!this.engines.has(id))
                    this.deleteRoomIfIdle(id);
            });
        }
        if (key && separate && this.lidMappingStore) {
            const pending = this.changeInFlight(id, a.id, source, (needsRow, shared) => {
                if (!this.engines.isLive(id, engine) || t.state === 'dropped')
                    return;
                if (shared && !needsRow) {
                    t.entry = shared;
                    if (shared.revoked)
                        t.giveUp();
                }
            });
            // A revoke queued during the directory read must reach the ticket before its download starts.
            if (pending)
                t.prepareIdentity(pending.then(() => this.waitForInFlightChanges(id, a.id)));
        }
        return t;
    }
    room(id) {
        let room = this.rooms.get(id);
        if (!room)
            this.rooms.set(id, (room = new inbound_room_1.InboundRoom()));
        return room;
    }
    deleteRoomIfIdle(id) {
        if (this.rooms.get(id)?.idle)
            this.rooms.delete(id);
    }
    /**
     * Engine callback body, lifted out of initializeEngine so the wiring table stays readable. With a
     * ticket (PostgreSQL), the hook chain starts in the chat's arrival order and the commit takes the
     * turn admitInbound reserved; whatever path returns early drops the ticket. The receipt, for an
     * engine that wants to know what became of its message, settles once the commit ends (see
     * {@link InboundOutcome}). There is none when the engine is no longer live or the message is skipped as
     * ephemeral; one that settles with nothing says nothing, as when the hook chain failed.
     */
    handleInboundMessage(id, engine, message, ticket) {
        const turn = ticket instanceof InboundTurn ? ticket : undefined;
        try {
            return this.receiveInbound(id, engine, message, turn);
        }
        finally {
            turn?.drop();
        }
    }
    receiveInbound(id, engine, message, turn) {
        if (!this.engines.isLive(id, engine))
            return;
        if (message.isStatusBroadcast) {
            const ingest = this.ingestInboundStatus(id, engine, message);
            // The status store holds the payload until the ingest settles.
            turn?.holdUntil(ingest);
            // Its own table takes the status whatever the id, and a story is never a row of `messages`: one
            // that finds a message there under its id reuses that id. Only an engine that keeps its own copy of
            // a message reads the outcome, so the lookup is made when it is asked for, and once.
            let judged;
            const judge = () => ingest.then(() => this.judgeRepeat(id, message));
            return {
                get settled() {
                    return (judged ??= judge());
                },
            };
        }
        if (this.shouldSkipEphemeralMessage(id, message))
            return;
        this.logger.debug(`Message received from ${message.from}`, {
            sessionId: id,
            messageId: message.id,
            from: message.from,
            action: 'message_received',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
        // Convert IncomingMessage to plain object for dispatch. One delivered deleted reaches the hooks with no content,
        // whatever text the engine handed over with it.
        const messageData = message.type === 'revoked' ? deletedPlaceholder(message) : { ...message };
        // What an engine says of the edit it applied is for the session alone: no hook, row or consumer sees it.
        delete messageData.originalBody;
        // Tracks what the chain's current copy lends a quote, so one taken mid-chain carries an earlier
        // handler's rewrite.
        const inFlightKey = `${id}:${message.id}`;
        const inFlight = turn
            ? Object.assign(turn.entry, { ref: turn.entry.ref ?? refOf(messageData) })
            : this.trackInFlight(inFlightKey, messageData);
        const delivery = {
            entry: inFlight,
            body: message.originalBody ?? message.body,
            edited: message.originalBody !== undefined,
        };
        const quoteOwner = {};
        const onFailure = (err) => {
            this.logger.error(`onMessage handler failed for ${id}`, String(err));
            return null;
        };
        // Execute hook for message received - plugins can modify or stop processing. The hook chain and
        // sender resolution run concurrently across messages; the catch is attached now so a failure
        // while the commit waits its turn is never an unhandled rejection.
        const prepared = this.startHookChain(id, engine, turn, messageData, delivery, quoteOwner, messageData => this.hookManager
            .execute('message:received', messageData, {
            sessionId: id,
            source: 'Engine',
            accept: data => {
                if (!(0, hook_results_1.isMessagePayload)(data))
                    return false;
                if (delivery.entry.quoteOwner === quoteOwner)
                    delivery.entry.quote = quoteOf(data);
                return true;
            },
        })
            .then(({ data }) => this.prepareInboundMessage(id, this.messageOrEngineCopy(id, 'message:received', data, messageData)))).catch(onFailure);
        const outcome = (0, inbound_room_1.deferred)();
        this.commitInTurn(id, message, turn, async () => {
            try {
                const finalMessage = await prepared;
                if (finalMessage)
                    outcome.resolve(await this.commitInboundMessage(id, engine, finalMessage, delivery.entry));
            }
            catch (err) {
                onFailure(err);
            }
            finally {
                outcome.resolve(undefined); // no effect once settled above
                this.clearQuote(delivery.entry, quoteOwner);
                if (!turn)
                    this.untrackInFlight(inFlightKey, inFlight);
            }
        });
        return { settled: outcome.promise };
    }
    /**
     * Start a message's hook chain: at once without a turn. With one, once every earlier admitted
     * message of the chat was emitted or dropped, so hooks start in arrival order. A message revoked
     * before then skips its hooks, as its content is gone, and an edit made before then reaches them.
     * A delivery of content checks for a stored tombstone before either hook; one that came deleted
     * reaches them cleared. An unavailable database keeps the delivery, as the storage path does.
     */
    startHookChain(id, engine, turn, messageData, delivery, quoteOwner, run) {
        const checked = async () => {
            let data = messageData;
            if (data.id && data.type !== 'revoked') {
                try {
                    const connection = this.messageRepository.manager?.connection;
                    if (connection && !(await (0, shared_connection_1.awaitNoOpenTransaction)(connection))) {
                        throw new Error('Timed out waiting for the message database transaction');
                    }
                    // The unique message key bounds this read. A tombstone outlives this projector and any engine copy.
                    const row = await this.messageRepository.findOne({
                        where: { sessionId: id, waMessageId: data.id, type: 'revoked' },
                        select: { type: true, chatId: true, direction: true, author: true },
                    });
                    if (row?.type === 'revoked' &&
                        !(await (0, message_mutation_guard_1.mutationTargetsForeignRowPersisted)(row, claimOf(data), this.lidMappingStore ? jid => this.lidMappingStore.findPhoneForLid(jid) : undefined))) {
                        data = deletedPlaceholder(data);
                    }
                }
                catch (error) {
                    // Preserve the receive path's fail-open behavior when storage is unavailable.
                    this.logger.warn('Failed to read the stored message before its hooks; keeping the delivery', {
                        sessionId: id,
                        messageId: data.id,
                        error: String(error),
                    });
                }
            }
            if (!this.engines.isLive(id, engine))
                return null;
            let result = null;
            const preparing = this.changeInFlight(id, data.id, claimOf(data), (needsRow, pending) => {
                if (!this.engines.isLive(id, engine))
                    return;
                // A reused id from another identity keeps its own scalar changes, never the first delivery's.
                delivery.entry = pending && !needsRow ? pending : { ref: refOf(data) };
                this.arrive(delivery.entry, delivery);
                const skipHooks = turn && delivery.entry.revoked && messageData.type !== 'revoked';
                if (data.type === 'revoked')
                    this.holdRevoked(id, delivery.entry);
                if (pending && !needsRow) {
                    if (pending.revoked)
                        data = deletedPlaceholder(data);
                    else if (pending.editedBody !== undefined)
                        data.body = pending.editedBody;
                    if (skipHooks) {
                        result = Promise.resolve(data);
                        return;
                    }
                    pending.quote = quoteOf(data);
                    pending.quoteOwner = quoteOwner;
                }
                // Start the hook in this preparation turn, but never make preparation wait for the hook.
                result = run(data);
            });
            if (preparing)
                await preparing;
            return result;
        };
        if (!turn)
            return checked();
        return turn.hookGate.promise.then(async () => {
            await this.waitForInFlightChanges(id, messageData.id);
            if (!this.engines.isLive(id, engine))
                return null;
            return checked();
        });
    }
    /** Queue a message's commit on its chat, or hand it to the turn admitInbound already queued. */
    commitInTurn(id, message, turn, job) {
        if (turn)
            turn.emit(job);
        else
            this.chatCommits.enqueue(this.chatCommitKey(id, message), job);
    }
    /** Record a message as not yet written; a re-fire of the same id keeps the changes recorded so far. */
    trackInFlight(key, message) {
        // A message whose id the engine could not read is registered under no key: the empty id would be shared by
        // every such message, and a revoke or ack that names no message would reach all of them.
        if (!message.id)
            return { ref: refOf(message) };
        const inFlight = this.inboundInFlight.get(key) ?? {
            // The first delivery of an id says whose message it is: a repeat sent from another chat must not
            // take that over from it, or a change aimed through the repeat would be judged by the wrong rule.
            ref: refOf(message),
        };
        // Repeats can commit through different chat spellings, so none may forget the others' changes.
        // A new entry lends no unchecked quote; a repeat keeps only the previous checked quote.
        inFlight.holders = (inFlight.holders ?? 0) + 1;
        this.inboundInFlight.set(key, inFlight);
        return inFlight;
    }
    /**
     * The engine handed the message over: an edit held until now is compared with the text it arrived with. One the
     * engine applied itself changed that text, though a later one may have restored it (it names the arrival text only
     * then, so it can equal the body), and marks the row the same way.
     */
    arrive(entry, arrival) {
        entry.body = arrival.body;
        if (arrival.edited || (entry.editedBody !== undefined && entry.editedBody !== entry.body)) {
            entry.edited = true;
        }
    }
    /** Keep an edit for the row of a message not written yet. One that repeats the text so far changes nothing. */
    holdEdit(entry, body) {
        const soFar = entry.editedBody ?? entry.body;
        if (soFar !== undefined && body !== soFar)
            entry.edited = true;
        entry.editedBody = body;
    }
    /** Drop the entry once every delivery sharing it has committed. */
    untrackInFlight(key, inFlight) {
        if (inFlight.holders)
            inFlight.holders--;
        if (!inFlight.holders && this.inboundInFlight.get(key) === inFlight)
            this.inboundInFlight.delete(key);
    }
    clearQuote(entry, owner) {
        if (entry.quoteOwner !== owner)
            return;
        delete entry.quote;
        delete entry.quoteOwner;
    }
    /**
     * Key of the per-chat commit queue. A slow hook chain for one message must not let a later message
     * of the same chat be stored and announced first, so the insert and dispatch of every message in a
     * chat (inbound and own-send echo alike) run in arrival order. Keyed on the engine's chatId, not
     * on a hook's rewrite.
     */
    chatCommitKey(id, message) {
        return `${id}:${message.chatId}`;
    }
    /**
     * The inbound message a `message:received` chain is carrying, as the chain last rewrote it, from the
     * moment the chain starts until the message's row is written; undefined otherwise. The row does not
     * exist while the chain runs, so a handler that replies to the message finds nothing to quote in the
     * table.
     */
    inFlightInbound(sessionId, waMessageId) {
        const entry = waMessageId ? this.inboundInFlight.get(`${sessionId}:${waMessageId}`) : undefined;
        // Admitted but not emitted yet: nobody can have heard of it, so it has nothing to lend.
        if (!entry?.quote)
            return undefined;
        // A revoked message lends no text, as its cleared row would not; the chatId still scopes the quote.
        return entry.revoked ? { chatId: entry.quote.chatId, body: '' } : entry.quote;
    }
    /**
     * The message a `message:received` / `message:sent` hook chain handed back, or a fresh copy of the
     * engine's message when it is not one: null, a primitive, or an object without the `id` and `chatId`
     * every row and dispatch keys on. HookManager already skips such a result per handler
     * ({@link isMessagePayload}), keeping an earlier handler's rewrite; this is the last guard. A plugin
     * returning `data: null` to mean "I consumed it" used to throw below and erase the message from
     * history, webhooks and the websocket. A plugin may rewrite a message; it cannot make the gateway
     * forget it (see {@link prepareInboundMessage}).
     */
    messageOrEngineCopy(id, event, data, message) {
        const candidate = data;
        if ((0, hook_results_1.isMessagePayload)(candidate)) {
            return candidate;
        }
        this.logger.warn(`A ${event} hook returned a payload that is not a message; using the engine's copy`, {
            sessionId: id,
            messageId: message.id,
            received: candidate === null ? 'null' : typeof candidate,
            action: 'hook_message_discarded',
        });
        const copy = { ...message };
        delete copy.originalBody;
        return copy;
    }
    /** `isStatusBroadcast` arm of {@link handleInboundMessage}: ingest into the status store, not the message pipeline. */
    ingestInboundStatus(id, engine, message) {
        // Status/Story posts arrive via the inbound path for some engines; ingest them into the
        // status store instead of the message pipeline. Mirrors the isStatusBroadcast guard in
        // onMessageCreate below: an own-send echo (fromMe) stays a plain drop — never ingested,
        // never dispatched — so a status you posted never re-appears in your own webhooks/API as
        // if a contact had posted it.
        if (message.fromMe)
            return Promise.resolve();
        const status = (0, incoming_status_1.buildIncomingStatus)(message);
        if (!status)
            return Promise.resolve();
        return (this.statusStore
            .ingest(id, status)
            // Dispatch only on a fresh insert: ingest also resolves with the pre-existing row
            // for a duplicate delivery (or the winner's row after a lost insert race), and the
            // webhook must fire once per status, not once per (re)delivery.
            .then(({ row, created }) => {
            // The ingest awaited; a stop()/delete() can retire this engine mid-flight — don't
            // dispatch for a session that no longer exists (mirrors message.received's re-check).
            if (!this.engines.isLive(id, engine))
                return;
            // One that expired while the ingest ran (a slow media write) is gone from every read: announcing it
            // would point a consumer at a status the API no longer serves.
            if (created && row.expiresAt > Date.now())
                this.dispatchStatusReceived(id, row);
        })
            .catch(err => this.logger.warn('Status ingest failed', {
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
        })));
    }
    /** Operator opt-out gate for disappearing messages: true when the message must be skipped entirely. */
    shouldSkipEphemeralMessage(id, message) {
        // Ephemeral/disappearing messages: skip persist + dispatch when the operator opted out.
        // A message is ephemeral when its chat has a disappearing-messages timer (ephemeralDuration > 0).
        if (!(0, feature_flags_1.resolveFeatureFlags)(this.configService).storeEphemeralMessages &&
            message.ephemeralDuration &&
            message.ephemeralDuration > 0) {
            this.logger.debug('Skipping ephemeral message', {
                sessionId: id,
                messageId: message.id,
                chatId: message.chatId,
                ephemeralDuration: message.ephemeralDuration,
            });
            return true;
        }
        return false;
    }
    /** Post-hook continuation of {@link handleInboundMessage} that may run concurrently: resolve the sender. */
    async prepareInboundMessage(id, finalMessage) {
        // `continue: false` is deliberately NOT read here. It means "stop the handler chain", which
        // HookManager has already done — the plugins after the one that returned it never ran. It
        // does not mean "this message never happened".
        //
        // Honouring it here used to skip everything below: the message was never written to the
        // messages table, never dispatched to webhooks, and never emitted over the websocket. An
        // auto-reply plugin returning `false` for its ordinary purpose — keeping other bots from
        // answering the same message — silently erased the customer's message from the operator's
        // own history, leaving a thread of bot replies answering nothing. Nothing in the hook
        // contract (`HookResult.continue`, docs/19) or the webhook contract (`message.received`
        // fires when "an inbound message arrives", docs/06) hinted at that, and a sandboxed
        // marketplace plugin could swallow a session's entire inbound traffic with no audit trail.
        //
        // The message has already arrived at WhatsApp. A plugin can stop other plugins from acting
        // on it; it cannot make the gateway forget it. Pre-action hooks are where a veto belongs —
        // `message:sending` blocks a send that has not happened yet (core/hooks/sending-gate.ts).
        // Persist the incoming message so the dashboard chats view can render history.
        const incoming = finalMessage;
        // Inline @lid -> phone resolution (#263), opt-in via RESOLVE_LID_TO_PHONE. Best-effort:
        // attaches senderPhone (digits or null) before persist/dispatch so webhook/ws consumers
        // get it in a single pass. Only for privacy-id senders, so no lookup for normal numbers.
        if ((0, feature_flags_1.resolveFeatureFlags)(this.configService).resolveLidToPhone && incoming.isLidSender && !incoming.fromMe) {
            incoming.senderPhone = await this.lidResolver.resolveSenderPhone(id, incoming.author ?? incoming.from);
        }
        return finalMessage;
    }
    /** Per-chat, in-order stage of {@link handleInboundMessage}: persist, then dispatch. */
    async commitInboundMessage(id, engine, finalMessage, entry) {
        const outcome = await this.persistInboundMessage(id, engine, finalMessage, entry);
        if (outcome === 'repeat')
            return this.judgeRepeat(id, finalMessage);
        if (outcome)
            this.dispatchInboundMessage(id, finalMessage, outcome, entry);
        return undefined;
    }
    /**
     * Whether a message the insert refused as a repeat is another message than the one holding its id.
     * A re-fire of the same message is not, but an id reused from another chat, another side of the
     * conversation or another author of a group is: the engine is told, so its copy under that id does
     * not stand in for the stored message. Judged by the rule that refuses a change aimed at the row, so
     * what that rule would refuse to edit is not this message. A row that cannot be read, or that does
     * not prove a difference, says nothing and the engine keeps its copy.
     */
    async judgeRepeat(id, message) {
        const reason = await this.mutationProjector.foreignRowReason(id, (0, message_row_mapper_1.storableWaMessageId)(message.id) ?? '', claimOf(message));
        if (!reason)
            return undefined;
        this.logger.warn('Dropping a message that reuses the id of a different stored message', {
            sessionId: id,
            messageId: message.id,
            reason,
            action: 'message_id_reused',
        });
        return { conflict: true };
    }
    /**
     * Build the inbound row and insert it under the UNIQUE dedup oracle. Returns the row plus whether
     * the insert landed, 'repeat' when the id already has a row (an engine re-fire, or another message
     * under the same id), or null when the pipeline must stop (stale engine).
     */
    async persistInboundMessage(id, engine, incoming, entry) {
        const metadata = (0, message_row_mapper_1.buildMessageMetadata)(incoming);
        const chatName = incoming.contact?.pushName ?? incoming.contact?.name ?? undefined;
        const dbMessage = this.messageRepository.create({
            sessionId: id,
            waMessageId: (0, message_row_mapper_1.storableWaMessageId)(incoming.id),
            chatId: incoming.chatId,
            chatName,
            // Group poster (participant JID) — `from` is the group JID, so this is the stable
            // sender identity the chat view keys attribution runs/colors on. Undefined for 1:1.
            author: incoming.author,
            from: incoming.from,
            to: incoming.to,
            body: incoming.body,
            type: incoming.type,
            direction: incoming.fromMe ? message_entity_1.MessageDirection.OUTGOING : message_entity_1.MessageDirection.INCOMING,
            timestamp: incoming.timestamp,
            status: message_entity_1.MessageStatus.SENT,
            metadata,
        });
        // The hook chain above is async; a delete()/teardown can retire this engine while it
        // awaits. Re-check liveness so a late continuation can't persist an orphan messages row
        // (the row has no FK, so a session-delete cleanup would never reap it) or dispatch for a
        // session that no longer exists. Mirrors the synchronous isLiveEngine gate at entry.
        await this.waitForInFlightChanges(id, incoming.id);
        if (!this.engines.isLive(id, engine))
            return null;
        const insertedCleared = this.applyHeldChanges(dbMessage, entry);
        // De-duplicate at the source: the engine can re-fire `message` for one inbound message
        // (#464). UNIQUE(sessionId, waMessageId) makes the insert the atomic dedup oracle — a
        // near-simultaneous re-fire loses the race and is skipped here, so persist + webhook + WS
        // happen exactly once. Fail-open: a non-conflict DB error still dispatches, so a real
        // message is never dropped by a transient DB failure.
        const outcome = await this.insertWithRetry(id, engine, dbMessage, 'incoming');
        await this.waitForInFlightChanges(id, incoming.id);
        if (!this.engines.isLive(id, engine))
            return null;
        if (outcome.landed === 'yes') {
            this.applyChangesMadeInFlight(id, incoming.id, entry, insertedCleared);
            return { dbMessage, persisted: true };
        }
        if (outcome.landed === 'stale')
            return null;
        // A duplicate on the first attempt is a re-fire: the original already persisted and dispatched.
        // A duplicate on the retry is ambiguous: the first attempt may have committed before its error,
        // in which case nothing dispatched yet, so dispatch fail-open (without the row-bound hook), and
        // that row still has to take a revoke or edit that arrived in flight.
        if (outcome.landed === 'dup' && outcome.retried) {
            this.applyChangesMadeInFlight(id, incoming.id, entry, false, claimOf(incoming));
        }
        // A delivery that came deleted clears the row it lost to, as a revoke does, once the row proves to be the message.
        if (outcome.landed === 'dup' && incoming.type === 'revoked') {
            void this.recordRevoke(id, incoming.id, claimOf(incoming));
        }
        if (outcome.landed === 'dup' && !outcome.retried)
            return 'repeat';
        return { dbMessage, persisted: false };
    }
    /**
     * A revoke or edit can arrive while a message waits for its hook or insert: write
     * the row as the change leaves it, so `message:persisted` and the media archive never see content
     * that was taken back. A change landing during the insert is still applied after it. A message
     * delivered deleted is written cleared on either database, as the history sync stores one, and takes
     * no edit. Returns whether the row is written cleared.
     */
    applyHeldChanges(dbMessage, entry) {
        if (dbMessage.type === 'revoked') {
            Object.assign(dbMessage, message_row_mapper_1.REVOKED_ROW_PATCH);
            return true;
        }
        if (entry?.revoked)
            Object.assign(dbMessage, message_row_mapper_1.REVOKED_ROW_PATCH);
        else {
            if (entry?.editedBody !== undefined)
                dbMessage.body = entry.editedBody;
            if (entry?.edited)
                dbMessage.metadata = { ...dbMessage.metadata, edited: true };
        }
        return entry?.revoked === true;
    }
    /**
     * Insert a message row under the UNIQUE(sessionId, waMessageId) dedup oracle. `insert()` (not
     * `save()`) is load-bearing: a duplicate insert throws, which is the atomic dedup oracle for #464
     * re-fires. A transient failure is retried once after {@link PERSIST_RETRY_DELAY_MS}, re-checking
     * that the engine is still live so a retired session never gets an orphan row. On success the
     * DB-generated columns are merged onto `dbMessage`.
     */
    async insertWithRetry(id, engine, dbMessage, direction) {
        const label = `Failed to save ${direction} message ${dbMessage.waMessageId} to database`;
        const insert = async () => {
            // Registered with the session's write scope, so a delete drains an insert already under way before it
            // removes the session's rows; the row has no foreign key to refuse one that lands afterwards.
            const writes = (0, session_write_scope_1.captureSessionWrites)(this.messageRepository.manager?.connection ?? this.messageRepository, id);
            const result = await writes
                .write(() => this.messageRepository.insert(dbMessage))
                .finally(() => writes.close());
            // `insert()` (not `save()`) does NOT merge DB-generated columns (@PrimaryGeneratedColumn,
            // @CreateDateColumn) back onto the entity instance — so merge them explicitly here, before
            // the `message:persisted` emit. `identifiers[0]` always carries the PK on both SQLite and
            // Postgres; `generatedMaps[0]` adds createdAt where the driver returns it (Postgres yes;
            // SQLite historically does not — acceptable; the PK is the load-bearing field for plugins).
            Object.assign(dbMessage, result.identifiers[0] ?? {}, result.generatedMaps?.[0] ?? {});
            return { landed: 'yes' };
        };
        try {
            return await insert();
        }
        catch (err) {
            if ((0, db_errors_1.isUniqueViolation)(err))
                return { landed: 'dup', retried: false };
            if (!(0, db_errors_1.isTransientDbError)(err)) {
                this.logger.error(label, String(err));
                return { landed: 'failed' };
            }
            this.logger.warn(`${label}, retrying once`, { sessionId: id, error: String(err) });
        }
        await new Promise(resolve => setTimeout(resolve, exports.PERSIST_RETRY_DELAY_MS));
        if (!this.engines.isLive(id, engine))
            return { landed: 'stale' };
        try {
            return await insert();
        }
        catch (err) {
            if ((0, db_errors_1.isUniqueViolation)(err))
                return { landed: 'dup', retried: true };
            this.logger.error(label, String(err));
            return { landed: 'failed' };
        }
    }
    /**
     * Write a revoke, edit, reaction or ack that arrived before the message's row existed onto the row
     * just inserted: its own write matched no row then. Queued on the message's mutation chain, so it
     * lands after any edit already queued, and a revoke wins over the rest. A change arriving after the
     * insert finds the row itself. Reactions are only stored here; their event already went out. A row
     * inserted cleared is cleared again, in case a change raced the insert, without announcing it:
     * `message:persisted` already carried it cleared. Where the insert lost, a pending revoke announces the
     * row it clears, which an earlier revoke may have cleared and announced already, and a revoke event still
     * waiting for its own row read when the insert lands announces it once more: a consumer may see the
     * cleared row more than once under the same id.
     *
     * `lostInsert`, set when the delivery's insert lost to a row under the id, says what the delivery claims
     * to be. That row may be the message itself (its first attempt committed before the error) or another
     * message's (an id reused from another chat): the changes go to it only if it is the message. The
     * judgement is the first step of the slot taken on the chain here, not a read ahead of it, so a change
     * of the message that arrives while the row is read queues behind the write instead of being
     * overwritten by it.
     */
    applyChangesMadeInFlight(id, waMessageId, pending, insertedCleared = false, lostInsert) {
        const { ackStatus } = pending;
        const rowChanges = Boolean(pending.revoked || pending.editedBody !== undefined || pending.edited || pending.reactions);
        if (!ackStatus && !rowChanges)
            return;
        const advance = () => {
            if (!ackStatus)
                return;
            void this.advanceAck(id, waMessageId, ackStatus).catch(err => this.logger.error(`Failed to advance ack for ${waMessageId}`, String(err)));
        };
        if (!lostInsert) {
            advance();
            if (rowChanges) {
                this.enqueueMessageMutation(id, waMessageId, () => this.writeChangesMadeInFlight(id, waMessageId, pending, insertedCleared));
            }
            return;
        }
        this.enqueueMessageMutation(id, waMessageId, async () => {
            const reason = await this.mutationProjector.foreignRowReason(id, waMessageId, lostInsert);
            if (reason) {
                this.logger.warn('Not applying the changes of a message to the stored message that holds its id', {
                    sessionId: id,
                    messageId: waMessageId,
                    reason,
                });
                return;
            }
            advance();
            await this.writeChangesMadeInFlight(id, waMessageId, pending, insertedCleared);
        });
    }
    /** The row part of {@link applyChangesMadeInFlight}. Must run on the mutation chain. */
    async writeChangesMadeInFlight(id, waMessageId, pending, insertedCleared) {
        if (pending.revoked)
            return this.revokeRow(id, waMessageId, !insertedCleared);
        try {
            // Never onto a revoked row, as the edit paths: a message delivered deleted, or deleted before it, stays cleared.
            // Compared in the write: a row inserted with the edit already applied is not changed again here.
            let textChanged = false;
            if (pending.editedBody !== undefined) {
                const result = await this.messageRepository.update({ sessionId: id, waMessageId, type: (0, typeorm_2.Not)('revoked'), body: (0, typeorm_2.Or)((0, typeorm_2.Not)(pending.editedBody), (0, typeorm_2.IsNull)()) }, { body: pending.editedBody });
                textChanged = Boolean(result?.affected);
            }
            if (pending.reactions)
                await this.storeReactions(id, waMessageId, pending.reactions);
            // The marker an edit of a stored row leaves, written last so a lost metadata race costs it alone.
            if (pending.edited)
                await this.mutationProjector.markMessageEdited(id, waMessageId);
            if (textChanged)
                await this.announceChangedRow(id, waMessageId);
        }
        catch (err) {
            this.logger.error(`Failed to apply changes to message ${waMessageId}`, String(err));
        }
    }
    /**
     * Hand a stored row whose text an edit changed to `message:persisted` again, as {@link revokeRow} does for a
     * cleared one, so a plugin keeping a copy keyed by the row id follows the edit. Re-read, so the payload carries
     * the edited marker. Never rejects.
     */
    async announceChangedRow(sessionId, waMessageId) {
        try {
            const row = await this.messageRepository.findOne({ where: { sessionId, waMessageId } });
            if (!row)
                return;
            void this.hookManager
                .execute('message:persisted', { sessionId, message: row }, { sessionId, source: 'SessionService' })
                .catch(() => undefined);
        }
        catch (err) {
            this.logger.warn('Failed to read an edited message for message:persisted', {
                sessionId,
                messageId: waMessageId,
                error: String(err),
            });
        }
    }
    /** Merge reactions into the row's metadata, withdrawing a sender's on ''. Must run on the mutation chain. */
    async storeReactions(id, waMessageId, changes) {
        await (0, message_metadata_1.updateMessageMetadata)(this.messageRepository, { sessionId: id, waMessageId }, metadata => {
            const reactions = { ...metadata.reactions };
            for (const [sender, reaction] of Object.entries(changes)) {
                if (reaction)
                    reactions[sender] = reaction;
                else
                    delete reactions[sender];
            }
            return { ...metadata, reactions };
        });
    }
    /**
     * Clear a revoked message's stored row, on the message's mutation chain so a reaction or edit queued
     * before it cannot write content back afterwards. Used by the engine's revoke event, by the REST
     * delete, and by a delivery that came deleted and lost its insert. Best-effort like every stored-message
     * mutation: never rejects, and resolves once the write has run.
     *
     * With `source`, the caller has not had the stored row judge the revoke yet: the message still arriving
     * is taken back only if the revoke agrees with it, and the row is cleared only if the revoke is not
     * foreign to it. Without one, the revoke was judged by the caller (the engine's revoke event is).
     */
    recordRevoke(sessionId, waMessageId, source, announced = false) {
        let stored;
        const pending = this.changeInFlight(sessionId, waMessageId, source, (needsRow, entry) => {
            if (entry && !needsRow) {
                this.holdRevoked(sessionId, entry);
                if (announced)
                    entry.revokeAnnounced = true;
            }
            stored = new Promise(resolve => this.enqueueMessageMutation(sessionId, waMessageId, () => this.revokeRow(sessionId, waMessageId, true, source).finally(resolve)));
        });
        return Promise.resolve(pending).then(() => stored);
    }
    /** Take back a message not written yet: its row is stored cleared, and media waiting for room needs none. */
    holdRevoked(sessionId, entry) {
        entry.revoked = true;
        for (const t of this.tickets.get(sessionId) ?? [])
            if (t.entry === entry)
                t.giveUp();
    }
    /**
     * Apply {@link REVOKED_ROW_PATCH}, then hand the cleared row to `message:persisted` so a plugin index
     * keyed by row id drops the content too. Must run on the message's mutation chain. The row is the
     * table's one under the id, which another chat's message may hold: a `source` that the row proves
     * foreign leaves it alone.
     */
    async revokeRow(sessionId, waMessageId, notify = true, source) {
        // An undefined condition is DROPPED from the where-clause, which would clear every row of the session.
        if (!waMessageId)
            return;
        try {
            const reason = source && (await this.mutationProjector.foreignRowReason(sessionId, waMessageId, source));
            if (reason) {
                this.logger.warn('Dropping a revoke aimed at a message of another chat or sender', {
                    sessionId,
                    messageId: waMessageId,
                    reason,
                });
                return;
            }
            const result = await this.messageRepository.update({ sessionId, waMessageId }, message_row_mapper_1.REVOKED_ROW_PATCH);
            this.markedEdited.get(sessionId)?.delete(waMessageId);
            if (!result?.affected || !notify)
                return;
            const row = await this.messageRepository.findOne({ where: { sessionId, waMessageId } });
            if (!row)
                return;
            void this.hookManager
                .execute('message:persisted', { sessionId, message: row }, { sessionId, source: 'SessionService' })
                .catch(() => undefined);
        }
        catch (err) {
            this.logger.error(`Failed to clear revoked message ${waMessageId}`, String(err));
        }
    }
    /** Fan an accepted inbound message out: `message:persisted` plugin hook, webhook, websocket emit. */
    dispatchInboundMessage(id, finalMessage, outcome, entry) {
        const { dbMessage, persisted } = outcome;
        // Fire-and-forget: a plugin handler must never break the receive path. Both engine adapters
        // (wwjs `message` and Baileys `upsert`) converge on this persist, so one emit covers inbound.
        // The built-in FTS search provider is DB-synced and does NOT consume this; it exists for
        // plugin providers (Spec 2) + general use.
        // Gate ONLY the hook on `persisted`: on a non-unique insert error (transient SQLITE_BUSY /
        // lock-timeout / connection drop) the row was never stored and `dbMessage.id` is undefined,
        // so emitting `message:persisted` would hand plugins an id-less payload for a row that isn't
        // in the DB. The webhook/WS dispatch below stays fail-open — a real inbound message must
        // never be dropped on a transient DB failure; only the hook requires a durable row.
        if (persisted) {
            void this.hookManager
                .execute('message:persisted', { sessionId: id, message: dbMessage }, { sessionId: id, source: 'SessionService' })
                .catch(() => undefined);
            // Fire-and-forget for the same reason as the hook above: the receive path must not wait on
            // storage. Gated on `persisted` because the archive updates the row by id, and on a failed
            // insert there is no row to point at the file. A no-op unless archiving is enabled.
            void this.chatMediaArchive?.archive(dbMessage).catch(() => undefined);
        }
        const announced = this.withChangesMadeInFlight(finalMessage, entry);
        if (!announced)
            return;
        // Dispatch to webhooks with potentially modified message
        void this.webhookService.dispatch(id, 'message.received', announced);
        // Autoreply rules ride the same at-most-once dispatch (the insert oracle above dedupes engine
        // re-fires) and stay fail-open like the webhook: a broken rule must never break the receive path.
        void this.automationRules?.evaluateInbound(id, announced).catch(() => undefined);
        // Emit real-time event to WebSocket clients
        this.eventsGateway.emitMessage(id, announced);
    }
    /**
     * The message as a revoke or edit that arrived while it was in flight left it, for its announcement:
     * null once the engine revoked it (message.revoked already went out, so the deleted content is not
     * announced after it), the revoked placeholder when only the REST delete did (a delete-for-me emits no
     * engine revoke, and the message still exists for its sender) or when it was delivered deleted, the edited
     * body when edited (message.edited already went out with it), plus `edited: true` when the row is marked
     * for it or already was (`rowMarked`): a consumer that held no copy of the message could not apply that
     * event. The stored row takes the same changes in {@link applyChangesMadeInFlight}. One delivered deleted
     * is stored cleared and takes no edit ({@link applyHeldChanges}), and clears the row it lost its insert to
     * when that row is the message.
     */
    withChangesMadeInFlight(message, pending, rowMarked = false) {
        if (pending?.revokeAnnounced)
            return null;
        // No edit held for it, and no mark.
        if (pending?.revoked || message.type === 'revoked')
            return deletedPlaceholder(message);
        const edited = rowMarked || pending?.edited;
        // An edit the engine applied before the hand-over is in the body already.
        if (pending?.editedBody === undefined)
            return edited ? { ...message, edited: true } : message;
        return { ...message, body: pending.editedBody, ...(edited ? { edited: true } : {}) };
    }
    /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
    handleOwnSendEcho(id, engine, message, ticket) {
        const turn = ticket instanceof InboundTurn ? ticket : undefined;
        try {
            this.receiveOwnSendEcho(id, engine, message, turn);
        }
        finally {
            turn?.drop();
        }
    }
    /** {@link handleOwnSendEcho} with the ticket resolved; every early return leaves the ticket to be dropped. */
    receiveOwnSendEcho(id, engine, message, turn) {
        if (!this.engines.isLive(id, engine))
            return;
        // `message_create` fires for every message the account creates, including sends composed on a
        // linked phone — which the `message`/`onMessage` event never delivers. Incoming messages are
        // already handled by `onMessage`, so only outgoing (`fromMe`) ones produce `message.sent` here.
        if (!message.fromMe) {
            return;
        }
        // Status/Story posts are account-created but not real conversations; don't emit `message.sent`
        // for them. The adapter flags these (the engine-specific pseudo-JID stays out of this layer).
        if (message.isStatusBroadcast) {
            return;
        }
        this.logger.debug(`Message sent to ${message.to}`, {
            sessionId: id,
            messageId: message.id,
            to: message.to,
            action: 'message_sent',
        });
        // Update last active timestamp
        void this.sessionRepository.update(id, { lastActiveAt: new Date() }).catch(() => undefined);
        // As on the inbound path, one delivered deleted reaches the hooks with no content.
        const messageData = message.type === 'revoked' ? deletedPlaceholder(message) : { ...message };
        delete messageData.originalBody;
        const onFailure = (err) => {
            this.logger.error(`onMessageCreate handler failed for ${id}`, String(err));
            return null;
        };
        // The commit may wait behind a slow earlier message of the chat; a revoke, edit or ack of this
        // send landing meanwhile is recorded here and applied once the row is written. Like the inbound
        // path, the entry follows the chain's rewrites, so a quote carries what the row will hold.
        const inFlightKey = `${id}:${message.id}`;
        const inFlight = turn
            ? Object.assign(turn.entry, { ref: turn.entry.ref ?? refOf(messageData) })
            : this.trackInFlight(inFlightKey, messageData);
        const delivery = {
            entry: inFlight,
            body: message.originalBody ?? message.body,
            edited: message.originalBody !== undefined,
        };
        const quoteOwner = {};
        // Execute hook for message sent - plugins can modify or stop processing. Like the inbound path,
        // the hook chain runs concurrently and the commit waits its turn on the chat's queue.
        const prepared = this.startHookChain(id, engine, turn, messageData, delivery, quoteOwner, messageData => this.hookManager
            .execute('message:sent', messageData, {
            sessionId: id,
            source: 'Engine',
            accept: data => {
                if (!(0, hook_results_1.isMessagePayload)(data))
                    return false;
                if (delivery.entry.quoteOwner === quoteOwner)
                    delivery.entry.quote = quoteOf(data);
                return true;
            },
        })
            .then(({ data }) => this.messageOrEngineCopy(id, 'message:sent', data, messageData))).catch(onFailure);
        this.commitInTurn(id, message, turn, async () => {
            try {
                const finalMessage = await prepared;
                if (finalMessage)
                    await this.commitOwnSendEcho(id, engine, finalMessage, delivery.entry);
            }
            catch (err) {
                onFailure(err);
            }
            finally {
                this.clearQuote(delivery.entry, quoteOwner);
                if (!turn)
                    this.untrackInFlight(inFlightKey, inFlight);
            }
        });
    }
    /** Per-chat, in-order stage of {@link handleOwnSendEcho}: persist, then dispatch `message.sent`. */
    async commitOwnSendEcho(id, engine, finalMessage, entry) {
        // `continue: false` is not read here, for the same reason as the message:received path
        // above: the send has already happened, so a plugin can stop the handler chain but cannot
        // un-send it. Skipping the persist below dropped the operator's own outgoing message from
        // history and from `message.sent` webhooks.
        // Persist the outgoing message so local history reflects sends composed on a linked phone
        // (message_create is the ONLY event those produce). It also fires for API-originated sends,
        // which the REST send path persists itself; the UNIQUE(sessionId, waMessageId) index is
        // the atomic dedup oracle between the two writers: the loser skips its insert, and
        // persistSentState additionally drops its redundant PENDING row when the echo won. The
        // webhook/WS dispatch below is identical whether the insert won, lost, or failed: the
        // message.sent contract is unchanged.
        await this.waitForInFlightChanges(id, finalMessage.id);
        if (!this.engines.isLive(id, engine))
            return;
        const outgoing = finalMessage;
        const metadata = (0, message_row_mapper_1.buildMessageMetadata)(outgoing, true);
        // The ephemeral opt-out gates STORAGE only (mirrors onMessage); the live dispatch below
        // is today's contract and stays.
        const mayPersist = (0, feature_flags_1.resolveFeatureFlags)(this.configService).storeEphemeralMessages ||
            !(outgoing.ephemeralDuration && outgoing.ephemeralDuration > 0);
        let rowMarked = false;
        if (mayPersist) {
            const dbMessage = this.messageRepository.create({
                sessionId: id,
                waMessageId: (0, message_row_mapper_1.storableWaMessageId)(outgoing.id),
                chatId: outgoing.chatId,
                from: outgoing.from,
                to: outgoing.to,
                body: outgoing.body,
                type: outgoing.type,
                direction: message_entity_1.MessageDirection.OUTGOING,
                timestamp: outgoing.timestamp,
                status: message_entity_1.MessageStatus.SENT,
                metadata,
            });
            // The hook chain above is async; a delete()/teardown can retire this engine while it
            // awaits. Re-check liveness so a late continuation can't persist an orphan row
            // (mirrors onMessage).
            if (!this.engines.isLive(id, engine))
                return;
            const insertedCleared = this.applyHeldChanges(dbMessage, entry);
            // A unique violation means the REST send path already persisted this API-originated
            // send: the dedup oracle working as intended, not an error. Any other failure (after the
            // one transient retry) fails open, so a real send is never dropped on a DB fault.
            const outcome = await this.insertWithRetry(id, engine, dbMessage, 'outgoing');
            await this.waitForInFlightChanges(id, outgoing.id);
            if (!this.engines.isLive(id, engine))
                return;
            if (outcome.landed === 'stale')
                return;
            // The REST writer may have won either attempt; its row still takes the echo's pending changes.
            if (outcome.landed === 'dup') {
                this.applyChangesMadeInFlight(id, outgoing.id, entry, false, claimOf(outgoing));
                // A delivery that came deleted clears that row, as a revoke does, once the row proves to be the message.
                if (outgoing.type === 'revoked')
                    void this.recordRevoke(id, outgoing.id, claimOf(outgoing));
                // That row may be older than this delivery and edited since, the edit still being written: announced once the
                // changes queued for the message have run, with the mark they left.
                rowMarked = await new Promise(resolve => this.enqueueMessageMutation(id, outgoing.id, async () => {
                    const marked = this.markedEdited.get(id)?.has(outgoing.id) === true;
                    const foreign = marked && (await this.mutationProjector.foreignRowReason(id, outgoing.id, claimOf(outgoing)));
                    resolve(marked && !foreign);
                }));
            }
            if (outcome.landed === 'yes') {
                // The id had no row, so a mark remembered for it was of a row removed since.
                this.markedEdited.get(id)?.delete(outgoing.id);
                this.applyChangesMadeInFlight(id, outgoing.id, entry, insertedCleared);
                // Fire-and-forget, mirroring onMessage: plugin providers (search etc.) see phone-
                // composed sends exactly like API sends.
                void this.hookManager
                    .execute('message:persisted', { sessionId: id, message: dbMessage }, { sessionId: id, source: 'SessionService' })
                    .catch(() => undefined);
                // Archive this send's media, mirroring onMessage. This is the ONLY path a phone-composed
                // send takes, so the REST-side chokepoint would never see it. Opt-in twice over
                // (CHAT_MEDIA_ARCHIVE_ENABLED + _OUTBOUND) and a no-op otherwise; archive() itself
                // refuses a row that is already archived, so the REST writer racing us costs at most one
                // duplicate file write, which archive() deletes because the first pointer wins.
                if (this.configService?.get('chatMedia.archiveOutbound', false) === true) {
                    void this.chatMediaArchive?.archive(dbMessage).catch(() => undefined);
                }
            }
        }
        if (!this.engines.isLive(id, engine))
            return;
        const sent = this.withChangesMadeInFlight(finalMessage, entry, rowMarked);
        if (!sent)
            return;
        void this.webhookService.dispatch(id, 'message.sent', sent);
        // Emit real-time event to WebSocket clients (as message.sent, not message.received)
        this.eventsGateway.emitMessageSent(id, sent);
    }
    /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
    handleMessageAck(id, engine, messageId, status, chatId) {
        if (!this.engines.isLive(id, engine))
            return;
        this.logger.debug(`Message ack: ${messageId} -> ${status}`, {
            sessionId: id,
            messageId,
            status,
            action: 'message_ack',
        });
        // Reflect real delivery state on the stored message (#220): delivered/read/failed advance the
        // stored status; pending/sent carry no upgrade (it's already SENT — visibly "not delivered").
        // The UPDATE is guarded to the allowed prior statuses so delivery state only ADVANCES: an
        // out-of-order/late ack cannot downgrade a higher status, which also makes these
        // fire-and-forget writes race-safe at the DB level.
        const messageStatus = (0, message_status_util_1.deliveryStatusToMessageStatus)(status);
        const inFlight = this.inboundInFlight.get(`${id}:${messageId}`);
        // Baileys relays a peer's receipt under the peer's chat with every id it lists, unchecked, so a receipt that
        // names a chat is held to the message it names before it changes or announces anything. An id that embeds its
        // chat, as whatsapp-web.js serializes them, cannot name another chat's message.
        const receiptChat = chatId && !messageId.includes('@') ? chatId : undefined;
        if (receiptChat && inFlight?.ref && (0, message_mutation_guard_1.receiptTargetsForeignRow)(inFlight.ref, receiptChat)) {
            this.logForeignReceipt(id, messageId, receiptChat);
            return;
        }
        if (messageStatus) {
            // A message not written yet (its commit waits behind an earlier one of the chat) keeps the
            // furthest ack for when its row lands; the UPDATEs below would match nothing.
            if (inFlight && (!inFlight.ackStatus || (0, message_status_util_1.ackStatusTransitionFrom)(messageStatus).includes(inFlight.ackStatus))) {
                inFlight.ackStatus = messageStatus;
            }
        }
        const logNoop = () => this.logger.debug(`Message ack ${messageId}: no status row advanced to ${messageStatus} (${status})`, {
            sessionId: id,
            messageId,
            status,
            action: 'message_ack_noop',
        });
        const onAckError = (err) => this.logger.error(`Failed to advance ack for ${messageId}`, String(err));
        const advance = (first, retry = first) => first()
            .then(affected => {
            if (affected > 0)
                return;
            // affected:0 — most likely the send's 2nd save (which writes waMessageId) hasn't committed
            // yet, so the row isn't matchable. Each ack is one-shot (WhatsApp won't necessarily resend),
            // so retry ONCE after a short delay to close that race rather than leave it stuck at SENT.
            const timer = setTimeout(() => {
                void retry()
                    .then(retried => {
                    if (retried === 0)
                        logNoop();
                })
                    .catch(onAckError);
            }, exports.ACK_RECONCILE_DELAY_MS);
            timer.unref?.();
        })
            .catch(onAckError);
        // One ack payload, emitted identically over the socket and the webhook so a client coded
        // against either channel sees the same shape. `id` mirrors the field every other message.*
        // event carries (and the idempotency-key resolver reads). `ack` is a deprecated legacy field
        // kept for backward compatibility — new consumers should read the neutral `status`. `chatId`
        // rides along when the engine's update names the chat, so a webhook `chatId` condition scopes
        // ack and failure events to that chat instead of suppressing them outright.
        const ackPayload = {
            id: messageId,
            messageId,
            status,
            ack: (0, message_status_util_1.deliveryStatusToAck)(status),
            ...(chatId ? { chatId } : {}),
        };
        const announce = () => {
            // Push the live delivery/read tick to the dashboard over the websocket.
            this.eventsGateway.emitMessageAck(id, ackPayload);
            // Dispatch the delivery/read receipt to webhooks (#155). Outgoing `message.sent` is handled
            // solely by `onMessageCreate`, so the ack path deliberately does NOT emit `message.sent`.
            void this.webhookService.dispatch(id, 'message.ack', ackPayload);
            // Surface delivery failures actively so consumers don't have to poll for them (#220). Use a
            // distinct object (not the shared ackPayload) so this separate event can't be perturbed by an
            // in-place payload mutation in the concurrent message.ack dispatch's webhook:before hook.
            if (status === 'failed') {
                void this.webhookService.dispatch(id, 'message.failed', { ...ackPayload });
            }
            // Notify plugins of the delivery/read receipt. The `message:ack` hook event was declared in
            // the HookEvent union but never emitted, so any plugin registered for it silently never fired.
            // Fire-and-forget: an ack is a notification with nothing downstream to cancel, so the hook's
            // `continue` flag is moot. Delivery failures surface here as status `failed` — `message:failed`
            // stays reserved for send-time send failures, which carry a distinct `{ error, input }` payload.
            void this.hookManager.execute('message:ack', { messageId, status, ack: (0, message_status_util_1.deliveryStatusToAck)(status) }, { sessionId: id, source: 'Engine' });
        };
        if (!receiptChat) {
            if (messageStatus)
                void advance(() => this.advanceAck(id, messageId, messageStatus));
            announce();
            return;
        }
        this.enqueueMessageMutation(id, messageId, async () => {
            const verdict = await this.receiptVerdict(id, messageId, receiptChat);
            if (verdict === 'foreign' || !this.engines.isLive(id, engine))
                return;
            announce();
            if (!messageStatus)
                return;
            const target = messageStatus;
            // A row the verdict did not see is only advanced by the retry, which judges it again once it is written.
            const judged = async () => (await this.receiptVerdict(id, messageId, receiptChat)) === 'stored'
                ? this.advanceAck(id, messageId, target)
                : 0;
            await advance(verdict === 'stored' ? () => this.advanceAck(id, messageId, target) : () => Promise.resolve(0), judged);
        });
    }
    /**
     * What the stored row says of a receipt naming `chatId`: absent, the row it may advance, or a row of another chat.
     * Never rejects: a row that cannot be read reads as absent, so the receipt goes out and its retry judges again.
     */
    async receiptVerdict(id, messageId, chatId) {
        try {
            const row = await this.messageRepository.findOne({
                where: { sessionId: id, waMessageId: messageId },
                select: { chatId: true, direction: true, author: true },
            });
            if (!row)
                return 'absent';
            const foreign = await (0, message_mutation_guard_1.receiptTargetsForeignRowPersisted)(row, chatId, this.lidMappingStore ? jid => this.lidMappingStore.findPhoneForLid(jid) : undefined);
            if (!foreign)
                return 'stored';
            this.logForeignReceipt(id, messageId, chatId);
            return 'foreign';
        }
        catch {
            return 'absent';
        }
    }
    logForeignReceipt(id, messageId, chatId) {
        this.logger.warn('Dropping a receipt that names a message of another chat', {
            sessionId: id,
            messageId,
            chatId,
            action: 'message_ack_foreign_chat',
        });
    }
    /**
     * Engine callback body for one recipient's receipt (Baileys group and status messages). Nothing is
     * stored: the event is forwarded as is, over the socket and the webhook with the same shape. `id`
     * mirrors the other message.* events (and is what the idempotency-key resolver reads); `chatId` lets
     * webhook chatId filters scope it.
     */
    handleMessageReceipt(id, engine, event) {
        if (!this.engines.isLive(id, engine))
            return;
        const payload = {
            id: event.messageId,
            messageId: event.messageId,
            chatId: event.chatId,
            participant: event.participant,
            status: event.status,
            timestamp: event.timestamp,
        };
        this.eventsGateway.emitMessageReceipt(id, payload);
        void this.webhookService.dispatch(id, 'message.receipt', payload);
    }
    /**
     * Advance a stored message's delivery status, returning the rows changed. Scoped by sessionId:
     * waMessageId is unique per account/chat, not global, so an ack on one session must never advance a
     * same-id row in another session. The In() guard makes the UPDATE forward-only (a late/out-of-order
     * ack can't downgrade) and idempotent on retry.
     */
    advanceAck(id, messageId, messageStatus) {
        return this.messageRepository
            .update({ sessionId: id, waMessageId: messageId, status: (0, typeorm_2.In)((0, message_status_util_1.ackStatusTransitionFrom)(messageStatus)) }, { status: messageStatus })
            .then(result => result.affected ?? 0);
    }
    /** Engine callback body, lifted out of initializeEngine so the wiring table stays readable. */
    handleMessageRevoked(id, engine, message, actor) {
        if (!this.engines.isLive(id, engine))
            return;
        this.logger.debug(`Message revoked: ${message.id}`, {
            sessionId: id,
            messageId: message.id,
            action: 'message_revoked',
        });
        // Clear the stored message (best-effort; the message may not be in the DB). The
        // dashboard renders the localized "message deleted" text, so no display string is
        // persisted here.
        //
        // Match on `revokedId` (the ORIGINAL deleted message's id) when present: on wwebjs
        // `message.id` is the revocation notification, which never matches a stored row.
        // `revokedId` falls back to `id` (Baileys, where the two are the same).
        const revokedWaMessageId = message.revokedId ?? message.id;
        const source = actor ? { kind: 'revoke', chatId: message.chatId, fromMe: actor.fromMe } : undefined;
        const apply = () => {
            void this.recordRevoke(id, revokedWaMessageId, source, true);
            // Notify consumers regardless of whether the row existed: webhook (message.revoked
            // is a declared event) + the real-time dashboard stream.
            const revokedPayload = message;
            void this.webhookService.dispatch(id, 'message.revoked', revokedPayload);
            this.eventsGateway.emitMessageRevoked(id, revokedPayload);
        };
        // whatsapp-web.js reports only what WhatsApp Web itself accepted, so it passes no actor and is applied at
        // once: its ids name the chat, so no row of another chat can hold the id. An engine that applies no
        // validation to a revoke says who made it, and the stored row says whose message it names: a revoke the
        // row proves foreign is dropped, announcement included.
        if (!source) {
            apply();
            return;
        }
        void this.changeInFlight(id, revokedWaMessageId, source, (needsRow, inFlight) => {
            if (inFlight && !needsRow) {
                this.holdRevoked(id, inFlight);
                inFlight.revokeAnnounced = true;
            }
            void this.mutationProjector.storedRowVerdict(id, revokedWaMessageId, source).then(verdict => {
                if (!this.engines.isLive(id, engine))
                    return;
                if (verdict.reason || (needsRow && !verdict.exists)) {
                    if (verdict.reason) {
                        this.logger.warn('Dropping a revoke aimed at a message of another chat or sender', {
                            sessionId: id,
                            messageId: revokedWaMessageId,
                            reason: verdict.reason,
                        });
                    }
                    return;
                }
                apply();
            });
        });
    }
    /** History backfill persist, extracted to message-history-projector.ts (stateless function). */
    persistHistoryMessages(id, engine, messages) {
        return (0, message_history_projector_1.persistHistoryMessages)(this.messageRepository, this.configService, id, messages, this.logger, () => this.engines.isLive(id, engine), row => {
            if (!this.engines.isLive(id, engine))
                return;
            void this.hookManager
                .execute('message:persisted', { sessionId: id, message: row }, { sessionId: id, source: 'SessionService' })
                .catch(() => undefined);
        }, this.lidMappingStore ? jid => this.lidMappingStore.findPhoneForLid(jid) : undefined);
    }
    /** Reaction apply, queued on the per-message mutation chain — see MessageMutationProjector. */
    applyReactionQueued(id, event) {
        void this.changeInFlight(id, event.messageId, { kind: 'reaction', chatId: event.chatId }, (needsRow, entry) => {
            if (entry && !needsRow)
                (entry.reactions ??= {})[event.senderId] = event.reaction ?? '';
            this.mutationProjector.applyReactionQueued(id, event, needsRow);
        });
    }
    /** Edit apply, queued on the per-message mutation chain. */
    applyMessageEditQueued(id, message) {
        const source = { kind: 'edit', chatId: message.chatId, fromMe: message.fromMe, author: message.author };
        void this.changeInFlight(id, message.messageId, source, (needsRow, entry) => {
            if (entry && !needsRow)
                this.holdEdit(entry, message.body);
            this.mutationProjector.applyMessageEditQueued(id, message, needsRow);
        });
    }
    /**
     * Keep changes in arrival order while a cross-form identity waits for a reported directory pairing.
     * This chain only prepares changes; it never waits for a row write or for the message's commit.
     * Exact identities retain their synchronous path until a preceding change needs that lookup.
     */
    changeInFlight(id, messageId, source, ready) {
        const key = `${id}:${messageId}`;
        const entry = this.inboundInFlight.get(key);
        const foreign = entry?.ref && source?.chatId ? (0, message_mutation_guard_1.mutationTargetsForeignRow)(entry.ref, source) : null;
        if (!entry?.changes?.pending && (!foreign || !this.lidMappingStore)) {
            ready(foreign !== null, entry);
            return;
        }
        const changes = (entry.changes ??= {});
        const ref = entry.ref;
        const engine = this.engines.get(id);
        const pending = (changes.pending ?? Promise.resolve())
            .then(async () => {
            if (this.engines.get(id) !== engine)
                return;
            const current = this.inboundInFlight.get(key);
            if (current?.changes !== changes || current.ref !== ref)
                return;
            const reason = current.ref && source?.chatId
                ? await (0, message_mutation_guard_1.mutationTargetsForeignRowPersisted)(current.ref, source, this.lidMappingStore ? jid => this.lidMappingStore.findPhoneForLid(jid) : undefined)
                : null;
            // A repeated delivery may replace the entry while the lookup awaits; only its shared identity
            // and change chain may inherit the result. A new engine must never inherit an old callback.
            const target = this.inboundInFlight.get(key);
            if (this.engines.get(id) !== engine || target?.changes !== changes || target.ref !== ref)
                return;
            ready(reason !== null, target);
        })
            .catch(err => {
            this.logger.warn('Unable to prepare a change for an arriving message', { error: String(err) });
        });
        changes.pending = pending;
        void pending.finally(() => {
            if (changes.pending === pending)
                delete changes.pending;
        });
        return pending;
    }
    /** Drain only identity checks already queued for this message, including changes arriving during a check. */
    waitForInFlightChanges(id, messageId) {
        const key = `${id}:${messageId}`;
        if (!this.inboundInFlight.get(key)?.changes?.pending)
            return;
        return (async () => {
            let pending;
            while ((pending = this.inboundInFlight.get(key)?.changes?.pending))
                await pending;
        })();
    }
    /** Queue a message-scoped mutation. A failed operation is isolated so later events still run. */
    enqueueMessageMutation(id, messageId, work) {
        this.mutationProjector.enqueueMessageMutation(id, messageId, work);
    }
    /** Stored-row update for a REST outbound edit, on the same mutation chain — see MessageMutationProjector. */
    recordOutboundMessageEdit(sessionId, messageId, body, source) {
        let stored;
        const pending = this.changeInFlight(sessionId, messageId, source, (needsRow, entry) => {
            if (entry && !needsRow) {
                this.holdEdit(entry, body);
                entry.edited = true;
            }
            stored = this.mutationProjector.recordOutboundMessageEdit(sessionId, messageId, body, source);
        });
        return Promise.resolve(pending).then(() => stored);
    }
    /**
     * Dispatches the opt-in `status.received` webhook once an inbound status row is ingested, and
     * mirrors it over the websocket so the dashboard's statuses view refreshes live instead of
     * waiting for a focus refetch. `WebhookService.dispatch` already filters delivery to webhooks
     * whose `events` array includes `status.received`, so no extra gating is needed here. No media
     * bytes are included in the payload — consumers fetch media via the status media endpoint.
     */
    dispatchStatusReceived(sessionId, row) {
        const payload = {
            sessionId,
            statusId: row.waStatusId,
            contact: {
                id: row.contactJid,
                ...(row.contactName ? { name: row.contactName } : {}),
                ...(row.contactPushName ? { pushName: row.contactPushName } : {}),
            },
            type: row.type,
            ...(row.caption ? { caption: row.caption } : {}),
            hasMedia: Boolean(row.mediaPath) && !row.mediaOmitted,
            mediaOmitted: row.mediaOmitted,
            ...(row.omitReason ? { omitReason: row.omitReason } : {}),
            postedAt: row.postedAt,
            expiresAt: row.expiresAt,
        };
        void this.webhookService.dispatch(sessionId, 'status.received', payload);
        this.eventsGateway.emitStatusReceived(sessionId, payload);
    }
};
exports.MessageProjector = MessageProjector;
exports.MessageProjector = MessageProjector = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(message_entity_1.Message, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(session_entity_1.Session, 'data')),
    __param(8, (0, common_1.Optional)()),
    __param(9, (0, common_1.Optional)()),
    __param(10, (0, common_1.Optional)()),
    __param(11, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        engine_registry_service_1.EngineRegistry,
        events_gateway_1.EventsGateway,
        webhook_service_1.WebhookService,
        hooks_1.HookManager,
        status_store_service_1.StatusStoreService,
        session_lid_resolver_service_1.SessionLidResolver,
        config_1.ConfigService,
        chat_media_archive_service_1.ChatMediaArchiveService,
        automation_rules_service_1.AutomationRulesService,
        lid_mapping_store_service_1.LidMappingStoreService])
], MessageProjector);
