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
exports.SendPacingService = exports.SEND_PACING_LIMITED = void 0;
exports.isPacingLimitedError = isPacingLimitedError;
exports.countsTowardSendBreaker = countsTowardSendBreaker;
exports.sentNothing = sentNothing;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const message_entity_1 = require("./entities/message.entity");
const session_entity_1 = require("../session/entities/session.entity");
const send_pacing_config_1 = require("./send-pacing.config");
const send_pacing_metrics_1 = require("../../common/metrics/send-pacing-metrics");
const logger_service_1 = require("../../common/services/logger.service");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const engine_not_supported_error_1 = require("../../common/errors/engine-not-supported.error");
const engine_throttled_error_1 = require("../../common/errors/engine-throttled.error");
const engine_not_sent_error_1 = require("../../common/errors/engine-not-sent.error");
const engine_page_error_1 = require("../../common/errors/engine-page.error");
const ssrf_guard_1 = require("../../common/security/ssrf-guard");
const wa_id_1 = require("../../engine/identity/wa-id");
const audit_service_1 = require("../audit/audit.service");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
/** Body code on a pacing refusal. The throttler's own 429 carries no `code`, which is what tells the two apart. */
exports.SEND_PACING_LIMITED = 'SEND_PACING_LIMITED';
/**
 * True for the 429 `assertSendAllowed` throws — a policy refusal, distinguished from any other 429
 * by the `code` on its body. Callers use it to treat a paced-out send as a refusal-to-send rather
 * than a delivery failure (no `message:failed`, no breaker increment — the engine was never asked).
 */
function isPacingLimitedError(error) {
    if (!(error instanceof common_1.HttpException))
        return false;
    const body = error.getResponse();
    return typeof body === 'object' && body !== null && body.code === exports.SEND_PACING_LIMITED;
}
/**
 * Whether a failed send says anything about the ACCOUNT's standing with WhatsApp — the only thing
 * the breaker is meant to measure.
 *
 * Adapters raise plenty of failures before (or instead of) asking WhatsApp: a blocked media URL, a
 * capability the engine does not implement, a socket that is not connected, a message id that is
 * not in the local store, a malformed request. Counting those lets a client sending bad requests
 * open the breaker on a perfectly healthy session and 429 every send for the cooldown. The rule is
 * therefore: a client-fault or engine-state HTTP status (4xx/501/503) does NOT count; a refusal
 * WhatsApp itself returned — EngineRefusedError (403) — and anything unclassified (a raw engine
 * error, a timeout, a 5xx) does. A rate limit WhatsApp answered (EngineThrottledError, a 503 on the wire)
 * counts as well: it is WhatsApp refusing this account's traffic, the signal the breaker exists to act on,
 * even though the send provably went nowhere (see sentNothing). A whatsapp-web.js send whose recipient lookup did
 * not answer (RecipientLookupUnansweredError) is a 500 that does not count: it says nothing about the account.
 */
function countsTowardSendBreaker(error) {
    if (error instanceof engine_refused_error_1.EngineRefusedError || error instanceof engine_throttled_error_1.EngineThrottledError)
        return true;
    if (error instanceof ssrf_guard_1.SsrfBlockedError || error instanceof engine_page_error_1.RecipientLookupUnansweredError)
        return false;
    if (error instanceof common_1.HttpException) {
        const status = error.getStatus();
        // 4xx = the caller's request was wrong; 501 = this engine cannot do it; 503 = the engine is not
        // connected (a transport fault the reconnect machinery owns, not an account signal).
        const NOT_IMPLEMENTED = common_1.HttpStatus.NOT_IMPLEMENTED;
        const SERVICE_UNAVAILABLE = common_1.HttpStatus.SERVICE_UNAVAILABLE;
        return !((status >= 400 && status < 500) || status === NOT_IMPLEMENTED || status === SERVICE_UNAVAILABLE);
    }
    return true;
}
/**
 * Whether a send that threw provably never went out, so its admission can be handed back: a client or
 * refusal status (4xx), a 501 for something the engine cannot do, a media URL the SSRF guard blocked
 * before any fetch, a WhatsApp rate limit (EngineThrottledError), turned away before it ran, or a transport
 * failure before the message was handed to WhatsApp (EngineNotSentError). Anything else (a deadline, a
 * dropped socket, a dead page) leaves the outcome unknown; WhatsApp may have taken the message, so its
 * admission stays held.
 */
function sentNothing(error) {
    return (error instanceof ssrf_guard_1.SsrfBlockedError ||
        (error instanceof common_1.HttpException &&
            (error.getStatus() < 500 ||
                error instanceof engine_not_supported_error_1.EngineNotSupportedError ||
                error instanceof engine_throttled_error_1.EngineThrottledError ||
                error instanceof engine_not_sent_error_1.EngineNotSentError)));
}
/** Nothing reserved: the feature is off, no cold schedule, or no stranger in the batch. */
const NO_RESERVATION = { coldCount: 0, dayStartMs: 0 };
/**
 * How long each admitted send is held against the caps before only its row counts: from its own
 * admission, or for one taken `untilSettled`, from the moment its caller settles it. It only has to
 * outlast the gap between that moment and the row insert. A send that fails before writing a row hands
 * its admission back (see assertSendAllowed), so only one that may still have gone out is over-counted,
 * for this long after it settles, or as long as a send admitted after it is held, if that is longer.
 */
const ADMISSION_WINDOW_MS = 10_000;
/**
 * Safety bound on an admission taken `untilSettled` that its caller never settles. Far longer than an
 * engine send normally runs (a media URL fetch is bounded by MEDIA_DOWNLOAD_TIMEOUT_MS, 30 s by default),
 * so it only matters if a caller loses track of one, which then holds the caps for this long instead of
 * for the rest of the day. A send still running past it stops being held.
 */
const UNSETTLED_ADMISSION_MAX_MS = 5 * 60_000;
/**
 * At most one `SEND_PACING_BLOCKED` row per session per window. A session that hits its daily cap
 * goes on being refused for the rest of the day, so one row per refused send would turn enforcing
 * the limit into an audit flood of its own — the same problem, and the same answer, as the
 * websocket rate limiter's `RATE_LIMIT_EXCEEDED` sampling.
 */
const REFUSAL_AUDIT_WINDOW_MS = 60_000;
/** Bound on the sampling map, so a churn of session ids cannot grow it without limit. */
const MAX_REFUSAL_KEYS = 1000;
/**
 * Refuses outbound sends that a young or misbehaving session should not be making.
 *
 * Two rules, both aimed at the way WhatsApp actually bans automated accounts:
 *
 *  - a **warm-up daily cap**, because a new account that immediately sends at volume is the pattern
 *    that gets numbers banned. The allowance grows with the session's age.
 *  - a **failure-streak breaker**, because a run of consecutive send failures usually means WhatsApp
 *    has already started refusing this account, and continuing to push makes its standing worse.
 *
 * It is plain code called from the send paths, NOT a `message:sending` hook subscriber. That is
 * load-bearing: `runGuarded` (plugin-capability-context.ts) suppresses `message:sending` when a
 * plugin sends from inside its own handler, so a hook-based governor would be silently bypassed on
 * exactly the automated traffic it exists to pace.
 *
 * The daily count is read from the `messages` table rather than a counter of its own. That table is
 * already the durable record of every chat send — bulk included, which persists through the same
 * `saveOutgoingMessage` — and it already carries the `(sessionId, createdAt)` index the count needs.
 * So the cap survives restarts with no table and no migration. The trade is that it counts only what
 * writes a row. Two kinds of path clear this check without ever adding to it: a status post
 * (status.service.ts) and a message edit, which is gated here via applySendingGate but only UPDATEs
 * the existing row, never inserts. A bulk item the engine refuses is a third: bulk persists its row only
 * after the send succeeds, so a failed item is checked against the cap but never counted into it,
 * unlike a failed single send whose PENDING row is kept as FAILED. A session using
 * them can exceed its stated allowance. A Baileys product send (catalog.service.ts `sendProduct`)
 * writes no row itself but is counted through the OUTGOING row its own-send echo persists
 * (MessageProjector.handleOwnSendEcho) shortly after the send returns. Deliberate, and documented in
 * .env.example and docs/06 so the number an operator reads is the number they get.
 * Because the row lands only after the check returns, sends admitted in the last few seconds are
 * also held in memory (see Admission), or a parallel burst would pass against one stale count. A bulk
 * item and a product send write their row only after the engine call, which can outlast that window
 * (a media URL fetch, an upload), so they are held until they settle (see `untilSettled`).
 * The breaker, by contrast, is in memory on purpose: it describes live conditions, and a restart
 * clearing it is the correct behaviour.
 */
let SendPacingService = class SendPacingService {
    messageRepository;
    sessionRepository;
    configService;
    auditService;
    logger = (0, logger_service_1.createLogger)('SendPacingService');
    breakers = new Map();
    /**
     * Per-session count of cold GROUP-ADD reachouts used today. Group adds (createGroup/
     * addParticipants) persist no message row, so `countColdReachoutsToday` — which reads the messages
     * table — cannot see them; without this tally each add request would get the full daily allowance
     * afresh, making the cap per-request instead of per-day. In memory like the breaker (the service
     * doc explains why); it resets by UTC day, and also on restart — which for this half of the budget
     * means a restart FORGETS what was already spent and hands out the allowance again. That errs
     * toward more reachouts, not fewer, and is the one place this feature is not restart-proof: the
     * chat half is counted from the messages table and is.
     */
    groupReachoutTally = new Map();
    holds = new Map();
    refusalSamples = new Map();
    constructor(messageRepository, sessionRepository, configService, auditService) {
        this.messageRepository = messageRepository;
        this.sessionRepository = sessionRepository;
        this.configService = configService;
        this.auditService = auditService;
    }
    /**
     * Throw unless this session may send right now. Called at the top of every outbound send path.
     *
     * When the feature is off this returns before doing anything at all — no query, no map lookup — so
     * a deployment that has not opted in behaves exactly as it did before the governor existed.
     *
     * `hold: false` judges the send without holding it in the admission window, for a gated send that
     * never writes a row (an edit): holding it would charge the caps for a message that is never sent.
     *
     * `untilSettled` holds the admission for as long as the send runs, for a caller whose row lands only
     * after the engine call (a bulk item, a product send): the window starts when the caller settles it
     * with `true`, bounded by UNSETTLED_ADMISSION_MAX_MS if it never does. Without it the window starts
     * now, for a caller that writes its PENDING row before asking the engine.
     * `whilePreparing` has no safety expiry: its caller must settle in a finally block once the
     * PENDING write finishes or preparation fails, even when hooks take arbitrarily long.
     *
     * Returns the settle for the admission it held, or undefined when it held none. A caller whose send
     * fails before writing a row, and before WhatsApp may have taken it, calls it with nothing so that
     * send stops counting against the caps at once instead of refusing the next one.
     */
    async assertSendAllowed(sessionId, chatId, opts = {}) {
        const config = (0, send_pacing_config_1.resolveSendPacingConfig)(this.configService);
        if (!config.enabled)
            return;
        this.assertBreakerClosed(sessionId, config);
        const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
        // No row means the send is about to fail on its own for a better reason than pacing; let it.
        if (!session)
            return;
        const dayStart = startOfUtcDay(new Date());
        // Age from createdAt, NOT connectedAt: connectedAt is overwritten on every connect, so a session
        // that reconnects would look one day old forever and never leave the first rung of the ramp.
        const ageDays = Math.floor((dayStart.getTime() - startOfUtcDay(session.createdAt).getTime()) / DAY_MS);
        const allowance = this.allowanceForAge(config.warmupSchedule, ageDays);
        const sentToday = await this.messageRepository.count({
            where: { sessionId, direction: message_entity_1.MessageDirection.OUTGOING, createdAt: (0, typeorm_2.MoreThanOrEqual)(dayStart) },
        });
        // A stale count must not reset the new day's held admissions.
        if (startOfUtcDay(new Date()).getTime() !== dayStart.getTime()) {
            return this.assertSendAllowed(sessionId, chatId, opts);
        }
        // The overall cap is the cheaper check and bounds everything, so it settles before the cold probe.
        this.assertUnderDailyCap(sessionId, dayStart, ageDays, allowance, sentToday);
        const cold = await this.readColdReachouts(sessionId, chatId, dayStart, ageDays, config);
        if (startOfUtcDay(new Date()).getTime() !== dayStart.getTime()) {
            return this.assertSendAllowed(sessionId, chatId, opts);
        }
        // Judged again, and admitted, with no await from here on: a concurrent request admitted while this
        // one was reading must count, and this one must count for the next.
        this.assertUnderDailyCap(sessionId, dayStart, ageDays, allowance, sentToday);
        // A status post (no chatId) never writes a row and never has, so it is not held either.
        if (!chatId)
            return;
        // A chat already held as a cold admission is the same reachout again, not a new one.
        const key = coldChatKey(chatId);
        if (cold && !this.heldAdmissions(sessionId, dayStart).some(a => a.cold?.key === key)) {
            this.assertUnderColdCap(sessionId, dayStart, ageDays, cold);
        }
        if (opts.hold !== false) {
            const until = opts.whilePreparing
                ? Infinity
                : Date.now() + (opts.untilSettled ? UNSETTLED_ADMISSION_MAX_MS : ADMISSION_WINDOW_MS);
            const admission = {
                until,
                unsettled: opts.untilSettled === true,
                heldUntil: until,
                sentToday,
                cold: cold ? { key, coldToday: cold.coldToday } : null,
            };
            const hold = this.holds.get(sessionId);
            if (hold?.dayStartMs === dayStart.getTime())
                hold.admissions.push(admission);
            else
                this.holds.set(sessionId, { dayStartMs: dayStart.getTime(), admissions: [admission] });
            let settled = false;
            return (mayHaveSent = false) => {
                if (settled)
                    return;
                settled = true;
                admission.unsettled = false;
                if (mayHaveSent) {
                    admission.until = Date.now() + ADMISSION_WINDOW_MS;
                    return;
                }
                // Handed back, it holds nothing.
                admission.until = admission.heldUntil = 0;
                const admissions = this.holds.get(sessionId)?.admissions;
                const index = admissions?.indexOf(admission) ?? -1;
                if (admissions && index !== -1) {
                    admissions.splice(index, 1);
                    if (admissions.length === 0)
                        this.holds.delete(sessionId);
                }
            };
        }
    }
    /** Cold chat reachouts today: the persisted count, or more when the held admissions account for more. */
    chatReachoutsToday(sessionId, dayStart, persisted) {
        const held = this.heldAdmissions(sessionId, dayStart);
        // Newest first, so `chats` is always the distinct cold chats held from this admission on.
        const chats = new Set();
        let count = persisted;
        for (let i = held.length - 1; i >= 0; i--) {
            const cold = held[i].cold;
            if (!cold)
                continue;
            cold.coldToday ??= persisted;
            chats.add(cold.key);
            count = Math.max(count, cold.coldToday + chats.size);
        }
        return count;
    }
    /** This session's held admissions today, oldest first, including preparations carried across midnight. */
    heldAdmissions(sessionId, dayStart) {
        const hold = this.holds.get(sessionId);
        if (!hold)
            return [];
        const now = Date.now();
        if (hold.dayStartMs !== dayStart.getTime()) {
            // Preparations and engine calls still running may write today; completed yesterday's sends do not.
            hold.admissions = hold.admissions.filter(a => a.until === Infinity || (a.unsettled && a.until > now));
            hold.dayStartMs = dayStart.getTime();
            for (const admission of hold.admissions) {
                admission.sentToday = null;
                if (admission.cold)
                    admission.cold.coldToday = null;
            }
        }
        // The cold terms lapse as a whole, once no cold admission's own term is running: a warm admission read no
        // cold count, so it cannot have missed a cold row, and letting it hold them would keep a cold send that
        // wrote no row counted for as long as warm sends keep arriving. Cleared rather than skipped, so a cold
        // admission taken later cannot bring them back.
        if (!hold.admissions.some(a => a.cold && a.until > now))
            for (const a of hold.admissions)
                a.cold = null;
        // Newest first: an admission stays held while the next one is. Each one taken after it may have read
        // its count before this one's row landed, and its own term counts this one and each later one once, on
        // a count read before any of their rows.
        for (let i = hold.admissions.length - 1; i >= 0; i--) {
            const a = hold.admissions[i];
            a.heldUntil = Math.max(a.until, hold.admissions[i + 1]?.heldUntil ?? 0);
        }
        // heldUntil never rises from the oldest admission to the newest, so the hold lapses as a whole, once
        // its oldest admission is no longer held.
        if (hold.dayStartMs === dayStart.getTime() && (hold.admissions[0]?.heldUntil ?? 0) > now)
            return hold.admissions;
        this.holds.delete(sessionId);
        return [];
    }
    /**
     * Throw unless this session may reach out to these contacts at once.
     *
     * Adding someone to a group is a reachout in every sense that matters: it puts the account in
     * front of a stranger who did not ask for it, and doing it in bulk is the single most
     * ban-associated action this product can perform. So it draws on the same cold budget a first
     * message does — a batch of twenty strangers costs twenty, not one.
     *
     * It does NOT consume the overall daily message allowance: no message is sent, and spending a
     * send budget on something that sends nothing would misreport both.
     *
     * The whole batch is refused rather than trimmed. Adding some of the requested participants and
     * reporting success would leave the caller unable to tell who actually got added, and the engines
     * report per-participant outcomes for real failures already — a pacing refusal must not be
     * mistaken for one of those.
     *
     * An allowed batch is reserved on the group tally before this returns, in the same synchronous
     * step as the comparison, so concurrent requests cannot all pass against the same unspent budget.
     * The caller refunds the reservation if the engine call then throws.
     */
    async assertReachoutAllowed(sessionId, contactIds) {
        const config = (0, send_pacing_config_1.resolveSendPacingConfig)(this.configService);
        if (!config.enabled)
            return NO_RESERVATION;
        this.assertBreakerClosed(sessionId, config);
        if (config.coldSchedule.length === 0 || contactIds.length === 0)
            return NO_RESERVATION;
        // The same id twice in one request is one contact, and must cost one. Each contact is probed
        // under both user-id dialects (see dialectVariants) — a contact known under the other spelling
        // is not a stranger.
        const unique = [...new Set(contactIds.map(wa_id_1.toParticipantWid))];
        const variantsByContact = new Map(unique.map(id => [id, dialectVariants(id)]));
        const knownRows = await this.messageRepository
            .createQueryBuilder('m')
            .select('DISTINCT m.chatId', 'chatId')
            .where('m.sessionId = :sessionId', { sessionId })
            .andWhere('m.chatId IN (:...ids)', { ids: [...new Set([...variantsByContact.values()].flat())] })
            .getRawMany();
        const knownIds = new Set(knownRows.map(row => row.chatId));
        const coldCount = unique.filter(id => !variantsByContact.get(id).some(v => knownIds.has(v))).length;
        if (coldCount === 0)
            return NO_RESERVATION;
        const session = await this.sessionRepository.findOne({ where: { id: sessionId } });
        if (!session)
            return NO_RESERVATION;
        const dayStart = startOfUtcDay(new Date());
        const ageDays = Math.floor((dayStart.getTime() - startOfUtcDay(session.createdAt).getTime()) / DAY_MS);
        const allowance = this.allowanceForAge(config.coldSchedule, ageDays);
        // A batch larger than a whole day's allowance cannot pass on any day of this rung, so a 429 with a
        // retry hint would send a client that honours it round the same refusal every day. Nothing is
        // reserved; the caller has to split the request.
        if (coldCount > allowance) {
            throw new common_1.BadRequestException(`Reaching ${coldCount} new contact(s) exceeds the daily allowance of ${allowance} new ` +
                `conversation(s) for a session ${ageDays} day(s) old; split the request into batches of at most ${allowance}`);
        }
        // Both sources of the day's reachouts: cold chat messages (persisted rows, or the sends just
        // admitted when those are more) and prior group adds
        // (the in-memory tally). Group adds persist nothing, so without the tally they would not count
        // against themselves and the cap would reset every request.
        const coldChats = await this.countColdReachoutsToday(sessionId, dayStart);
        // The UTC day rolled over while counting: check again against the new day, so the batch is
        // reserved on (and judged by) the day it actually runs in.
        if (startOfUtcDay(new Date()).getTime() !== dayStart.getTime()) {
            return this.assertReachoutAllowed(sessionId, contactIds);
        }
        const groupToday = this.groupReachoutsToday(sessionId, dayStart);
        const usedToday = this.chatReachoutsToday(sessionId, dayStart, coldChats) + groupToday;
        if (usedToday + coldCount <= allowance) {
            // Reserved now, with no await between the check and the charge: a concurrent request must
            // see this batch as spent. The caller refunds it (refundGroupReachouts) if the engine call
            // throws, so a createGroup that 501s on whatsapp-web.js or an add the engine refuses does not
            // burn the day's cold allowance for participants never contacted.
            this.addGroupReachouts(sessionId, dayStart, coldCount);
            return { coldCount, dayStartMs: dayStart.getTime() };
        }
        // Refused only because of cold sends still held: the batch fits once they lapse, not at the next UTC day.
        const retryAfter = coldChats + groupToday + coldCount <= allowance
            ? secondsUntilLapsed(this.heldAdmissions(sessionId, dayStart)
                .filter(a => a.cold)
                .map(a => a.until))
            : secondsUntilNextUtcDay();
        this.refuse('cold_daily_cap', sessionId, retryAfter, {
            reason: `Reaching ${coldCount} new contact(s) would exceed the daily allowance of ${allowance} ` +
                `new conversation(s) for a session ${ageDays} day(s) old (${usedToday} already used)`,
            allowance,
            coldToday: usedToday,
            coldCount,
        });
    }
    /**
     * Give back a reservation from assertReachoutAllowed after the engine call failed. Only the day it
     * was taken from is credited: once the tally has rolled over to a new UTC day, the old day's
     * reservation no longer counts against anything and the new day's tally is left alone.
     */
    refundGroupReachouts(sessionId, reservation) {
        if (reservation.coldCount <= 0)
            return;
        const tally = this.groupReachoutTally.get(sessionId);
        if (!tally || tally.dayStartMs !== reservation.dayStartMs)
            return;
        tally.count = Math.max(0, tally.count - reservation.coldCount);
    }
    /** Cold group-add reachouts charged to this session today (0 once the stored day rolls over). */
    groupReachoutsToday(sessionId, dayStart) {
        const tally = this.groupReachoutTally.get(sessionId);
        return tally && tally.dayStartMs === dayStart.getTime() ? tally.count : 0;
    }
    /** Add to today's group-add tally, resetting it first when the stored entry is from an earlier day. */
    addGroupReachouts(sessionId, dayStart, n) {
        const dayStartMs = dayStart.getTime();
        const tally = this.groupReachoutTally.get(sessionId);
        if (tally && tally.dayStartMs === dayStartMs)
            tally.count += n;
        else
            this.groupReachoutTally.set(sessionId, { dayStartMs, count: n });
    }
    /**
     * Record a send that failed. A run of these trips the breaker.
     *
     * Only called on failures that reached WhatsApp and came back refused — a validation error thrown
     * before the engine is asked says nothing about the account's standing and must not count, or a
     * client sending malformed requests could trip the breaker on a perfectly healthy session.
     */
    recordSendFailure(sessionId) {
        const config = (0, send_pacing_config_1.resolveSendPacingConfig)(this.configService);
        if (!config.enabled)
            return;
        const breaker = this.breakerFor(sessionId);
        breaker.consecutiveFailures += 1;
        if (breaker.openedAt === null && breaker.consecutiveFailures >= config.breakerThreshold) {
            breaker.openedAt = Date.now();
            this.logger.warn(`Send breaker tripped after ${breaker.consecutiveFailures} consecutive failures`, {
                sessionId,
                consecutiveFailures: breaker.consecutiveFailures,
                cooldownMs: config.breakerCooldownMs,
                action: 'send_breaker_tripped',
            });
            // Never sampled: a trip is rare and is the event an operator most wants to find afterwards.
            void this.auditService?.logWarn(audit_log_entity_1.AuditAction.SEND_BREAKER_TRIPPED, {
                sessionId,
                metadata: { consecutiveFailures: breaker.consecutiveFailures, cooldownMs: config.breakerCooldownMs },
                errorMessage: `Send breaker tripped after ${breaker.consecutiveFailures} consecutive send failures`,
            });
        }
    }
    /** Record a send that succeeded, which ends any streak in progress. */
    recordSendSuccess(sessionId) {
        const config = (0, send_pacing_config_1.resolveSendPacingConfig)(this.configService);
        if (!config.enabled)
            return;
        const breaker = this.breakers.get(sessionId);
        if (!breaker)
            return;
        // A success proves the account is being served, so the streak resets AND an open breaker closes.
        // Nothing else closes it early: the cooldown is what normally lets traffic back through.
        this.breakers.delete(sessionId);
    }
    /** The allowance for a session this many whole days old, saturating at the schedule's last entry. */
    allowanceForAge(schedule, ageDays) {
        const index = Math.min(Math.max(ageDays, 0), schedule.length - 1);
        return schedule[index];
    }
    breakerFor(sessionId) {
        const existing = this.breakers.get(sessionId);
        if (existing)
            return existing;
        const created = { consecutiveFailures: 0, openedAt: null };
        this.breakers.set(sessionId, created);
        return created;
    }
    assertBreakerClosed(sessionId, config) {
        const breaker = this.breakers.get(sessionId);
        if (!breaker?.openedAt)
            return;
        const elapsed = Date.now() - breaker.openedAt;
        if (elapsed >= config.breakerCooldownMs) {
            // Cooldown served. Dropping the entry rather than zeroing it is what keeps the map bounded by
            // the number of sessions currently in trouble instead of every session that ever failed — and
            // it is equivalent, since the next failure recreates it at a count of one either way.
            this.breakers.delete(sessionId);
            return;
        }
        this.refuse('breaker_open', sessionId, Math.ceil((config.breakerCooldownMs - elapsed) / 1000), {
            reason: 'Sends are paused after a run of consecutive send failures',
        });
    }
    assertUnderDailyCap(sessionId, dayStart, ageDays, allowance, persisted) {
        const held = this.heldAdmissions(sessionId, dayStart);
        const sentToday = held.reduce((max, a, i) => {
            a.sentToday ??= persisted;
            return Math.max(max, a.sentToday + held.length - i);
        }, persisted);
        if (sentToday < allowance)
            return;
        const retryAfter = persisted < allowance ? secondsUntilLapsed(held.map(a => a.heldUntil)) : secondsUntilNextUtcDay();
        this.refuse('daily_cap', sessionId, retryAfter, {
            reason: `Daily send allowance of ${allowance} reached for a session ${ageDays} day(s) old`,
            allowance,
            sentToday,
        });
    }
    /**
     * Write one audit row per session per window, folding the refusals suppressed in between into the
     * next row's `suppressed` metadata — so the trail stays accurate without one write per refused
     * send. Modelled on the websocket limiter's own sampling, which exists for the same reason.
     */
    auditRefusal(sessionId, rule, retryAfterSeconds, message) {
        const now = Date.now();
        const prior = this.refusalSamples.get(sessionId);
        if (prior && now - prior.since < REFUSAL_AUDIT_WINDOW_MS) {
            prior.count += 1;
            return;
        }
        const suppressed = prior?.count ?? 0;
        // Re-insert rather than mutate, so the map stays in insertion order and the eviction below
        // really does drop the least recently audited session.
        this.refusalSamples.delete(sessionId);
        this.refusalSamples.set(sessionId, { count: 0, since: now });
        while (this.refusalSamples.size > MAX_REFUSAL_KEYS) {
            const oldest = this.refusalSamples.keys().next().value;
            if (oldest === undefined)
                break;
            this.refusalSamples.delete(oldest);
        }
        void this.auditService?.logWarn(audit_log_entity_1.AuditAction.SEND_PACING_BLOCKED, {
            sessionId,
            metadata: { rule, retryAfterSeconds, suppressed },
            errorMessage: message,
        });
    }
    /**
     * Read what the cold-reachout rule needs for this send, or null when the rule does not apply.
     *
     * "Cold" means this account has no history with the chat in EITHER direction: answering someone
     * who wrote to you first is not a reachout, and counting it as one would throttle exactly the
     * traffic WhatsApp wants to see. A chat with no `chatId` (a status post) is not addressed to
     * anyone, so the rule does not apply to it.
     *
     * The cheap probe runs first and settles most sends in one indexed lookup; the aggregate that
     * counts the day's cold reachouts only runs when this send is itself cold.
     */
    async readColdReachouts(sessionId, chatId, dayStart, ageDays, config) {
        if (!chatId || config.coldSchedule.length === 0)
            return null;
        // Any row at all, either direction, any time: one message from them, or one from us last month,
        // and this is an existing relationship rather than a reachout. Probed under both user-id
        // dialects (see dialectVariants). The send being checked has not persisted its own row yet —
        // the gate runs before saveOutgoingMessage — so this cannot see it.
        const hasHistory = await this.messageRepository.exists({
            where: dialectVariants(chatId).map(id => ({ sessionId, chatId: id })),
        });
        if (hasHistory)
            return null;
        return {
            allowance: this.allowanceForAge(config.coldSchedule, ageDays),
            coldToday: await this.countColdReachoutsToday(sessionId, dayStart),
        };
    }
    /** Refuse a cold reachout once the day's allowance for them is spent. */
    assertUnderColdCap(sessionId, dayStart, ageDays, { allowance, coldToday: persisted }) {
        // Group adds share this budget: a day spent adding strangers to groups must leave fewer cold
        // chat reachouts, so fold the in-memory group tally in alongside the chat count.
        const groupToday = this.groupReachoutsToday(sessionId, dayStart);
        const coldToday = this.chatReachoutsToday(sessionId, dayStart, persisted) + groupToday;
        if (coldToday < allowance)
            return;
        const retryAfter = persisted + groupToday < allowance
            ? secondsUntilLapsed(this.heldAdmissions(sessionId, dayStart)
                .filter(a => a.cold)
                .map(a => a.until))
            : secondsUntilNextUtcDay();
        this.refuse('cold_daily_cap', sessionId, retryAfter, {
            reason: `Daily allowance of ${allowance} new conversation(s) reached for a session ${ageDays} day(s) old`,
            allowance,
            coldToday,
        });
    }
    /**
     * Distinct chats this session started today: it sent to them today, nothing in the chat predates
     * today, and nobody wrote to it first — a chat whose counterpart messaged earlier the same day is
     * an answered conversation, not a reachout (the "cold" rule above), however new the chat is.
     * Expressed as NOT EXISTS probes so the outer query stays on the `(sessionId, createdAt)` index
     * and each probe seeks `(sessionId, chatId, createdAt)`; the only aggregate is a per-chat MIN over
     * today's outgoing rows.
     */
    countColdReachoutsToday(sessionId, dayStart) {
        return (this.messageRepository
            .createQueryBuilder('m')
            // Counted per CONTACT, not per stored spelling: the same person reached under both user-id
            // dialects today is one reachout, and the correlated lookups below match either spelling
            // (see dialectVariants — a chat known as @s.whatsapp.net is not a stranger as @c.us).
            // REPLACE is the portable normalisation both SQLite and Postgres carry; the paired IN keeps
            // the inner side's `chatId` index usable.
            .select(`COUNT(DISTINCT REPLACE(m."chatId", '@s.whatsapp.net', '@c.us'))`, 'count')
            .where('m.sessionId = :sessionId', { sessionId })
            .andWhere('m.direction = :direction', { direction: message_entity_1.MessageDirection.OUTGOING })
            .andWhere('m.createdAt >= :dayStart', { dayStart })
            // Identifiers are quoted because the columns really are camelCase (`"chatId"`, not `chat_id`)
            // — there is no snake_case naming strategy on this connection. Unquoted, Postgres would fold
            // them to lowercase and the query would fail at runtime on the very first cold send.
            .andWhere(`NOT EXISTS (SELECT 1 FROM "messages" p WHERE p."sessionId" = :sessionId AND p."chatId" IN (${DIALECT_PAIR('m')}) AND p."createdAt" < :dayStart)`)
            // They wrote first: an incoming row strictly earlier than today's first outgoing one makes
            // the chat an answered conversation, not a cold start. A tie stays cold (conservative).
            .andWhere(`NOT EXISTS (SELECT 1 FROM "messages" i WHERE i."sessionId" = :sessionId AND i."chatId" IN (${DIALECT_PAIR('m')}) AND i."direction" = :incoming AND i."createdAt" < (SELECT MIN(o."createdAt") FROM "messages" o WHERE o."sessionId" = :sessionId AND o."chatId" IN (${DIALECT_PAIR('m')}) AND o."direction" = :direction AND o."createdAt" >= :dayStart))`, { incoming: message_entity_1.MessageDirection.INCOMING })
            .getRawOne()
            .then(row => Number(row?.count ?? 0)));
    }
    refuse(reason, sessionId, retryAfterSeconds, detail) {
        (0, send_pacing_metrics_1.incrementSendPacingRefusals)(reason);
        this.logger.warn(`Send refused by the pacing governor: ${detail.reason}`, {
            ...detail,
            sessionId,
            rule: reason,
            retryAfterSeconds,
            action: 'send_paced',
        });
        this.auditRefusal(sessionId, reason, retryAfterSeconds, detail.reason);
        // 429 with a body `code`, which is what distinguishes this from the global throttler's own 429 —
        // a client that retries blindly on 429 would otherwise treat a day-long cap like a one-second
        // rate limit. `retryAfterSeconds` says how long the refusal actually lasts.
        throw new common_1.HttpException({
            statusCode: common_1.HttpStatus.TOO_MANY_REQUESTS,
            error: 'Too Many Requests',
            message: detail.reason,
            code: exports.SEND_PACING_LIMITED,
            retryAfterSeconds,
        }, common_1.HttpStatus.TOO_MANY_REQUESTS);
    }
};
exports.SendPacingService = SendPacingService;
exports.SendPacingService = SendPacingService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(message_entity_1.Message, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(session_entity_1.Session, 'data')),
    __param(2, (0, common_1.Optional)()),
    __param(3, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        config_1.ConfigService,
        audit_service_1.AuditService])
], SendPacingService);
const DAY_MS = 86_400_000;
/**
 * Both spellings of a user id. Stored rows carry either dialect — inbound rows are neutralized to
 * `@c.us`, outbound rows keep the caller's raw form — so a byte-exact history probe misreads a
 * known contact addressed the other way as cold and over-draws the budget. Non-user ids (groups,
 * lids, …) pass through unchanged; a lid has no derivable phone twin to probe.
 */
/**
 * SQL for both user-id spellings of `<alias>."chatId"`, for use as an `IN (…)` list. The same idea
 * as {@link dialectVariants}, expressed portably: REPLACE exists on SQLite and Postgres alike, and
 * for a non-user id (a group, a lid) both branches collapse to the raw value.
 */
const DIALECT_PAIR = (alias) => `REPLACE(${alias}."chatId", '@s.whatsapp.net', '@c.us'), REPLACE(${alias}."chatId", '@c.us', '@s.whatsapp.net')`;
/** A chat id folded the way countColdReachoutsToday folds it, so the window counts contacts alike. */
function coldChatKey(chatId) {
    return chatId.replace('@s.whatsapp.net', '@c.us');
}
function dialectVariants(chatId) {
    const lower = chatId.toLowerCase();
    if (lower.endsWith('@c.us')) {
        return [chatId, chatId.slice(0, chatId.length - '@c.us'.length) + '@s.whatsapp.net'];
    }
    if (lower.endsWith('@s.whatsapp.net')) {
        return [chatId, chatId.slice(0, chatId.length - '@s.whatsapp.net'.length) + '@c.us'];
    }
    // A bare number is a user id with the suffix left off — the group-participant endpoints accept
    // one and the engines qualify it themselves, so the history probe has to look under both
    // spellings too or a contact the account already knows is charged as a stranger.
    if (/^\d{5,}$/.test(chatId.trim())) {
        const digits = chatId.trim();
        return [digits, `${digits}@c.us`, `${digits}@s.whatsapp.net`];
    }
    return [chatId];
}
/**
 * The cap's day boundary is UTC, not the server's local midnight: a deployment that moves timezone,
 * or replicas in different ones, must not disagree about when the allowance resets.
 */
function startOfUtcDay(at) {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}
/**
 * Seconds until every one of these held admissions could have lapsed, given the epoch ms each one's hold
 * ends: when the persisted count alone is under the cap, the refusal lifts then, not at the next UTC day.
 * One still unsettled lapses a window after its settle at the earliest, so it is hinted as if it settled now.
 */
function secondsUntilLapsed(holdEnds) {
    const now = Date.now();
    const last = holdEnds.reduce((max, end) => Math.max(max, Math.min(end, now + ADMISSION_WINDOW_MS)), now);
    return Math.max(1, Math.ceil((last - now) / 1000));
}
function secondsUntilNextUtcDay() {
    const now = Date.now();
    return Math.max(1, Math.ceil((startOfUtcDay(new Date(now)).getTime() + DAY_MS - now) / 1000));
}
