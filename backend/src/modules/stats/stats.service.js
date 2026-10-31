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
exports.StatsService = void 0;
exports.timeSeriesTimestampSql = timeSeriesTimestampSql;
exports.hourBucketSql = hourBucketSql;
exports.maxCreatedAtSql = maxCreatedAtSql;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const config_1 = require("@nestjs/config");
const typeorm_2 = require("typeorm");
const session_entity_1 = require("../session/entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
/**
 * SQL for the time-series timestamp bucket, per DB dialect. SQLite has strftime(); Postgres has
 * neither strftime nor a case-insensitive bare `m.createdAt` (unquoted it folds to lowercase and
 * misses the quoted "createdAt" column) — so it needs to_char() with a quoted column. The hour
 * format yields an identical zero-padded, chronologically-sortable label on both engines, so the
 * GROUP BY/ORDER BY on the alias and the downstream map() are unchanged.
 */
function timeSeriesTimestampSql(dbType, interval) {
    if (dbType === 'postgres') {
        const fmt = interval === 'hour' ? 'YYYY-MM-DD HH24:00:00' : 'YYYY-MM-DD';
        return `to_char(m."createdAt", '${fmt}')`;
    }
    const fmt = interval === 'hour' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d';
    return `strftime('${fmt}', m.createdAt)`;
}
/** SQL for the integer hour-of-day (0-23) bucket, per DB dialect. */
function hourBucketSql(dbType) {
    return dbType === 'postgres'
        ? `CAST(EXTRACT(HOUR FROM m."createdAt") AS INTEGER)`
        : `CAST(strftime('%H', m.createdAt) AS INTEGER)`;
}
/**
 * SQL for the most-recent-activity timestamp (MAX of createdAt) as an identical text format on both
 * engines. SQLite's MAX over a `datetime` column returns the stored text; Postgres returns a timestamp
 * the driver hydrates to a JS Date (serialized to a different ISO string). to_char/strftime pin both
 * to `YYYY-MM-DD HH:MM:SS`, matching the format the time-series buckets already use, so the lastActive
 * field is stable regardless of the backing database.
 */
function maxCreatedAtSql(dbType) {
    return dbType === 'postgres'
        ? `to_char(MAX(m."createdAt"), 'YYYY-MM-DD HH24:MI:SS')`
        : `strftime('%Y-%m-%d %H:%M:%S', MAX(m.createdAt))`;
}
/**
 * SQL for a top chat's label. `chatName` holds the SENDER's push name, not the chat's: MAX over a group's
 * rows named the group after whichever member sorts last. Only a 1:1 chat's inbound rows carry the name
 * of the chat itself, so groups get null and the dashboard falls back to the chat id.
 *
 * The chat id is tested first on purpose: it is in the chatId indexes, so SQLite answers a group's row
 * without seeking the table row that `direction` and `chatName` live in, which on a table of large rows
 * is most of the cost (1.7 s down to 0.6 s over 59k messages, most of them in groups).
 */
const chatLabelSql = (alias) => `MAX(CASE WHEN ${alias}.chatId NOT LIKE '%@g.us' AND ${alias}.direction = '${message_entity_1.MessageDirection.INCOMING}' THEN ${alias}.chatName END)`;
let StatsService = class StatsService {
    sessionRepo;
    messageRepo;
    configService;
    /**
     * In-process TTL memo for the aggregate responses, keyed by query shape ('overview',
     * 'messages:<period>', 'session:<id>'). The aggregates run GROUP BY scans over the whole
     * messages table — on the default SQLite backend synchronously on the event loop — so
     * dashboard polling would otherwise re-run them on every request. TTL-only invalidation:
     * entries expire after stats.cacheTtlMs; there is no write-path hook. Session-scoped entries
     * are additionally re-validated on serve (getSessionStats), so a deleted session is not
     * resurrected from the memo. Every finished computation also drops the entries that have expired, so
     * the entries of deleted sessions nobody asks for again do not accumulate. Concurrent misses
     * on one key share a single computation (`inflight`), so an expired entry costs one scan, not one
     * per waiting request; a rejection is handed to every waiter and never stored.
     */
    memo = new Map();
    inflight = new Map();
    constructor(sessionRepo, messageRepo, configService) {
        this.sessionRepo = sessionRepo;
        this.messageRepo = messageRepo;
        this.configService = configService;
    }
    /** The data-connection dialect ('sqlite' | 'postgres'), used to pick portable date SQL. */
    get dataDbType() {
        return this.messageRepo.manager.dataSource.options.type;
    }
    /** Memo TTL in ms; 0 disables memoization (every request hits the DB). Read per call. */
    get memoTtlMs() {
        return this.configService.get('stats.cacheTtlMs', 30000);
    }
    /**
     * Returns the memoized value for `key` while fresh; otherwise joins the computation already
     * running for it, or starts one. The TTL runs from completion, so a scan slower than the TTL does
     * not store an entry that is already stale. The identity check keeps a flight that was dropped
     * (getSessionStats on a deleted session) from writing its result back.
     */
    memoized(key, compute) {
        const ttl = this.memoTtlMs;
        if (ttl <= 0)
            return compute();
        const hit = this.memo.get(key);
        if (hit && hit.expiresAt > Date.now())
            return Promise.resolve(hit.value);
        const pending = this.inflight.get(key);
        if (pending)
            return pending;
        const flight = compute().then(value => {
            if (this.inflight.get(key) === flight) {
                this.inflight.delete(key);
                const now = Date.now();
                for (const [memoKey, entry] of this.memo)
                    if (entry.expiresAt <= now)
                        this.memo.delete(memoKey);
                this.memo.set(key, { expiresAt: now + ttl, value });
            }
            return value;
        }, (err) => {
            if (this.inflight.get(key) === flight)
                this.inflight.delete(key);
            throw err;
        });
        this.inflight.set(key, flight);
        return flight;
    }
    async getOverview() {
        return this.memoized('overview', () => this.loadOverview());
    }
    async loadOverview() {
        // Get session stats
        const sessions = await this.sessionRepo.find();
        const byStatus = {};
        let active = 0;
        for (const session of sessions) {
            byStatus[session.status] = (byStatus[session.status] || 0) + 1;
            if (session.status === session_entity_1.SessionStatus.READY)
                active++;
        }
        // Get message stats
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const messageStats = await this.messageRepo
            .createQueryBuilder('m')
            .select('m.direction', 'direction')
            .addSelect('COUNT(*)', 'count')
            .groupBy('m.direction')
            .getRawMany();
        const todayStats = await this.messageRepo
            .createQueryBuilder('m')
            .select('m.direction', 'direction')
            .addSelect('COUNT(*)', 'count')
            .where('m.createdAt >= :todayStart', { todayStart })
            .groupBy('m.direction')
            .getRawMany();
        const sent = parseInt(messageStats.find(m => m.direction === 'outgoing')?.count || '0');
        const received = parseInt(messageStats.find(m => m.direction === 'incoming')?.count || '0');
        const todaySent = parseInt(todayStats.find(m => m.direction === 'outgoing')?.count || '0');
        const todayReceived = parseInt(todayStats.find(m => m.direction === 'incoming')?.count || '0');
        // Count failed messages
        const failed = await this.messageRepo.count({
            where: { status: message_entity_1.MessageStatus.FAILED },
        });
        return {
            sessions: {
                active,
                total: sessions.length,
                byStatus,
            },
            messages: {
                sent,
                received,
                failed,
                today: { sent: todaySent, received: todayReceived },
            },
        };
    }
    async getMessageStats(period) {
        return this.memoized(`messages:${period}`, () => this.loadMessageStats(period));
    }
    async loadMessageStats(period) {
        const since = this.getPeriodStart(period);
        const interval = period === '24h' ? 'hour' : 'day';
        // Time series - using raw query for SQLite compatibility
        const timeSeries = await this.getTimeSeries(since, interval);
        // By type. Rows with no body AND no metadata are content-less system/event rows (e.g. @lid
        // privacy-user events the engine maps to `unknown`) — counting them would put a misleading
        // "unknown" slice in the by-type chart, so they're excluded from the aggregation.
        const byTypeRaw = await this.messageRepo
            .createQueryBuilder('m')
            .select('m.type', 'type')
            .addSelect('COUNT(*)', 'count')
            .where('m.createdAt >= :since', { since })
            // Parenthesized: TypeORM does not wrap an andWhere, so a bare OR would escape the period bound.
            .andWhere("((m.body IS NOT NULL AND m.body != '') OR m.metadata IS NOT NULL)")
            .groupBy('m.type')
            .getRawMany();
        const byType = {};
        for (const row of byTypeRaw) {
            byType[row.type || 'unknown'] = parseInt(row.count);
        }
        // By session
        const bySessionRaw = await this.messageRepo
            .createQueryBuilder('m')
            .select('m.sessionId', 'sessionId')
            .addSelect('m.direction', 'direction')
            .addSelect('COUNT(*)', 'count')
            .where('m.createdAt >= :since', { since })
            .groupBy('m.sessionId')
            .addGroupBy('m.direction')
            .getRawMany();
        const sessionMap = new Map();
        for (const row of bySessionRaw) {
            if (!sessionMap.has(row.sessionId)) {
                sessionMap.set(row.sessionId, { sent: 0, received: 0 });
            }
            const entry = sessionMap.get(row.sessionId);
            if (row.direction === 'outgoing')
                entry.sent = parseInt(row.count);
            else
                entry.received = parseInt(row.count);
        }
        const sessions = await this.sessionRepo.find();
        const sessionNames = new Map(sessions.map(s => [s.id, s.name]));
        const bySession = Array.from(sessionMap.entries()).map(([sessionId, stats]) => ({
            sessionId,
            name: sessionNames.get(sessionId) || 'Unknown',
            ...stats,
        }));
        const topChats = await this.getTopChats(since);
        return {
            timeSeries,
            byType,
            bySession,
            topChats: topChats.map(c => ({
                chatId: c.chatId,
                chatName: c.chatName ?? null,
                messageCount: parseInt(c.messageCount),
            })),
        };
    }
    /** The ten chats with the most messages since `since`, each 1:1 chat with its name. */
    async getTopChats(since) {
        if (this.dataDbType === 'postgres') {
            return (this.messageRepo
                .createQueryBuilder('m')
                .select('m.chatId', 'chatId')
                .addSelect('COUNT(*)', 'messageCount')
                .addSelect(chatLabelSql('m'), 'chatName')
                .where('m.createdAt >= :since', { since })
                .groupBy('m.chatId')
                // Order by the aggregate expression, not the "messageCount" alias: Postgres folds an unquoted
                // ORDER BY messageCount to lowercase and 42703s against the quoted alias.
                .orderBy('COUNT(*)', 'DESC')
                .limit(10)
                .getRawMany());
        }
        // SQLite keeps no statistics, so for GROUP BY m.chatId it reads the whole table in chatId index order
        // rather than the createdAt range, however narrow: 3.2 s over 59k messages for a window of 306, and
        // better-sqlite3 runs it on the event loop, so every request waits. Materializing the window first
        // makes the createdAt index drive the read (21 ms for the same window). The window is still built by
        // the query builder, which formats the date parameter the way the column is stored; the TypeORM SQLite
        // driver cannot emit the MATERIALIZED keyword itself.
        const [window, params] = this.messageRepo
            .createQueryBuilder('m')
            .select('m.chatId', 'chatId')
            .addSelect('m.chatName', 'chatName')
            .addSelect('m.direction', 'direction')
            .where('m.createdAt >= :since', { since })
            .getQueryAndParameters();
        return this.messageRepo.manager.query(`WITH w AS MATERIALIZED (${window}) SELECT w.chatId AS "chatId", COUNT(*) AS "messageCount", ` +
            `${chatLabelSql('w')} AS "chatName" FROM w GROUP BY w.chatId ORDER BY COUNT(*) DESC LIMIT 10`, params);
    }
    async getSessionStats(sessionId) {
        // The memo has no write-path hook, so a `session:<id>` entry can outlive its session row and
        // would keep serving a deleted session's stats until the TTL expires. Re-check existence on
        // every call — a cheap primary-key lookup next to the aggregate scans the memo exists to
        // avoid — and drop the stale entry instead of serving it.
        const key = `session:${sessionId}`;
        if ((await this.sessionRepo.count({ where: { id: sessionId } })) === 0) {
            this.memo.delete(key);
            this.inflight.delete(key);
            throw new common_1.NotFoundException('Session not found');
        }
        return this.memoized(key, () => this.loadSessionStats(sessionId));
    }
    async loadSessionStats(sessionId) {
        const session = await this.sessionRepo.findOne({ where: { id: sessionId } });
        if (!session) {
            throw new common_1.NotFoundException('Session not found');
        }
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        // Message counts
        const stats = await this.messageRepo
            .createQueryBuilder('m')
            .select('m.direction', 'direction')
            .addSelect('COUNT(*)', 'count')
            .where('m.sessionId = :sessionId', { sessionId })
            .groupBy('m.direction')
            .getRawMany();
        const todayCount = await this.messageRepo
            .createQueryBuilder('m')
            .where('m.sessionId = :sessionId', { sessionId })
            .andWhere('m.createdAt >= :todayStart', { todayStart })
            .getCount();
        const sent = parseInt(stats.find(s => s.direction === 'outgoing')?.count || '0');
        const received = parseInt(stats.find(s => s.direction === 'incoming')?.count || '0');
        // Count failed messages for this session
        const failed = await this.messageRepo.count({
            where: { sessionId, status: message_entity_1.MessageStatus.FAILED },
        });
        // Top chats for this session
        const topChats = await this.messageRepo
            .createQueryBuilder('m')
            .select('m.chatId', 'chatId')
            .addSelect('COUNT(*)', 'count')
            .addSelect(maxCreatedAtSql(this.dataDbType), 'lastActive')
            .addSelect(chatLabelSql('m'), 'chatName')
            .where('m.sessionId = :sessionId', { sessionId })
            .groupBy('m.chatId')
            .orderBy('count', 'DESC')
            .limit(10)
            .getRawMany();
        // Hourly activity (last 24h)
        const hourlyActivity = await this.getHourlyActivity(sessionId);
        return {
            session: { id: session.id, name: session.name, status: session.status },
            messages: { sent, received, today: todayCount, failed },
            topChats: topChats.map(c => ({
                chatId: c.chatId,
                chatName: c.chatName ?? null,
                count: parseInt(c.count),
                lastActive: c.lastActive,
            })),
            hourlyActivity,
        };
    }
    getPeriodStart(period) {
        const now = new Date();
        switch (period) {
            case '24h':
                return new Date(now.getTime() - 24 * 60 * 60 * 1000);
            case '7d':
                return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            case '30d':
                return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        }
    }
    async getTimeSeries(since, interval) {
        // Alias the bucket as `bucket`, not `timestamp`: `timestamp` is a reserved type keyword in
        // PostgreSQL, so `GROUP BY timestamp` is not read as the output alias and the query 500s
        // ("column m.createdAt must appear in the GROUP BY"). SQLite tolerates it, hence the dialect-only
        // bug. The API field stays `timestamp` (mapped below).
        const raw = await this.messageRepo
            .createQueryBuilder('m')
            .select(timeSeriesTimestampSql(this.dataDbType, interval), 'bucket')
            .addSelect(`SUM(CASE WHEN m.direction = 'outgoing' THEN 1 ELSE 0 END)`, 'sent')
            .addSelect(`SUM(CASE WHEN m.direction = 'incoming' THEN 1 ELSE 0 END)`, 'received')
            .where('m.createdAt >= :since', { since })
            .groupBy('bucket')
            .orderBy('bucket', 'ASC')
            .getRawMany();
        return raw.map(r => ({
            timestamp: r.bucket,
            sent: parseInt(r.sent || '0'),
            received: parseInt(r.received || '0'),
        }));
    }
    async getHourlyActivity(sessionId) {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const raw = await this.messageRepo
            .createQueryBuilder('m')
            .select(hourBucketSql(this.dataDbType), 'hour')
            .addSelect(`SUM(CASE WHEN m.direction = 'outgoing' THEN 1 ELSE 0 END)`, 'sent')
            .addSelect(`SUM(CASE WHEN m.direction = 'incoming' THEN 1 ELSE 0 END)`, 'received')
            .where('m.sessionId = :sessionId', { sessionId })
            .andWhere('m.createdAt >= :since', { since })
            .groupBy('hour')
            .orderBy('hour', 'ASC')
            .getRawMany();
        // Fill in missing hours
        const result = [];
        const hourMap = new Map(raw.map(r => [parseInt(r.hour), r]));
        for (let h = 0; h < 24; h++) {
            const data = hourMap.get(h);
            result.push({
                hour: h,
                sent: data ? parseInt(data.sent || '0') : 0,
                received: data ? parseInt(data.received || '0') : 0,
            });
        }
        return result;
    }
};
exports.StatsService = StatsService;
exports.StatsService = StatsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(session_entity_1.Session, 'data')),
    __param(1, (0, typeorm_1.InjectRepository)(message_entity_1.Message, 'data')),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        config_1.ConfigService])
], StatsService);
