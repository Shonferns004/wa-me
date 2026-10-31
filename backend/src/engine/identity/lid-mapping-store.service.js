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
exports.LidMappingStoreService = exports.LID_MAPPING_CACHE_DEFAULT = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const lid_mapping_entity_1 = require("./lid-mapping.entity");
const wa_id_1 = require("./wa-id");
const logger_service_1 = require("../../common/services/logger.service");
const request_context_1 = require("../../common/services/request-context");
const configuration_1 = require("../../config/configuration");
// Default cap on the in-memory lid->phone mirror. Every other long-lived map in the engine surface is
// bounded (the per-session lidPhoneCache is 5000); the LID mirror was the lone exception. A miss falls
// back to engine re-resolution (a reverse lookup reads the table), so the cap trades a re-resolution for
// bounded memory, never data loss.
exports.LID_MAPPING_CACHE_DEFAULT = 5000;
/**
 * SQLite binds at most 32766 variables in one statement (Postgres 65535), so an `IN (...)` over a
 * large allowlist is chunked. Small enough to stay well inside both, large enough that a realistic
 * allowlist is one round trip.
 */
const LID_QUERY_CHUNK = 500;
/**
 * How often a failed write is logged. A database that is down or full takes one failed statement per report
 * that has something to write (each inbound message that carries the lid, while its write keeps failing),
 * since a report held back would leave the table naming a number the contact no longer has; the warning is
 * what is bounded, to one in this interval for the whole store, with a count of the failures in between. A
 * dropped second-lid check and a failed second-lid read are logged the same way, each on its own.
 */
const LID_WRITE_WARN_MS = 60_000;
/** How long second-lid checks are collected into one table read: a sync lands its writes over seconds. */
const SECOND_LID_WINDOW_MS = 250;
/** At most this many second-lid checks wait after a failed write or read, oldest dropped first. */
const SECOND_LID_OWED_MAX = 10_000;
/** A pair reported is not reported again for this long, among the last this many pairs. */
const SECOND_LID_REPORTED_MS = 10 * 60_000;
const SECOND_LID_REPORTED_MAX = 2000;
/** Set a key as the newest, dropping the oldest past `max`; whether one was dropped. */
function setNewest(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    return map.size > max && map.delete(map.keys().next().value);
}
function chunk(items, size = LID_QUERY_CHUNK) {
    const out = [];
    for (let i = 0; i < items.length; i += size)
        out.push(items.slice(i, i + size));
    return out;
}
/**
 * Backs lid resolution with the persisted {@link LidMapping} table. A bounded synchronous mirror
 * serves display and hot-cache reads, while authorization and rule matching await the table's current
 * reported pairings. Write-through keeps the local forward and reverse maps warm.
 *
 * The forward map is bounded by an LRU cap (`LID_MAPPING_CACHE_MAX`, default 5000) so a long-running,
 * contact-heavy account does not accumulate one entry per distinct LID ever seen into a slow memory leak.
 * A cache miss is warmed from the table in the background (rows past the preload cap stay resolvable)
 * and otherwise falls back to engine re-resolution (the table remains the source of truth), so eviction
 * only costs a re-resolution, never data loss. The reverse map has no such warm path (nothing looks a
 * lid up by phone), so a phone-keyed filter uses {@link findLidsForPhone}, which reads the table. The
 * reverse map is reconciled on each eviction so it does not retain entries for LIDs no longer in the
 * forward cache.
 */
let LidMappingStoreService = class LidMappingStoreService {
    repo;
    logger = (0, logger_service_1.createLogger)('LidMappingStore');
    lidToPhone = new Map();
    /** Origin of resident display-only mappings, bounded and evicted with the forward mirror. */
    unreported = new Set();
    phoneToLids = new Map();
    /** Repository fallbacks in flight, one per lid, so a hot miss path can't stack duplicate queries. */
    pendingLookups = new Set();
    /**
     * Lids the table answered for and had no row for. {@link pendingLookups} collapses only the lookups
     * that overlap a query already in flight, so without this every DISPATCH that names an unmapped lid
     * issued a fresh query for it, and the callers are on hot paths: a webhook filter resolves both the
     * event's actor and each of its own rule values, on every dispatch.
     *
     * Cleared for a lid the moment this process learns a mapping for it ({@link index}), and wholesale
     * when the table is reloaded. An absence is never RECORDED for a lid this process already holds or
     * is still writing ({@link unsettledWrites}), which is what keeps a query that raced a write from
     * shadowing the row it could not see yet.
     *
     * What it does NOT notice is a row ANOTHER process writes: that mapping stays unseen here until
     * this process learns it or reloads, exactly as a phone already cached in {@link lidToPhone} does.
     * Bounded by the same cap as the forward map, oldest-recorded first (the forward map is ordered by
     * recency of USE, this one by when the absence was recorded).
     */
    absentFromTable = new Set();
    /**
     * Lids whose row this process has indexed but not yet committed. `remember()` updates the in-memory
     * maps synchronously and writes the table afterwards, so between the two a table read answers "no
     * row" about a mapping that is about to exist. The forward map cannot stand in for this: the LRU
     * can evict the entry inside that same window, leaving it indistinguishable from never-learned.
     * Counted per lid, so the first of two overlapping writes settling does not clear the second. The
     * latest actual report's token remains until all older writes settle, isolating their late results.
     * It also holds the second-lid check the latest new pairing owes until a landed write queues it, for a report
     * overlapping it.
     */
    unsettledWrites = new Map();
    /**
     * Lids a write started for while their table read was in flight. That read may have run before the
     * write committed, so whatever it answers predates the mapping this process now holds.
     */
    racedLookups = new Set();
    /**
     * Sessions counted as having written or reported the phone a lid holds in {@link lidToPhone} (a loaded
     * row counts its owner). An uncounted session reporting the same phone takes the row and is counted
     * after its write succeeds; one already counted preserves the owner while checking for a changed row
     * on another node. So the row names the latest uncounted session to report
     * the phone, not the latest to report it: after s1, s2, s1 report one phone it names s2, and s2's
     * negative clears a phone s1 still sees. Started anew when the phone changes, dropped with the cached
     * entry, on an applied negative and on any release. A failed write does not forget an earlier success.
     */
    seenBy = new Map();
    /**
     * Cached phones whose report is pending or failed, or whose cached contradiction failed to persist.
     * Kept only while the cache holds that phone, until a current write lands or a negative clears it.
     */
    failedWrites = new Set();
    /** When a failed write was last logged, on {@link now}, and how many have failed since without a line. */
    writeWarning = { at: -Infinity, held: 0 };
    /**
     * Second-lid checks owed after the writes of the report that owed one failed, or its read did, or its read found
     * the row no longer holding the phone this node still holds, until a write of that phone lands. A new check stays
     * on its lid's {@link unsettledWrites} entry until a landed write queues it or every write of the lid has settled.
     * Kept apart from the mapping cache and its eviction.
     */
    secondLidOwed = new Map();
    secondLidDropWarning = { at: -Infinity, held: 0 };
    secondLidReadWarning = { at: -Infinity, held: 0 };
    /** Checks queued for the next read: phone -> lid -> its check, in the order their writes landed. */
    secondLidChecks = new Map();
    secondLidTimer;
    /** {@link SECOND_LID_WINDOW_MS}, a seam for tests. */
    secondLidWindowMs = SECOND_LID_WINDOW_MS;
    /** Pairs reported, keyed by phone and both lids sorted, with when on {@link now}. */
    secondLidReported = new Map();
    secondLidClosing = false;
    secondLidListener;
    /** Monotonic clock in ms (a seam for tests). */
    now = () => performance.now();
    // 0 = unbounded (legacy behaviour). Every other long-lived map in the engine surface is bounded, so
    // the default is finite; the env override exists for operators who explicitly want the old behaviour.
    maxCachedLids;
    constructor(repo) {
        this.repo = repo;
        this.maxCachedLids = (0, configuration_1.resolveNonNegativeIntEnv)(process.env.LID_MAPPING_CACHE_MAX, exports.LID_MAPPING_CACHE_DEFAULT);
    }
    async onModuleInit() {
        await this.reload();
    }
    /**
     * Stop the second-lid checks without waiting: none is read after this and a read under way ends without a
     * report, so the checks collected in the last window before a stop go unreported.
     */
    onModuleDestroy() {
        this.secondLidClosing = true;
        clearTimeout(this.secondLidTimer);
    }
    /**
     * (Re)load the in-memory mirror from the table. Called on boot, and by the infra data import after
     * a committed full-replace restore — the mirror is otherwise write-through only, so restored rows
     * would never reach it and entries the restore removed would stay resolvable until the next start.
     * Never throws: a missing table (migration not yet applied) or a read error must not block boot or
     * fail the import — resolution falls back to engine re-resolution until the table is readable.
     */
    async reload() {
        // Dropped before the read too: a restore may have replaced the table, so if the read fails, a lid
        // not cached must read through rather than trust a stale absence.
        this.absentFromTable.clear();
        try {
            // Deterministic preload: an unordered find() followed by LRU eviction keeps an ARBITRARY
            // subset once the table exceeds the cap. Order by last-write and take at most the cap, so
            // the resident subset is the most-recently-written mappings; older rows stay persisted and
            // are warmed back on the first cache miss (see getCached).
            const rows = await this.repo.find({
                order: { updatedAt: 'DESC' },
                take: this.maxCachedLids > 0 ? this.maxCachedLids : undefined,
            });
            this.lidToPhone.clear();
            this.unreported.clear();
            this.phoneToLids.clear();
            this.seenBy.clear();
            this.failedWrites.clear();
            for (const writing of this.unsettledWrites.values()) {
                delete writing.latestReport;
                delete writing.latestOperation;
            }
            // A reload re-reads the table, so every recorded absence is a fresh question again.
            this.absentFromTable.clear();
            // Oldest first, so the newest row ends at the most-recent end of the LRU rather than the first
            // one evicted.
            for (const row of rows.reverse()) {
                this.index(row.lid, row.phone, row.sessionId, row.isReported);
            }
            this.logger.log(`Loaded ${rows.length} lid->phone mappings into cache${this.maxCachedLids ? ` (cap ${this.maxCachedLids})` : ''}`);
        }
        catch (err) {
            this.logger.warn(`Could not preload lid->phone mappings: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    getCached(lid) {
        // LRU touch: re-insert the entry so iteration order (insertion order for Map) tracks recency.
        // A missed lookup returns undefined without disturbing the order.
        if (this.lidToPhone.has(lid)) {
            const phone = this.lidToPhone.get(lid);
            this.lidToPhone.delete(lid);
            this.lidToPhone.set(lid, phone);
            return phone;
        }
        this.warmFromTable(lid);
        return undefined;
    }
    resolveLid(jid) {
        const lid = (0, wa_id_1.userPart)(jid);
        return this.unreported.has(lid) ? null : (this.getCached(lid) ?? null);
    }
    lidsForPhone(phone) {
        const set = this.phoneToLids.get(phone);
        return set ? [...set].filter(lid => !this.unreported.has(lid)) : [];
    }
    /**
     * Reverse lookup that also reads the table. {@link lidsForPhone} only sees lids resident in the
     * forward cache, and nothing phone-keyed ever warms it, so a mapping past the preload cap or
     * evicted by the LRU would stay invisible to a phone filter for good. For callers that can await
     * (the message and status filters, the handover gate, the API-key chat fence). Same rule as
     * {@link lidsForPhonesPersisted}; a read error falls back to the cache alone.
     */
    async findLidsForPhone(phone) {
        try {
            return (await this.readLidsForPhones([phone]))[phone];
        }
        catch (err) {
            this.logger.warn(`Could not read lids for a phone: ${err instanceof Error ? err.message : String(err)}`);
            return this.lidsForPhone(phone).filter(lid => !this.unreported.has(lid));
        }
    }
    /**
     * Batched forward lookup for a list filter: lid user-part -> phone digits. Chunked queries for the
     * whole allowlist instead of one per entry, and the TABLE wins over the mirror so a stale cached
     * negative cannot shadow a mapping another node persisted.
     */
    async phonesForLidsPersisted(lids) {
        const out = {};
        if (lids.length === 0)
            return out;
        // The mirror is only the fallback for a failed table read, so it is read without getCached:
        // that warms every miss with a findOne of its own, one per lid ahead of the batched query below.
        for (const lid of lids)
            out[lid] = this.unreported.has(lid) ? null : (this.lidToPhone.get(lid) ?? null);
        try {
            for (const batch of chunk(lids)) {
                const rows = await this.repo.find({ where: { lid: (0, typeorm_2.In)(batch) } });
                for (const lid of batch)
                    out[lid] = null;
                // The table WINS: a stale cached negative must not shadow a mapping another node persisted.
                for (const row of rows)
                    out[row.lid] = this.rowPhone(row.lid, row.phone, row.isReported);
            }
        }
        catch {
            // The table may not exist yet (migration pending); the mirror is the best available answer.
        }
        return out;
    }
    /** Batched reverse lookup, companion to {@link phonesForLidsPersisted}: phone digits -> lids. */
    async lidsForPhonesPersisted(phones) {
        try {
            return await this.readLidsForPhones(phones);
        }
        catch {
            // The table may not exist yet (migration pending); the cache is the best available answer.
            return Object.fromEntries(phones.map(phone => [phone, this.lidsForPhone(phone).filter(lid => !this.unreported.has(lid))]));
        }
    }
    /** Read only current table rows on success; a resident mapping cannot restore a deleted row. */
    async readLidsForPhones(phones) {
        const out = Object.fromEntries(phones.map(phone => [phone, new Set()]));
        for (const batch of chunk(phones)) {
            for (const { lid, phone, isReported } of await this.repo.find({ where: { phone: (0, typeorm_2.In)(batch) } })) {
                if (!phone || !out[phone])
                    continue;
                if (this.rowPhone(lid, phone, isReported) === phone)
                    out[phone].add(lid);
            }
        }
        return Object.fromEntries(phones.map(phone => [phone, [...out[phone]]]));
    }
    /** This process has a phone write for the lid that the table does not have: in flight, or failed. */
    unstored(lid) {
        return this.unsettledWrites.has(lid) || this.failedWrites.has(lid);
    }
    /**
     * The phone a lid's row answers. The table is the truth across nodes, but while a phone this process holds
     * for the lid is not stored yet, a row that differs may be the number it replaces: the lid then answers
     * none, so no fence lookup admits either one until the write lands.
     */
    rowPhone(lid, phone, isReported = false) {
        if (!isReported || (this.unreported.has(lid) && this.unstored(lid)))
            return null;
        const cached = this.lidToPhone.get(lid);
        return this.unstored(lid) && cached !== undefined && cached !== phone ? null : phone;
    }
    /**
     * Forward lookup for callers that can await: the API-key chat fence and every chat-bound read
     * behind it (message history and media, the quoted body, status and handover filters). The table
     * answers first, the in-memory mirror only when the read fails. The mirror alone is
     * not enough: it is LRU-evicted at `LID_MAPPING_CACHE_MAX`, and nothing refreshes it when another
     * node re-maps a lid in the shared table, so a cache-first answer could resolve the same lid to
     * a phone the fence no longer sees, and a read behind the fence would serve that other chat. The
     * row is not indexed into the cache, so a lookup cannot evict hot entries. A row is vetoed while this
     * process has a different phone for the lid in flight or failed ({@link rowPhone}); with no row, no
     * alias is authorized until a report commits.
     */
    async findPhoneForLid(jid) {
        const lid = (0, wa_id_1.userPart)(jid);
        try {
            const row = await this.repo.findOne({ where: { lid } });
            return row ? this.rowPhone(lid, row.phone, row.isReported) : null;
        }
        catch (err) {
            this.logger.warn(`Could not read the phone for a lid: ${err instanceof Error ? err.message : String(err)}`);
        }
        return this.unreported.has(lid) ? null : (this.getCached(lid) ?? null);
    }
    /**
     * A cached lookup can introduce display data, but cannot replace a stored phone or negative or grant
     * alias access. A conflicting positive revokes alias trust until an engine reports the mapping again.
     */
    async rememberIfUnknown(lid, phone, sessionId) {
        if (!lid)
            return true;
        const cached = this.lidToPhone.get(lid);
        const lookup = { phone };
        if (cached && cached !== phone) {
            this.unreported.add(lid);
            this.seenBy.set(lid, new Set());
        }
        const reporters = this.seenBy.get(lid);
        const writing = this.beginWrite(lid, lookup);
        try {
            await this.repo
                .createQueryBuilder()
                .insert()
                .values({ lid, phone, sessionId: sessionId ?? null, updatedAt: new Date() })
                .orIgnore()
                .execute();
            const { affected } = await this.repo.update({ lid, phone: (0, typeorm_2.Raw)(column => `${column} <> :lookupPhone`, { lookupPhone: phone }), isReported: true }, { isReported: false, updatedAt: () => '"updatedAt"' });
            if (affected &&
                writing.latestOperation === lookup &&
                this.seenBy.get(lid) === reporters &&
                this.lidToPhone.has(lid))
                this.unreported.add(lid);
            // No optimistic mirror write: another node may already hold a newer phone or negative.
            this.absentFromTable.delete(lid);
            return true;
        }
        catch (err) {
            if (writing.latestOperation === lookup && this.seenBy.get(lid) === reporters && this.unreported.has(lid))
                this.failedWrites.add(lid);
            this.warnWriteFailed(`Could not store lid mapping: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
        finally {
            this.endWrite(lid, writing);
        }
    }
    async remember(lid, phone, sessionId) {
        if (!lid)
            return true;
        const cached = this.lidToPhone.get(lid);
        // Unseen-or-changed only, or a phone a session reports here for the first time: a no-op write would
        // just churn updatedAt.
        const seen = !this.unreported.has(lid) &&
            cached === phone &&
            (phone === null || !sessionId || this.seenBy.get(lid)?.has(sessionId));
        // This report gives the lid a phone this node did not hold for it, a new or changed pairing or one only
        // display data had, so it owes a second-lid check; a lid outside the cache cannot be told from a new one.
        // Any other report carries the check an earlier report of the lid still owes, in flight or not, unless that
        // check names another phone (the cache read this one back from the table since): then it owes its own.
        const earlier = this.unsettledWrites.get(lid)?.check ?? this.secondLidOwed.get(lid);
        const gaining = phone !== null && (cached !== phone || this.unreported.has(lid) || (!!earlier && earlier.phone !== phone));
        const owed = gaining ? { phone, sessionId: sessionId ?? null, queued: false } : earlier;
        // A negative is not cached until the table has taken it: see clear().
        if (!seen && phone !== null)
            this.index(lid, phone, null);
        if (phone !== null)
            this.failedWrites.add(lid);
        const reporters = this.seenBy.get(lid);
        const report = { phone };
        const writing = this.beginWrite(lid, report, true);
        if (gaining) {
            writing.check = owed; // outside the cap of owed checks while the lid's writes are unsettled
            this.secondLidOwed.delete(lid);
        }
        try {
            if (seen && phone !== null) {
                // A peer may have changed or revoked this row since this node counted the report. Keep the
                // owner and timestamp for the same phone, but let the latest actual report replace another one.
                const changed = '"lid_mappings"."phone" IS NULL OR "lid_mappings"."phone" <> EXCLUDED."phone"';
                const [insert, parameters] = this.repo
                    .createQueryBuilder('lid_mappings')
                    .insert()
                    .values({ lid, phone, sessionId: sessionId ?? null, isReported: true, updatedAt: new Date() })
                    .getQueryAndParameters();
                await this.repo.query(insert +
                    ` ON CONFLICT ("lid") DO UPDATE SET "phone" = EXCLUDED."phone", "isReported" = true, ` +
                    `"sessionId" = CASE WHEN ${changed} THEN EXCLUDED."sessionId" ELSE "lid_mappings"."sessionId" END, ` +
                    `"updatedAt" = CASE WHEN ${changed} THEN EXCLUDED."updatedAt" ELSE "lid_mappings"."updatedAt" END ` +
                    `WHERE ${changed} OR "lid_mappings"."isReported" = false`, parameters);
            }
            else if (phone === null)
                await this.clear(lid, sessionId ?? null, seen, report);
            else {
                await this.repo.upsert({ lid, phone, sessionId: sessionId ?? null, isReported: true, updatedAt: new Date() }, [
                    'lid',
                ]);
            }
            // Count only a stored report in this phone's current cache epoch. A late completion after
            // P -> Q -> P must not count the first P as a report of the replacement P.
            if (phone !== null && reporters && this.seenBy.get(lid) === reporters) {
                const operation = writing.latestOperation;
                let reported = !this.unreported.has(lid);
                // A consistent lookup may have revoked the old stored phone while this actual write was
                // in flight. Only the current reported row can establish which SQL statement landed last.
                if (!reported && writing.latestReport === report && operation?.phone === phone) {
                    const row = await this.repo.findOne({ where: { lid } }).catch(() => null);
                    reported = row?.isReported === true && row.phone === phone;
                }
                if (reported &&
                    this.seenBy.get(lid) === reporters &&
                    writing.latestReport === report &&
                    writing.latestOperation === operation &&
                    operation?.phone === phone) {
                    this.failedWrites.delete(lid);
                    this.unreported.delete(lid);
                }
                if (sessionId && this.seenBy.get(lid) === reporters)
                    reporters.add(sessionId);
            }
            // A check owed again after its read failed, or found the row not holding its phone, is a copy no write already in
            // flight carries. The lid's latest report takes it when it lands with that phone; an older one could run it
            // before a newer write moves the row.
            const again = writing.latestReport === report ? this.secondLidOwed.get(lid) : undefined;
            if (owed && owed.phone === phone)
                this.queueSecondLid(lid, owed);
            if (again?.phone === phone)
                this.queueSecondLid(lid, again);
            return true;
        }
        catch (err) {
            this.warnWriteFailed(`Failed to persist lid->phone mapping for ${lid}: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
        finally {
            if (owed?.queued && writing.check === owed)
                writing.check = undefined; // a landed write queued it
            this.endWrite(lid, writing);
        }
    }
    /** Keep report and lookup ordering until all older writes settle, without counting a lookup as a report. */
    beginWrite(lid, operation, actual = false) {
        const writing = this.unsettledWrites.get(lid) ?? { count: 0 };
        writing.count++;
        writing.latestOperation = operation;
        if (actual)
            writing.latestReport = operation;
        this.unsettledWrites.set(lid, writing);
        if (this.pendingLookups.has(lid))
            this.racedLookups.add(lid);
        return writing;
    }
    /**
     * Once the last write of the lid settles, the latest new pairing's check, if no landed write queued it, is owed
     * until a write of its phone lands, unless a newer report of the lid took its place. Not before: an overlapping
     * report or negative can fail while the pairing's own write is still in flight, and that write queues the check if
     * it lands.
     */
    endWrite(lid, writing) {
        if (this.unsettledWrites.get(lid) !== writing || --writing.count > 0)
            return;
        this.unsettledWrites.delete(lid);
        if (writing.check && !writing.check.queued)
            this.oweSecondLid(lid, writing.check);
    }
    /**
     * Record that a session found no phone for a lid. The row is shared by every session, and one account
     * can see a contact's number while another cannot, so a negative replaces the row only when it holds
     * no phone or the phone was written by this session (or by none, or by one no longer linked: gone from
     * `sessions`, or logged out, which clears its `phone`); another linked session's mapping stays. The check
     * is part of the update, not a read before it, so a phone stored meanwhile is never overwritten. When the
     * row is cleared the cached entry is dropped rather than set: a phone written while the statements ran may
     * be the newer value, and the next read takes whichever the table holds.
     */
    async clear(lid, sessionId, preserveEmpty, report) {
        const updatedAt = new Date();
        // Creates the row when there is none; an existing one is left to the conditional update.
        await this.repo
            .createQueryBuilder()
            .insert()
            .values({ lid, phone: null, sessionId, isReported: true, updatedAt })
            .orIgnore()
            .execute();
        const replaceable = [
            { lid, phone: (0, typeorm_2.IsNull)() },
            { lid, sessionId: (0, typeorm_2.IsNull)() },
            // A session deleted without its rows being released (an older release, a crash, a restored backup)
            // owns them no more than a released one does, and neither does one logged out: it reports nothing
            // until it is linked again. CAST: sessions.id is a uuid on PostgreSQL.
            {
                lid,
                sessionId: (0, typeorm_2.Raw)(owner => `${owner} NOT IN (SELECT CAST(s."id" AS TEXT) FROM sessions s WHERE s."phone" IS NOT NULL)`),
            },
            ...(sessionId ? [{ lid, sessionId }] : []),
        ];
        // A loaded negative may be stale after a peer's positive report. Recheck ownership atomically,
        // preserving an unchanged empty row's owner and timestamp rather than trusting this mirror.
        const eligible = preserveEmpty
            ? replaceable.slice(1).map(where => ({ ...where, phone: (0, typeorm_2.Not)((0, typeorm_2.IsNull)()) }))
            : replaceable;
        const { affected } = await this.repo.update(eligible, { phone: null, sessionId, isReported: true, updatedAt });
        if (!affected || this.unsettledWrites.get(lid)?.latestReport !== report)
            return;
        const cached = this.lidToPhone.get(lid);
        this.lidToPhone.delete(lid);
        this.unreported.delete(lid);
        this.seenBy.delete(lid);
        this.failedWrites.delete(lid);
        if (cached)
            this.unindex(lid, cached);
        this.absentFromTable.delete(lid);
    }
    /** Set the one listener told of each second-lid report; the session module audits it. */
    onSecondLid(listener) {
        this.secondLidListener = listener;
    }
    /**
     * Keep a check owed, dropping the oldest past {@link SECOND_LID_OWED_MAX}: a dropped check runs only if a report
     * in flight already carries it.
     */
    oweSecondLid(lid, check) {
        if (setNewest(this.secondLidOwed, lid, check, SECOND_LID_OWED_MAX)) {
            const message = `More than ${SECOND_LID_OWED_MAX} second-lid checks are owed; dropping the oldest`;
            this.warnAtMost(this.secondLidDropWarning, message, 'dropped');
        }
    }
    /**
     * Queue the check a landed write carries, for one table read once {@link secondLidWindowMs} has passed. The
     * read runs outside the request that made the report, and the write never waits for it.
     */
    queueSecondLid(lid, check) {
        if (check.queued || this.secondLidClosing)
            return;
        check.queued = true;
        if (this.secondLidOwed.get(lid) === check)
            this.secondLidOwed.delete(lid);
        const lids = this.secondLidChecks.get(check.phone) ?? new Map();
        lids.set(lid, check);
        this.secondLidChecks.set(check.phone, lids);
        this.secondLidTimer ??= (0, request_context_1.outsideRequest)(() => setTimeout(() => void this.checkSecondLids(), this.secondLidWindowMs).unref());
    }
    /** The gateway is stopping or the data source has closed: a check neither reads nor warns. */
    get closed() {
        return this.secondLidClosing || this.repo.manager?.dataSource?.isInitialized === false;
    }
    /**
     * Read the table once for the checks collected and warn for each other engine-reported lid it maps a checked
     * phone to: WhatsApp gave the number to someone else or moved its holder, and a chat fence entry for either
     * lid, or for the number, now admits both. The lid the read finds is previous; of two checked together, the
     * one whose write landed first. {@link firstReport} keeps a pair checked twice to one warning.
     */
    async checkSecondLids() {
        this.secondLidTimer = undefined;
        const checks = this.secondLidChecks;
        this.secondLidChecks = new Map();
        if (this.closed)
            return;
        let found;
        try {
            found = await this.readLidsForPhones([...checks.keys()]);
        }
        catch (err) {
            // Owed again, for the next write of the lid that lands, unless the lid has a newer check or this node holds
            // another phone for it by now: its next landed write then moves it off this phone or owes a fresh check.
            for (const lids of checks.values())
                for (const [lid, check] of lids) {
                    const cached = this.lidToPhone.get(lid);
                    if (!this.secondLidOwed.has(lid) && (cached === undefined || cached === check.phone))
                        this.oweSecondLid(lid, { ...check, queued: false });
                }
            // A read the closing data source cut off is not worth a line, which is only known once it has had the
            // time to close.
            const message = `Could not check for a second lid: ${err instanceof Error ? err.message : String(err)}`;
            setTimeout(() => this.closed || this.warnAtMost(this.secondLidReadWarning, message, 'failed'), this.secondLidWindowMs).unref();
            return;
        }
        if (this.closed)
            return; // a read still under way at shutdown ends without a report
        for (const [phone, lids] of checks) {
            const queued = [...lids.keys()];
            const held = found[phone] ?? [];
            queued.forEach((newLid, i) => {
                if (!held.includes(newLid)) {
                    // Its row holds another phone by now, or a conflicting display lookup marked it unreported. If this node
                    // still holds this phone for it, the row is another node's, an older write that committed last (a pool can
                    // reorder commits) or that lookup's: the next write of this phone to land checks it again.
                    const check = lids.get(newLid);
                    if (check && this.lidToPhone.get(newLid) === phone && !this.secondLidOwed.has(newLid))
                        this.oweSecondLid(newLid, { ...check, queued: false });
                    return;
                }
                for (const previousLid of held) {
                    // Itself, or a lid whose write landed later in this window and names this one previous.
                    if (queued.indexOf(previousLid) >= i || !this.firstReport(phone, previousLid, newLid))
                        continue;
                    this.reportSecondLid({ phone, previousLid, newLid, sessionId: lids.get(newLid)?.sessionId ?? null });
                }
            });
        }
    }
    /** Whether a pair is reported now: not reported within {@link SECOND_LID_REPORTED_MS} among the last pairs kept. */
    firstReport(phone, a, b) {
        const key = [phone, ...[a, b].sort()].join(':');
        const now = this.now();
        if (now - (this.secondLidReported.get(key) ?? -Infinity) < SECOND_LID_REPORTED_MS)
            return false;
        setNewest(this.secondLidReported, key, now, SECOND_LID_REPORTED_MAX);
        return true;
    }
    reportSecondLid(report) {
        const { phone, previousLid, newLid, sessionId } = report;
        this.logger.warn('A phone number was reported under a second privacy id', {
            sessionId: sessionId ?? undefined,
            phone,
            previousLid,
            newLid,
            action: 'second_lid_reported',
        });
        const listener = this.secondLidListener;
        // A listener that throws or rejects is logged and stops no other report.
        if (listener) {
            void Promise.resolve()
                .then(() => listener(report))
                .catch(err => this.logger.warn(`Could not report a second lid: ${err instanceof Error ? err.message : String(err)}`));
        }
    }
    /** Log a failed write at most once per {@link LID_WRITE_WARN_MS}, counting the ones in between. */
    warnWriteFailed(message) {
        this.warnAtMost(this.writeWarning, message, 'failed');
    }
    /** Log at most once per {@link LID_WRITE_WARN_MS} for one gate, counting the lines held back in between. */
    warnAtMost(gate, message, verb) {
        const now = this.now();
        if (now - gate.at < LID_WRITE_WARN_MS) {
            gate.held++;
            return;
        }
        this.logger.warn(gate.held ? `${message} (${gate.held} more ${verb} since the last warning)` : message);
        gate.at = now;
        gate.held = 0;
    }
    /**
     * Hand a deleted session's rows to no session. Its id never comes back (a re-created session gets a
     * new one); {@link clear} also treats an owner missing from `sessions` as none, which covers a delete
     * that never got here. The rows stay: the table is shared. Never throws: the session is already gone.
     */
    async releaseSession(sessionId) {
        // A counted reporter preserves the current owner on a repeated phone report, so a released row
        // would stay ownerless. Drop every set even if the update fails, so the next report takes ownership.
        this.seenBy.clear();
        try {
            // updatedAt is kept: no mapping changed, and the preload ranks rows by it.
            await this.repo.update({ sessionId }, { sessionId: null, updatedAt: () => '"updatedAt"' });
        }
        catch (err) {
            this.logger.warn(`Could not release lid mappings: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /**
     * Repository fallback for a cache miss. Rows past the preload cap (or evicted by the LRU) are
     * still persisted, so a miss is warmed from the table: THIS lookup still returns undefined —
     * the sync read contract can't await, and callers fall back to engine re-resolution, but the
     * next one hits. A table miss IS remembered, so an unmapped lid stops re-querying on every
     * lookup ({@link absentFromTable}), but only when nothing learned that lid in the meantime;
     * a read error is swallowed (the table may not exist yet), the same posture as reload().
     */
    warmFromTable(lid) {
        if (!lid || this.pendingLookups.has(lid) || this.absentFromTable.has(lid))
            return;
        this.pendingLookups.add(lid);
        // Captured BEFORE the query: a write for this lid that has not reached the table yet means the
        // answer is already stale, whatever it says. The forward-map check below cannot see that case,
        // because `remember()` indexes synchronously and the LRU can evict the entry again before the
        // query answers, at which point the map looks exactly like "never learned".
        const writeInFlight = this.unsettledWrites.has(lid);
        void this.repo
            .findOne({ where: { lid } })
            .then(row => {
            // A write that was unsettled when the query ran, or started while it was in flight, is newer
            // than either answer: a row would be the phone it replaces, served as a hit after the write
            // commits, and an absence would block the warm-back once the LRU evicts the forward entry.
            // Neither is recorded, so the next miss reads the table again.
            if (writeInFlight || this.racedLookups.has(lid))
                return;
            // Last-write-wins: a mapping indexed while the lookup was in flight is newer.
            if (row && !this.lidToPhone.has(row.lid)) {
                this.index(row.lid, row.phone, row.sessionId, row.isReported);
                return;
            }
            if (!row && !this.lidToPhone.has(lid))
                this.noteAbsent(lid);
        })
            .catch(() => undefined)
            .finally(() => {
            this.pendingLookups.delete(lid);
            this.racedLookups.delete(lid);
        });
    }
    /** Update both in-memory indexes, dropping any stale reverse entry from a previous phone. */
    index(lid, phone, sessionId, isReported = true) {
        const previouslyReported = !this.unreported.has(lid);
        if (isReported)
            this.unreported.delete(lid);
        else
            this.unreported.add(lid);
        const prev = this.lidToPhone.get(lid);
        if (prev && prev !== phone) {
            this.unindex(lid, prev);
        }
        const seen = (isReported && previouslyReported && prev === phone && this.seenBy.get(lid)) || new Set();
        if (isReported && sessionId)
            seen.add(sessionId);
        if (phone)
            this.seenBy.set(lid, seen);
        else
            this.seenBy.delete(lid);
        // Re-insert (delete + set) so the entry moves to the most-recent end of the LRU order even on update.
        this.lidToPhone.delete(lid);
        this.lidToPhone.set(lid, phone);
        if (phone) {
            const set = this.phoneToLids.get(phone) ?? new Set();
            set.add(lid);
            this.phoneToLids.set(phone, set);
        }
        this.absentFromTable.delete(lid);
        this.evictIfOverCap();
    }
    /**
     * Record that the table holds no row for this lid, bounded oldest-recorded first.
     *
     * Skipped entirely when the cap is disabled: that mode is the legacy unbounded cache, and an
     * absence set is the one map here that grows on ids a caller supplies rather than on mappings the
     * account really has, so leaving it unbounded would be a leak an operator never opted into.
     */
    noteAbsent(lid) {
        if (!this.maxCachedLids)
            return;
        this.absentFromTable.add(lid);
        while (this.absentFromTable.size > this.maxCachedLids) {
            const oldest = this.absentFromTable.values().next().value;
            if (oldest === undefined)
                break;
            this.absentFromTable.delete(oldest);
        }
    }
    /** Evict the least-recently-used forward entry (and its reverse index) while over the cap. */
    evictIfOverCap() {
        if (!this.maxCachedLids)
            return; // unbounded
        while (this.lidToPhone.size > this.maxCachedLids) {
            const oldest = this.lidToPhone.keys().next().value;
            if (oldest === undefined)
                break;
            const phone = this.lidToPhone.get(oldest);
            this.lidToPhone.delete(oldest);
            this.unreported.delete(oldest);
            this.seenBy.delete(oldest);
            this.failedWrites.delete(oldest);
            const writing = this.unsettledWrites.get(oldest);
            if (writing) {
                delete writing.latestReport;
                delete writing.latestOperation;
            }
            if (phone)
                this.unindex(oldest, phone);
        }
    }
    /** Drop a lid from its phone's reverse entry, and the entry itself once no lid is left under it. */
    unindex(lid, phone) {
        const set = this.phoneToLids.get(phone);
        if (set?.delete(lid) && set.size === 0)
            this.phoneToLids.delete(phone);
    }
};
exports.LidMappingStoreService = LidMappingStoreService;
exports.LidMappingStoreService = LidMappingStoreService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(lid_mapping_entity_1.LidMapping, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository])
], LidMappingStoreService);
