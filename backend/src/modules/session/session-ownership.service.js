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
exports.nodeOwnsSession = exports.SessionOwnershipService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const config_1 = require("@nestjs/config");
const node_os_1 = require("node:os");
const typeorm_2 = require("typeorm");
const session_entity_1 = require("./entities/session.entity");
const logger_service_1 = require("../../common/services/logger.service");
const date_transformer_1 = require("../../common/transformers/date.transformer");
const shared_connection_1 = require("../../common/utils/shared-connection");
/**
 * Bind a lease timestamp the way the column stores it.
 *
 * Raw SQL bypasses the column's transformer, and the stored form is not a Date on every dialect —
 * SQLite keeps an ISO string — so an untransformed parameter compares against the wrong
 * representation and the clause silently never matches.
 */
function leaseParam(at) {
    // `to` is declared to accept a nullable Date and so returns a nullable union; a real Date always
    // comes back as one of the two stored forms.
    return date_transformer_1.DateTransformer.to(at) ?? at;
}
/**
 * Who currently hosts each session's engine.
 *
 * A session's engine runs in exactly one process. Nothing recorded which, so a booting process had
 * to assume every active-looking session was its own leftover and reset it — correct while there is
 * only one process, and destructive the moment a second one boots beside a live peer.
 *
 * The claim is a lease rather than a lock. A process that dies without releasing would otherwise
 * strand its sessions forever, so a claim simply stops being honoured once it goes unrenewed; a
 * running owner keeps extending it. That makes recovery automatic and bounded by the TTL instead of
 * conditional on a clean shutdown.
 *
 * NOTE: this establishes ownership. Forwarding a request to the owning node is SessionProxyInterceptor's
 * job (opt-in via NODE_URL); see the horizontal-scaling documentation for what remains.
 */
let SessionOwnershipService = class SessionOwnershipService {
    sessions;
    configService;
    logger = (0, logger_service_1.createLogger)('SessionOwnershipService');
    heartbeat;
    /** Sessions this process believes it owns, so the heartbeat knows what to renew. */
    owned = new Set();
    /**
     * A fresh value from claimSeq on every new ownership, dropped when the claim ends, so renew() can tell a
     * claim it read from one replaced since. One sequence for all sessions: a per-session counter
     * restarting after a release could repeat the value a tick had read.
     */
    claimGen = new Map();
    claimSeq = 0;
    /** Notified when a renewal proves this process no longer holds sessions it thought it did. */
    onLeaseLost;
    /** Notified when this process takes a session over from a node whose lease lapsed. See onAdoption. */
    onAdopted;
    /**
     * How many callers are currently telling renew() that an empty/blank result is NOT evidence of
     * loss. A counter rather than a flag so overlapping spans cannot resume each other early.
     */
    lossDetectionSuspended = 0;
    /** Answers "does anything still run for this id here?" — consulted by renew(). See setEngineLiveness. */
    engineLiveness;
    /**
     * Duplicate-NODE_ID detection (see noteForeignRenewals): the lease expiry this process last wrote
     * or saw per row under its nodeId, how many consecutive ticks it changed without this process
     * writing it, and whether the duplicate has been reported.
     */
    lastSeenLease = new Map();
    foreignStreak = new Map();
    duplicateReported = false;
    constructor(sessions, configService) {
        this.sessions = sessions;
        this.configService = configService;
    }
    /**
     * This process's identity, stable across restarts.
     *
     * Deliberately not tied to the pid: a restarted process must recognise its own previous rows in
     * order to reset them, and a pid never matches after a restart. The hostname is stable for the
     * lifetime of a container or a host; where that is not the right boundary, `NODE_ID` overrides it.
     * It must also be unique per running process: two processes sharing a hostname (host networking,
     * pm2 cluster mode, two instances on one host) must each set `NODE_ID`, or each treats the other's
     * sessions as its own. renew() detects that and logs `duplicate_node_id`.
     */
    get nodeId() {
        return this.configService?.get('session.nodeId') || process.env.NODE_ID || (0, node_os_1.hostname)();
    }
    /** Where this node answers HTTP for peers; empty when the operator has not configured routing. */
    get nodeUrl() {
        return this.configService?.get('session.nodeUrl') || process.env.NODE_URL || '';
    }
    /** Public because the takeover sweep sizes its "this holder is really gone" cutoff against it. */
    get leaseTtlMs() {
        return this.configService?.get('session.leaseTtlMs') ?? 60_000;
    }
    get heartbeatMs() {
        return this.configService?.get('session.leaseHeartbeatMs') ?? 20_000;
    }
    /**
     * A session is takeable when nobody holds it, when this process already holds it, or when the
     * holder's lease has lapsed. Expressed as a `where` fragment so the same rule drives the boot
     * reset, the auto-start scan and the claim itself — three places that must not disagree.
     */
    claimableWhere(now = new Date()) {
        return [{ nodeId: (0, typeorm_2.IsNull)() }, { nodeId: this.nodeId }, { leaseExpiresAt: (0, typeorm_2.LessThan)(now) }];
    }
    /** Session ids this process may take over, out of the ones given. */
    async claimable(ids) {
        if (ids.length === 0)
            return [];
        const rows = await this.sessions.find({
            where: this.claimableWhere().map(clause => ({ ...clause, id: (0, typeorm_2.In)(ids) })),
            select: { id: true },
        });
        return rows.map(row => row.id);
    }
    /**
     * Take ownership, returning false when a live peer holds it or a newer local claim supersedes it.
     *
     * The update is conditional on the same predicate the read used, so two processes racing on the
     * same free session cannot both succeed: the second one's UPDATE matches no row, because the
     * first has already written its own `nodeId` and a future expiry. Deciding on the read alone
     * would let both pass.
     */
    async claim(sessionId, onClaimed) {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + this.leaseTtlMs);
        // A successful SQL write may still await its reply; a local overlap shares that ownership too.
        if (this.owned.has(sessionId) || this.claimGen.has(sessionId)) {
            const generation = this.claimGen.get(sessionId);
            const renewed = await this.sessions.update({ id: sessionId, nodeId: this.nodeId }, { leaseExpiresAt });
            if (this.claimGen.get(sessionId) !== generation)
                return false;
            if (renewed.affected === 1) {
                this.owned.add(sessionId);
                if (!this.claimGen.has(sessionId))
                    this.claimGen.set(sessionId, ++this.claimSeq);
                this.lastSeenLease.set(sessionId, leaseExpiresAt.getTime());
                onClaimed?.(this.captureClaim(sessionId));
                return true;
            }
        }
        // Allocate before the awaited write: an older SQL reply cannot replace a newer local ownership.
        const generation = ++this.claimSeq;
        this.claimGen.set(sessionId, generation);
        let followUp = false;
        const claimed = await this.withAdoption(async (sessions, manager) => {
            // Keep the previous owner, transition and SQL cleanup in one row-locked transaction.
            if (manager) {
                await sessions
                    .createQueryBuilder()
                    .update(session_entity_1.Session)
                    .set({ updatedAt: () => '"updatedAt"' })
                    .where({ id: sessionId })
                    .execute();
            }
            const previous = this.onAdopted
                ? await sessions.findOne({ where: { id: sessionId }, select: { id: true, nodeId: true, leaseExpiresAt: true } })
                : null;
            if (this.claimGen.get(sessionId) !== generation)
                return false;
            const result = await sessions
                .createQueryBuilder()
                .update(session_entity_1.Session)
                .set({ nodeId: this.nodeId, claimedAt: now, leaseExpiresAt, nodeUrl: this.nodeUrl || null })
                .where('id = :id', { id: sessionId })
                .andWhere('("nodeId" IS NULL OR "nodeId" = :me OR "leaseExpiresAt" < :now)', {
                me: this.nodeId,
                now: leaseParam(now),
            })
                .execute();
            if (this.claimGen.get(sessionId) !== generation)
                return false;
            const claimed = (result.affected ?? 0) > 0;
            const adopted = claimed &&
                previous?.nodeId != null &&
                previous.nodeId !== this.nodeId &&
                previous.leaseExpiresAt != null &&
                previous.leaseExpiresAt < now;
            if (adopted) {
                if (manager)
                    await this.followAdoption(sessionId, manager);
                else
                    followUp = true;
            }
            return claimed;
        }).catch(async (error) => {
            if (this.claimGen.get(sessionId) === generation) {
                if (this.owned.has(sessionId))
                    await this.renew();
                else
                    this.claimGen.delete(sessionId);
            }
            throw error;
        });
        if (this.claimGen.get(sessionId) !== generation)
            return false;
        if (claimed) {
            this.owned.add(sessionId);
            this.lastSeenLease.set(sessionId, leaseExpiresAt.getTime());
            onClaimed?.(this.captureClaim(sessionId));
            if (followUp)
                void this.followAdoption(sessionId);
        }
        else {
            // Reconcile an existing claim through the heartbeat's loss checks, preserving a successful overlap.
            if (this.owned.has(sessionId))
                await this.renew();
            else
                this.claimGen.delete(sessionId);
            this.logger.warn('Session is held by another node', { sessionId, nodeId: this.nodeId });
        }
        return claimed;
    }
    /** Renew this node's claim and clear only the record this start read; never reclaim a released row. */
    async prepareStart(sessionId, desiredState) {
        const now = new Date();
        const leaseExpiresAt = new Date(now.getTime() + this.leaseTtlMs);
        const { affected } = await this.sessions.update({
            id: sessionId,
            nodeId: this.nodeId,
            leaseExpiresAt: (0, typeorm_2.MoreThan)(now),
            desiredState: desiredState ?? (0, typeorm_2.IsNull)(),
        }, { desiredState: null, leaseExpiresAt });
        // Even a successful write can return too late to admit an engine on the renewal it wrote.
        if (affected !== 1 || leaseExpiresAt <= new Date())
            return false;
        this.lastSeenLease.set(sessionId, leaseExpiresAt.getTime());
        return true;
    }
    /** Record a stop and release an abandoned foreign claim without letting its heartbeat revive it. */
    async stopExpiredForeignClaim(sessionId) {
        const foreign = {
            id: sessionId,
            nodeId: (0, typeorm_2.Not)(this.nodeId),
            desiredState: (0, typeorm_2.Or)((0, typeorm_2.IsNull)(), (0, typeorm_2.Not)((0, typeorm_2.In)(['deleting', 'deleting-stopped']))),
        };
        return this.withAdoption(async (sessions, manager) => {
            const { affected } = await sessions.update([
                { ...foreign, leaseExpiresAt: (0, typeorm_2.IsNull)() },
                { ...foreign, leaseExpiresAt: (0, typeorm_2.LessThanOrEqual)(new Date()) },
            ], { desiredState: 'stopped', nodeId: null, claimedAt: null, leaseExpiresAt: null, nodeUrl: null });
            if (affected !== 1)
                return false;
            await this.followAdoption(sessionId, manager);
            return true;
        });
    }
    /**
     * Give a session up, so a peer can take it without waiting for the lease to lapse.
     *
     * Clears a LAPSED foreign claim too, on the same predicate `claim()` uses. A deliberate teardown
     * (stop/logout/delete) of a session whose crashed owner's lease has expired must actually leave
     * it down: a row still naming the dead node reads as an abandoned orphan to the takeover sweep,
     * which would adopt and restart the session the operator just stopped. A LIVE foreign claim is
     * left alone — releasing that would strand a peer's running engine.
     */
    async release(sessionId, ownsClaim) {
        if (ownsClaim) {
            const dataSource = this.sessions.manager.connection;
            if (!(await (0, shared_connection_1.awaitNoOpenTransaction)(dataSource)))
                throw new Error('Another database transaction stayed open');
            await dataSource.transaction(async (manager) => {
                // A delete releases only its captured ownership, even when a peer's newer lease has expired.
                const { affected } = await manager
                    .createQueryBuilder()
                    .update(session_entity_1.Session)
                    .set({ nodeId: this.nodeId, updatedAt: () => '"updatedAt"' })
                    .where({ id: sessionId, nodeId: this.nodeId })
                    .execute();
                // Check after the lock: a same-node start may have completed while this statement waited.
                if (!ownsClaim())
                    return;
                if (affected === 1) {
                    await manager.update(session_entity_1.Session, { id: sessionId, nodeId: this.nodeId }, { nodeId: null, claimedAt: null, leaseExpiresAt: null, nodeUrl: null });
                }
                if (ownsClaim()) {
                    this.owned.delete(sessionId);
                    this.claimGen.delete(sessionId);
                }
            });
            return;
        }
        const now = new Date();
        this.owned.delete(sessionId);
        this.claimGen.delete(sessionId);
        const cleared = { nodeId: null, claimedAt: null, leaseExpiresAt: null, nodeUrl: null };
        // Its own claim first, in one statement as before. Only when that matched nothing is a lapsed
        // claim of another node cleared, and that is a takeover like a claim: the dead holder's
        // unfinished work is failed too (see onAdoption).
        const own = await this.sessions
            .createQueryBuilder()
            .update(session_entity_1.Session)
            .set({
            ...cleared,
            desiredState: () => `CASE WHEN "desiredState" = 'deleting-stopped' THEN 'stopped' ELSE "desiredState" END`,
        })
            .where('id = :id', { id: sessionId })
            .andWhere('"nodeId" = :me', { me: this.nodeId })
            .execute();
        if ((own.affected ?? 0) > 0)
            return;
        await this.withAdoption(async (sessions, manager) => {
            const lapsed = await sessions
                .createQueryBuilder()
                .update(session_entity_1.Session)
                .set(cleared)
                .where('id = :id', { id: sessionId })
                .andWhere('"nodeId" IS NOT NULL AND "nodeId" <> :me AND "leaseExpiresAt" < :now', {
                me: this.nodeId,
                now: leaseParam(now),
            })
                .andWhere('("desiredState" IS NULL OR "desiredState" NOT IN (:...deleting))', {
                deleting: ['deleting', 'deleting-stopped'],
            })
                .execute();
            if ((lapsed.affected ?? 0) > 0)
                await this.followAdoption(sessionId, manager);
        });
    }
    /**
     * Release everything this process holds, on the way down, except `keep`: claims whose engine may
     * still be alive. Those are left to lapse, since the heartbeat has stopped.
     */
    async releaseAll(keep = []) {
        const kept = new Set(keep);
        const ids = [...this.owned].filter(id => !kept.has(id));
        for (const id of ids) {
            this.owned.delete(id);
            this.claimGen.delete(id);
        }
        if (ids.length === 0)
            return;
        await this.sessions
            .createQueryBuilder()
            .update(session_entity_1.Session)
            .set({ nodeId: null, claimedAt: null, leaseExpiresAt: null, nodeUrl: null })
            .where({ id: (0, typeorm_2.In)(ids), nodeId: this.nodeId })
            .execute();
        this.logger.log(`Released ${ids.length} session claim(s) on shutdown`, { nodeId: this.nodeId });
    }
    /** Begin renewing this process's leases. Idempotent. */
    startHeartbeat() {
        if (this.heartbeat)
            return;
        this.heartbeat = setInterval(() => {
            void this.renew();
        }, this.heartbeatMs);
        // Never hold the process open: a lease that stops being renewed is exactly what shutdown means.
        this.heartbeat.unref?.();
    }
    stopHeartbeat() {
        if (!this.heartbeat)
            return;
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
    }
    /**
     * Register what to do about a session this process has lost.
     *
     * Losing a lease is not an abstract bookkeeping event: a peer is now free to claim the session,
     * and if this process keeps its engine running there are two engines on one WhatsApp account —
     * the exact outcome the claim exists to prevent. The handler is how the engine gets torn down.
     */
    onLeaseLoss(handler) {
        this.onLeaseLost = handler;
    }
    /**
     * Register what to do when this process takes a session over from a node whose lease lapsed, by
     * claiming it (an explicit start, boot auto-start, the takeover sweep, a delete) or by releasing
     * that node's claim (a stop of such a session). Whatever that node left unfinished for the
     * session can no longer finish there. A session its holder released is not taken over: that holder
     * may still be finishing its own work.
     */
    onAdoption(handler, transactional = false) {
        this.onAdopted = { run: handler, transactional };
    }
    /** SQL adoption cleanup shares the ownership transition; arbitrary follow-ups remain detached. */
    async withAdoption(work) {
        if (!this.onAdopted?.transactional)
            return work(this.sessions);
        const dataSource = this.sessions.manager.connection;
        if (!(await (0, shared_connection_1.awaitNoOpenTransaction)(dataSource)))
            throw new Error('Another database transaction stayed open');
        return dataSource.transaction(manager => work(manager.getRepository(session_entity_1.Session), manager));
    }
    /** Isolate SQL errors where they abort the transaction, while keeping successful ownership changes. */
    async followAdoption(sessionId, manager) {
        const handler = this.onAdopted;
        if (!handler)
            return;
        const failed = (error) => {
            this.logger.warn('Session adoption follow-up failed', {
                sessionId,
                error: error instanceof Error ? error.message : String(error),
            });
        };
        if (manager && handler.transactional) {
            if (shared_connection_1.SHARED_CONNECTION_DIALECTS.has(manager.connection.options.type)) {
                // SQLite statement errors keep the transaction usable. Rolling back a savepoint would also
                // undo unrelated writes that used this shared connection while cleanup awaited its queries.
                try {
                    await handler.run(sessionId, manager);
                }
                catch (error) {
                    failed(error);
                }
            }
            else {
                await manager.transaction(nested => handler.run(sessionId, nested)).catch(failed);
            }
        }
        else {
            void Promise.resolve()
                .then(() => handler.run(sessionId))
                .catch(failed);
        }
    }
    /**
     * Tell renew() that "this node no longer holds the row" is currently uninformative, and get back
     * the release. Held by a replace-all data import across its whole transaction.
     *
     * Why it is needed: on SQLite every TypeORM query runner shares ONE connection, so a heartbeat
     * tick can execute INSIDE the import's open transaction, after its DELETE and before its
     * re-inserts commit, and see no rows at all. Concluding loss there tears down engines that never
     * stopped — and does so even when the import later rolls back and every row comes straight back.
     *
     * Returns a release rather than exposing a resume(), so the count cannot be unbalanced by a caller
     * that forgets which spans it opened; releasing the same token twice is a no-op.
     */
    suspendLossDetection() {
        this.lossDetectionSuspended++;
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.lossDetectionSuspended--;
        };
    }
    /**
     * Register the probe renew() consults before extending a lease. Wired by SessionService to the
     * engine lifecycle (engine registered, start in flight, reconnect pending, or delete in flight).
     * Optional like the lease-loss handler: without it every held claim renews unconditionally.
     */
    setEngineLiveness(probe) {
        this.engineLiveness = probe;
    }
    /**
     * Push every held lease out by another TTL, and find out whether any were lost.
     *
     * A lease can lapse while this process is perfectly healthy — a slow query or a long pause is
     * enough — after which a peer may legitimately take the session. Renewal is therefore also the
     * moment to notice, because it is the only regular contact with the row.
     */
    async renew() {
        const held = [...this.owned];
        const heldGen = new Map(held.map(id => [id, this.claimGen.get(id)]));
        // Only claims that still cover something alive on this process are pushed out. A claim whose
        // engine is gone (a failed start, an exhausted reconnect) must be allowed to lapse — renewing
        // it unconditionally pinned such sessions to this node forever: unstartable on any peer and
        // invisible to the takeover sweep, which only sees lapsed leases. The id stays in `owned` so
        // the loss is still noticed below once a peer actually takes the row.
        const live = this.engineLiveness ? held.filter(id => this.engineLiveness(id)) : held;
        let kept;
        try {
            // Read BEFORE this tick's own write, so a lease another process renewed under this nodeId is
            // still visible. Runs even when nothing is held: a twin that never claimed must notice too.
            const mine = await this.sessions
                .createQueryBuilder('s')
                .select(['s.id', 's.leaseExpiresAt'])
                .where('s.nodeId = :me', { me: this.nodeId })
                .getMany();
            this.noteForeignRenewals(mine);
            if (held.length === 0)
                return;
            if (live.length > 0) {
                const leaseExpiresAt = new Date(Date.now() + this.leaseTtlMs);
                await this.sessions
                    .createQueryBuilder()
                    .update(session_entity_1.Session)
                    .set({ leaseExpiresAt })
                    .where({ id: (0, typeorm_2.In)(live), nodeId: this.nodeId })
                    .execute();
                for (const id of live)
                    this.lastSeenLease.set(id, leaseExpiresAt.getTime());
            }
            const rows = await this.sessions.find({ where: { id: (0, typeorm_2.In)(held), nodeId: this.nodeId }, select: { id: true } });
            kept = new Set(rows.map(row => row.id));
        }
        catch (error) {
            // A failed renewal is survivable — the next tick tries again, and the TTL is long enough to
            // absorb a transient database blip. Crucially it must NOT be read as having lost anything:
            // concluding loss from a failed query would tear down every healthy engine on this node the
            // first time the database hiccuped, which is far worse than a late renewal.
            this.logger.warn('Failed to renew session leases', {
                nodeId: this.nodeId,
                error: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        // Re-checked HERE, after the queries above rather than only at entry: the tick this protects
        // against is precisely one that was already in flight when the import took the token, so an
        // entry-only check would let it through. Renewing was harmless; concluding loss is not.
        if (this.lossDetectionSuspended > 0)
            return;
        // Only a claim this tick actually read can be lost. One released during the queries (a stop) is
        // gone on purpose, and one released and claimed again (a stop, then a start) may have been read
        // in between: neither was taken by a peer.
        const lost = held.filter(id => !kept.has(id) && this.owned.has(id) && this.claimGen.get(id) === heldGen.get(id));
        if (lost.length === 0)
            return;
        for (const id of lost) {
            this.owned.delete(id);
            this.claimGen.delete(id);
        }
        this.logger.warn(`Lost the claim on ${lost.length} session(s); another node now holds them`, {
            nodeId: this.nodeId,
            sessionIds: lost,
        });
        try {
            await this.onLeaseLost?.(lost);
        }
        catch (error) {
            // Renewal is driven by an interval, so a throwing handler would surface as an unhandled
            // rejection and could stop the loop entirely. The sessions are already out of `owned`, so the
            // bookkeeping is consistent either way — what a failure here means is that an engine may
            // still be running for a session this node no longer owns, which is worth an error rather
            // than a crash.
            this.logger.error('Failed to release engines for lost sessions', error instanceof Error ? error.stack : '', {
                nodeId: this.nodeId,
                sessionIds: lost,
            });
        }
    }
    /**
     * Notice another process renewing leases under this nodeId. A lease expiry that changed without
     * this process writing it, on two consecutive ticks, can only be a live twin: it renews every
     * heartbeat. A one-off change (a data import carrying leases forward, a claim racing a renewal)
     * resets on the next tick, and a previous incarnation's lapsed or static lease never changes.
     * Reported once per process. Detection only: nothing is refused on it.
     */
    noteForeignRenewals(rows) {
        if (this.lossDetectionSuspended > 0) {
            // An import is rewriting the table under this tick; start over once it is done.
            this.lastSeenLease.clear();
            this.foreignStreak.clear();
            return;
        }
        const now = Date.now();
        const seen = new Set();
        const flagged = [];
        for (const row of rows) {
            const at = row.leaseExpiresAt?.getTime();
            if (at === undefined || at <= now)
                continue;
            seen.add(row.id);
            const prev = this.lastSeenLease.get(row.id);
            const streak = prev !== undefined && prev !== at ? (this.foreignStreak.get(row.id) ?? 0) + 1 : 0;
            this.foreignStreak.set(row.id, streak);
            this.lastSeenLease.set(row.id, at);
            if (streak >= 2)
                flagged.push(row.id);
        }
        for (const id of [...this.lastSeenLease.keys()]) {
            if (seen.has(id))
                continue;
            this.lastSeenLease.delete(id);
            this.foreignStreak.delete(id);
        }
        if (flagged.length === 0 || this.duplicateReported)
            return;
        this.duplicateReported = true;
        this.logger.error('Another process is renewing session leases under this NODE_ID; set a unique NODE_ID per process', undefined, { action: 'duplicate_node_id', nodeId: this.nodeId, sessionIds: flagged });
    }
    /**
     * Sessions another node held whose lease has lapsed — a crashed peer, or this node's own
     * previous identity after a container recreate (the default nodeId is the hostname, which a
     * recreate changes). These are the adoptable orphans the takeover sweep starts here; a
     * deliberately released session (stop, graceful shutdown) has `nodeId` NULL and is not one.
     */
    async lapsedHeldByOthers(now = new Date()) {
        return this.sessions
            .createQueryBuilder('session')
            .where('"nodeId" IS NOT NULL AND "nodeId" <> :me', { me: this.nodeId })
            .andWhere('"leaseExpiresAt" < :now', { now: leaseParam(now) })
            .getMany();
    }
    /**
     * Whether ONE session is held by another node on a live lease.
     *
     * The scoped counterpart of {@link heldByOtherNodes}, for the lifecycle verbs that act on a single
     * id: they only need this answer, and scanning every claim to get it would grow with the whole
     * deployment. A LAPSED foreign claim reads false — the holder may be gone, and taking over is
     * exactly what the claim rule allows.
     */
    async isHeldByOtherNode(sessionId, now = new Date()) {
        const count = await this.sessions
            .createQueryBuilder('session')
            .where('id = :id', { id: sessionId })
            .andWhere('"nodeId" IS NOT NULL AND "nodeId" <> :me', { me: this.nodeId })
            .andWhere('"leaseExpiresAt" > :now', { now: leaseParam(now) })
            .getCount();
        return count > 0;
    }
    /** {@link isHeldByOtherNode} for a row already loaded, so a list can answer it without a query per row. */
    heldByOtherLiveNode(session, now = new Date()) {
        return (session.nodeId != null &&
            session.nodeId !== this.nodeId &&
            session.leaseExpiresAt != null &&
            session.leaseExpiresAt > now);
    }
    /**
     * Session ids another node currently holds on a live lease.
     *
     * For operations that can only act on this process's own engines and would otherwise report
     * success over work they never touched.
     */
    async heldByOtherNodes(now = new Date()) {
        const rows = await this.sessions
            .createQueryBuilder('session')
            .select('session.id', 'id')
            .where('"nodeId" IS NOT NULL AND "nodeId" <> :me', { me: this.nodeId })
            .andWhere('"leaseExpiresAt" > :now', { now: leaseParam(now) })
            .getRawMany();
        return rows.map(row => row.id);
    }
    /** Test seam: what this process currently believes it holds. */
    ownedIds() {
        return [...this.owned];
    }
    /** Capture this ownership, including a loss and reacquisition under the same node id. */
    captureClaim(sessionId) {
        const generation = this.claimGen.get(sessionId);
        return () => generation !== undefined && this.owned.has(sessionId) && this.claimGen.get(sessionId) === generation;
    }
    /**
     * Does THIS process still hold `sessionId`? Synchronous and in-memory on purpose.
     *
     * Callers are engine callbacks on the hot path that must not introduce an await: an extra
     * suspension point there would re-open the very retirement race the surrounding `isLiveEngine`
     * fence closes. The in-memory set is also the right authority here — it is what `renew()` clears
     * the moment it observes the claim is gone, which is exactly the transition this answers.
     *
     * The two fences are orthogonal and both are needed. `isLiveEngine` asks "is this engine object
     * still the registered one" (generation safety, local); this asks "may this node still speak for
     * the session at all" (ownership, cluster-wide). Between losing a lease and finishing the teardown
     * the heartbeat schedules, the first is still true while the second is already false.
     */
    owns(sessionId) {
        return this.owned.has(sessionId);
    }
};
exports.SessionOwnershipService = SessionOwnershipService;
exports.SessionOwnershipService = SessionOwnershipService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(session_entity_1.Session, 'data')),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        config_1.ConfigService])
], SessionOwnershipService);
/**
 * "May this node write for `sessionId`?" with the no-ownership case decided in one place.
 *
 * Exported as a function rather than inlined at the call sites because the DEFAULT is the part that
 * carries the risk. Note what it does NOT mean: SessionOwnershipService is an unconditional provider
 * in SessionModule, so a running gateway ALWAYS has one and this fence is live in single-node
 * deployments too — every started session is claimed there, so `owns()` answers truthfully. The TRUE
 * default therefore serves direct-construction specs, not production. Inverting it would silence
 * every engine-driven status write everywhere instead of fencing a few — a far worse failure than
 * the one the fence exists to prevent, and invisible without a test that pins the default.
 */
const nodeOwnsSession = (ownership, sessionId) => !ownership || ownership.owns(sessionId);
exports.nodeOwnsSession = nodeOwnsSession;
