"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const postgres_utc_1 = require("./postgres-utc");
const infra_data_service_1 = require("../modules/infra/infra-data.service");
const session_entity_1 = require("../modules/session/entities/session.entity");
const webhook_entity_1 = require("../modules/webhook/entities/webhook.entity");
const message_entity_1 = require("../modules/message/entities/message.entity");
const message_batch_entity_1 = require("../modules/message/entities/message-batch.entity");
const template_entity_1 = require("../modules/template/entities/template.entity");
const baileys_stored_message_entity_1 = require("../engine/adapters/baileys-stored-message.entity");
const lid_mapping_entity_1 = require("../engine/identity/lid-mapping.entity");
const baileys_chat_state_entity_1 = require("../engine/adapters/baileys-chat-state.entity");
const plugin_instance_entity_1 = require("../modules/integration/entities/plugin-instance.entity");
const conversation_mapping_entity_1 = require("../modules/integration/entities/conversation-mapping.entity");
const ingress_event_entity_1 = require("../modules/integration/entities/ingress-event.entity");
const webhook_delivery_failure_entity_1 = require("../modules/webhook/entities/webhook-delivery-failure.entity");
const webhook_outbox_event_entity_1 = require("../modules/webhook/entities/webhook-outbox-event.entity");
const webhook_outbox_service_1 = require("../modules/webhook/webhook-outbox.service");
const integration_delivery_failure_entity_1 = require("../modules/integration/entities/integration-delivery-failure.entity");
const status_update_entity_1 = require("../modules/status-store/entities/status-update.entity");
const automation_rule_entity_1 = require("../modules/automation/entities/automation-rule.entity");
const stats_service_1 = require("../modules/stats/stats.service");
/**
 * Runtime proof of the UTC pin against a real PostgreSQL, with the process deliberately OFF UTC.
 *
 * Off UTC the two halves of a row used to disagree: `DEFAULT now()` wrote the server's zone while the
 * driver bound and parsed everything else in the process's zone, so a backup shifted by the offset on
 * every restore and a retention window measured a cutoff that never happened. Everything here fails by
 * exactly that offset if any one of the three pins (bind, parse, session) is removed.
 *
 * Gating: mirrors the repo's PG harness convention (DATABASE_TYPE=postgres, the "Test (PostgreSQL
 * migrations)" CI job); the CI step additionally sets TZ, which the first test asserts rather than
 * trusts, because on a UTC host every assertion below would hold for the wrong reason.
 */
const POSTGRES_ENABLED = process.env.DATABASE_TYPE === 'postgres';
// Fixed uuids: every primary key on this connection is a real uuid column.
const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OLD_ID = '22222222-2222-4222-8222-222222222222';
const YOUNG_ID = '33333333-3333-4333-8333-333333333333';
const BEFORE_ID = '44444444-4444-4444-8444-444444444444';
const AFTER_ID = '55555555-5555-4555-8555-555555555555';
/** An instant as the naive UTC text a pinned server writes into a `timestamp` column. */
const utcWallText = (at) => at.toISOString().replace('T', ' ').replace('Z', '');
const ENTITIES = [
    session_entity_1.Session,
    webhook_entity_1.Webhook,
    message_entity_1.Message,
    message_batch_entity_1.MessageBatch,
    template_entity_1.Template,
    baileys_stored_message_entity_1.BaileysStoredMessage,
    lid_mapping_entity_1.LidMapping,
    baileys_chat_state_entity_1.ChatState,
    plugin_instance_entity_1.PluginInstance,
    conversation_mapping_entity_1.ConversationMapping,
    ingress_event_entity_1.IngressEvent,
    webhook_delivery_failure_entity_1.WebhookDeliveryFailure,
    webhook_outbox_event_entity_1.WebhookOutboxEvent,
    integration_delivery_failure_entity_1.IntegrationDeliveryFailure,
    status_update_entity_1.StatusUpdate,
    automation_rule_entity_1.AutomationRule,
];
/**
 * The `sessions` table as a SQLite deployment holds it: TypeORM's own `datetime` text for the
 * create/update dates, and plain `text` for the columns DateTransformer writes as ISO. Spelled out
 * rather than reusing the entity classes because those resolve their column types from DATABASE_TYPE
 * at import time, which is `postgres` for this suite.
 */
const SqliteSession = new typeorm_1.EntitySchema({
    name: 'SqliteSession',
    tableName: 'sessions',
    columns: {
        id: { primary: true, type: 'varchar' },
        name: { type: 'varchar' },
        status: { type: 'varchar' },
        phone: { type: 'varchar', nullable: true },
        pushName: { type: 'varchar', nullable: true },
        config: { type: 'text' },
        proxyUrl: { type: 'varchar', nullable: true },
        proxyType: { type: 'varchar', nullable: true },
        connectedAt: { type: 'text', nullable: true },
        lastActiveAt: { type: 'text', nullable: true },
        createdAt: { type: 'datetime', createDate: true },
        updatedAt: { type: 'datetime', updateDate: true },
    },
});
(POSTGRES_ENABLED ? describe : describe.skip)('postgres UTC pin (real server, non-UTC process)', () => {
    let ds;
    let sqlite;
    let infra;
    const connectionOptions = {
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
    };
    // exportData only reads dataDatabase.type; stats reads its memo TTL, which 0 disables so a second
    // call re-queries instead of replaying the first answer.
    const cfg = {
        get: (key, def) => key === 'dataDatabase.type' ? 'postgres' : key === 'stats.cacheTtlMs' ? 0 : def,
    };
    beforeAll(async () => {
        const admin = new typeorm_1.DataSource({ type: 'postgres', ...connectionOptions });
        await admin.initialize();
        await admin.query('DROP SCHEMA IF EXISTS public CASCADE');
        await admin.query('CREATE SCHEMA public');
        await admin.destroy();
        ds = new typeorm_1.DataSource({
            type: 'postgres',
            ...connectionOptions,
            entities: ENTITIES,
            synchronize: true,
            extra: (0, postgres_utc_1.postgresUtcExtra)(),
        });
        await ds.initialize();
        infra = new infra_data_service_1.InfraDataService(cfg, ds, undefined, undefined, undefined, undefined);
        sqlite = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [SqliteSession] });
        await sqlite.initialize();
        await sqlite.synchronize();
    }, 120_000);
    afterAll(async () => {
        if (ds?.isInitialized)
            await ds.destroy();
        if (sqlite?.isInitialized)
            await sqlite.destroy();
    });
    beforeEach(async () => {
        await ds.query('DELETE FROM messages');
        await ds.query('DELETE FROM webhook_outbox_events');
        await ds.query('DELETE FROM sessions');
        await sqlite.query('DELETE FROM sessions');
    });
    /** A session whose app-written columns hold a known instant; `createdAt` comes from DEFAULT now(). */
    const seedSession = async (id, connectedAt) => {
        const repo = ds.getRepository(session_entity_1.Session);
        return repo.save(repo.create({
            id,
            name: `session-${id.slice(0, 8)}`,
            status: session_entity_1.SessionStatus.READY,
            config: {},
            connectedAt,
            lastActiveAt: connectedAt,
        }));
    };
    const rawSession = async () => {
        const rows = await ds.query('SELECT "connectedAt"::text AS connected, "createdAt"::text AS created FROM sessions');
        return rows[0];
    };
    it('runs off UTC, on a session pinned to UTC, over a schema with no timestamp[] column', async () => {
        // Without a non-UTC process every assertion in this suite would pass for the wrong reason.
        expect(new Date().getTimezoneOffset()).not.toBe(0);
        const session = await ds.query(`SELECT current_setting('TimeZone') AS zone, EXTRACT(TIMEZONE FROM now())::int AS offset_seconds`);
        expect(session[0].offset_seconds).toBe(0);
        // The parser override answers OID 1114 only. It would be unsafe if the schema held a `timestamp[]`
        // column, whose OID (1115) keeps pg-types' array parser.
        const arrays = await ds.query(`SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND udt_name IN ('_timestamp', '_timestamptz')`);
        expect(arrays).toEqual([]);
    });
    it('accepts the pinned session and rejects a zone that only reads +00 half the year', async () => {
        await expect((0, postgres_utc_1.assertDataConnectionUtc)(ds)).resolves.toBeUndefined();
        // Europe/London is what a UK server default looks like behind a pooler that discards the
        // per-connection SET: +00 from late October to late March, +01 the rest of the year. Sampling the
        // offset once, at whatever instant boot happens to be, passes it for half the year and lets every
        // DEFAULT now() run an hour ahead of what the driver reads back for the other half.
        const london = new typeorm_1.DataSource({
            type: 'postgres',
            ...connectionOptions,
            extra: { ...(0, postgres_utc_1.postgresUtcExtra)(), onConnect: (c) => c.query("SET TIME ZONE 'Europe/London'"), max: 1 },
        });
        await london.initialize();
        try {
            const sampled = await london.query(`SELECT EXTRACT(TIMEZONE FROM TIMESTAMPTZ '2026-01-15 12:00:00+00')::int AS jan,
                EXTRACT(TIMEZONE FROM TIMESTAMPTZ '2026-07-15 12:00:00+00')::int AS jul`);
            expect([sampled[0].jan, sampled[0].jul]).toEqual([0, 3600]);
            await expect((0, postgres_utc_1.assertDataConnectionUtc)(london)).rejects.toThrow(/TimeZone is "Europe\/London"/);
        }
        finally {
            await london.destroy();
        }
    });
    it('stores an app-bound create/update date as UTC wall clock, like any other column the app writes', async () => {
        // These three read as `DEFAULT now()` columns from the schema, but nothing ever lets the default
        // fire: their only writer passes the value. TypeORM's upsert puts an explicitly-valued update-date
        // column in the ON CONFLICT overwrite list rather than emitting `= DEFAULT`, so the row carries the
        // PROCESS's convention, not the server's. That is what decides whether an operator converting a
        // pre-0.23.6 database has to touch them, so it is asserted here rather than read off TypeORM.
        const at = new Date('2026-01-01T00:00:00.000Z');
        await ds.query('DELETE FROM lid_mappings');
        await ds.query('DELETE FROM chat_states');
        await seedSession(SESSION_ID, at);
        const lid = { lid: '55501', phone: '628111', sessionId: null, updatedAt: at };
        const chat = { sessionId: SESSION_ID, chatId: '628111@c.us', archived: false, pinned: false, updatedAt: at };
        const stored = { sessionId: SESSION_ID, waMessageId: 'WA1', serializedMessage: '{}', createdAt: at };
        await ds.getRepository(lid_mapping_entity_1.LidMapping).upsert(lid, ['lid']);
        await ds.getRepository(baileys_chat_state_entity_1.ChatState).upsert(chat, ['sessionId', 'chatId']);
        await ds.getRepository(baileys_stored_message_entity_1.BaileysStoredMessage).upsert(stored, ['sessionId', 'waMessageId']);
        const text = async (table, column) => {
            const rows = await ds.query(`SELECT "${column}"::text AS t FROM ${table}`);
            return rows[0].t;
        };
        // The host's wall clock would read 2026-01-01 07:00:00 here.
        expect(await text('lid_mappings', 'updatedAt')).toBe('2026-01-01 00:00:00');
        expect(await text('chat_states', 'updatedAt')).toBe('2026-01-01 00:00:00');
        expect(await text('baileys_stored_messages', 'createdAt')).toBe('2026-01-01 00:00:00');
    });
    it('stores what the app wrote and the server defaulted in the same zone', async () => {
        const connectedAt = new Date('2026-01-01T00:00:00.000Z');
        await seedSession(SESSION_ID, connectedAt);
        const raw = await rawSession();
        // The app-written column is UTC wall clock, not the host's +07:00 wall clock.
        expect(raw.connected).toBe('2026-01-01 00:00:00');
        // And the server-written one agrees with the process's own idea of now, within the test's runtime.
        const created = new Date(`${raw.created?.replace(' ', 'T')}Z`).getTime();
        expect(Math.abs(created - Date.now())).toBeLessThan(60_000);
        const read = await ds.getRepository(session_entity_1.Session).findOneByOrFail({ id: SESSION_ID });
        expect(read.connectedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });
    it('carries every timestamp through export and two restores unchanged', async () => {
        const connectedAt = new Date('2026-01-01T00:00:00.000Z');
        await seedSession(SESSION_ID, connectedAt);
        // Instants, not raw text: an archive carries ISO milliseconds, so the microseconds `now()` writes
        // are rounded off by the first restore. That rounding is bounded at one millisecond and never
        // compounds; a zone shift is what this asserts against.
        const stamps = async () => {
            const row = await ds.getRepository(session_entity_1.Session).findOneByOrFail({ id: SESSION_ID });
            return { connected: row.connectedAt?.getTime(), created: row.createdAt.getTime() };
        };
        const before = await stamps();
        expect(before.connected).toBe(connectedAt.getTime());
        expect(Math.abs((before.created ?? 0) - Date.now())).toBeLessThan(60_000);
        // The archive travels as JSON, which is where a Date becomes ISO text.
        const first = JSON.parse(JSON.stringify(await infra.exportData()));
        expect(await infra.importData({ tables: first.tables })).toMatchObject({ imported: true, warnings: [] });
        expect(await stamps()).toEqual(before);
        // Restoring the restore is the shape that used to compound the shift once per round.
        const second = JSON.parse(JSON.stringify(await infra.exportData()));
        expect(await infra.importData({ tables: second.tables })).toMatchObject({ imported: true, warnings: [] });
        expect(await stamps()).toEqual(before);
        expect(first.tables.sessions[0].connectedAt).toBe('2026-01-01T00:00:00.000Z');
        // And the column still reads as UTC wall clock rather than the host's.
        expect((await rawSession()).connected).toBe('2026-01-01 00:00:00');
    });
    it('restores a SQLite-made archive onto postgres at the same instant', async () => {
        // Written by a real SQLite data connection below, which is what a SQLite deployment's export holds:
        // `datetime` text for the create/update dates, DateTransformer's ISO text for the rest.
        const repo = sqlite.getRepository(SqliteSession);
        await repo.save({
            id: SESSION_ID,
            name: 'session-s1',
            status: 'ready',
            phone: null,
            pushName: null,
            config: '{}',
            proxyUrl: null,
            proxyType: null,
            connectedAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
            lastActiveAt: null,
        });
        const archivedRows = await sqlite.query('SELECT * FROM sessions');
        const [archived] = archivedRows;
        expect(archived.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/);
        expect(await infra.importData({ tables: { sessions: [archived] } })).toMatchObject({
            imported: true,
            warnings: [],
        });
        const restored = await ds.getRepository(session_entity_1.Session).findOneByOrFail({ id: SESSION_ID });
        expect(restored.connectedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
        expect(restored.createdAt.getTime()).toBe(new Date(`${archived.createdAt.replace(' ', 'T')}Z`).getTime());
    });
    it('restores a postgres-made archive onto SQLite at the same instant', async () => {
        const connectedAt = new Date('2026-01-01T00:00:00.000Z');
        await seedSession(SESSION_ID, connectedAt);
        const created = (await ds.getRepository(session_entity_1.Session).findOneByOrFail({ id: SESSION_ID })).createdAt;
        const archive = JSON.parse(JSON.stringify(await infra.exportData()));
        const row = archive.tables.sessions[0];
        // The two steps importData takes on a SQLite target, with its own helpers: normalise the archived
        // `datetime` columns, then bind through the `$N` rewrite the SQLite path uses.
        const datetimeColumns = (0, infra_data_service_1.sqliteDatetimeColumns)(sqlite).get('sessions') ?? [];
        expect(datetimeColumns).toContain('createdAt');
        const normalised = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, datetimeColumns.includes(key) ? (0, infra_data_service_1.toSqliteDatetime)(value) : value]));
        await sqlite.query(`INSERT INTO sessions (id, name, status, phone, "pushName", config, "proxyUrl", "proxyType", "connectedAt", "lastActiveAt", "createdAt", "updatedAt")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            normalised.id,
            normalised.name,
            normalised.status,
            normalised.phone ?? null,
            normalised.pushName ?? null,
            normalised.config,
            normalised.proxyUrl ?? null,
            normalised.proxyType ?? null,
            normalised.connectedAt ?? null,
            normalised.lastActiveAt ?? null,
            normalised.createdAt,
            normalised.updatedAt,
        ]);
        const storedRows = await sqlite.query('SELECT "connectedAt", "createdAt" FROM sessions');
        const [stored] = storedRows;
        expect(stored.connectedAt).toBe('2026-01-01T00:00:00.000Z');
        expect(new Date(`${stored.createdAt.replace(' ', 'T')}Z`).getTime()).toBe(created.getTime());
    });
    it('deletes exactly the rows a retention window names', async () => {
        const outbox = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const hoursFromCutoff = (hours) => 
        // Written the way `DEFAULT now()` writes it on a pinned server, so this measures the cutoff the
        // service binds against a stored value the app did not bind.
        utcWallText(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + hours * 60 * 60 * 1000));
        for (const [id, createdAt] of [
            // Both sit within the host's +07:00 offset of the 7-day cutoff, so a cutoff bound in the wrong
            // zone takes the younger one with it: silent data loss, not a late delete.
            [OLD_ID, hoursFromCutoff(-3)],
            [YOUNG_ID, hoursFromCutoff(3)],
        ]) {
            await ds.query(`INSERT INTO webhook_outbox_events (id, "webhookId", "sessionId", event, "idempotencyKey", "deliveryId", payload, state, attempts, "createdAt")
         VALUES ($1, $2, $3, 'message.received', $4, $5, '{}', 'delivered', 1, $6)`, [id, SESSION_ID, SESSION_ID, `key-${id}`, `del-${id}`, createdAt]);
        }
        const pruned = await new webhook_outbox_service_1.WebhookOutboxService(outbox).pruneSettled(7);
        expect(pruned).toBe(1);
        expect((await outbox.find()).map(saved => saved.id)).toEqual([YOUNG_ID]);
    });
    it('counts a day of messages from the local midnight the host means', async () => {
        await seedSession(SESSION_ID, new Date('2026-01-01T00:00:00.000Z'));
        const messages = ds.getRepository(message_entity_1.Message);
        const localMidnight = new Date();
        localMidnight.setHours(0, 0, 0, 0);
        // Stored as the server writes `createdAt` (DEFAULT now() on a pinned session), one minute either
        // side of the host's local midnight.
        for (const [id, offsetMs] of [
            [BEFORE_ID, -60_000],
            [AFTER_ID, 60_000],
        ]) {
            await ds.query(`INSERT INTO messages (id, "sessionId", "chatId", "from", "to", body, type, direction, status, "createdAt")
         VALUES ($1, $2, '628111@c.us', 'me@c.us', '628111@c.us', 'hi', 'text', $3, $4, $5)`, [
                id,
                SESSION_ID,
                message_entity_1.MessageDirection.OUTGOING,
                message_entity_1.MessageStatus.SENT,
                utcWallText(new Date(localMidnight.getTime() + offsetMs)),
            ]);
        }
        const stats = new stats_service_1.StatsService(ds.getRepository(session_entity_1.Session), messages, cfg);
        expect((await stats.getOverview()).messages.today).toEqual({ sent: 1, received: 0 });
    });
    it('keeps a lease comparison honest across the restore that carries it', async () => {
        const repo = ds.getRepository(session_entity_1.Session);
        await seedSession(SESSION_ID, new Date('2026-01-01T00:00:00.000Z'));
        const leaseExpiresAt = new Date(Date.now() + 60_000);
        await repo.update({ id: SESSION_ID }, { nodeId: 'node-a', claimedAt: new Date(), leaseExpiresAt });
        const archive = JSON.parse(JSON.stringify(await infra.exportData()));
        expect(await infra.importData({ tables: archive.tables })).toMatchObject({ imported: true, warnings: [] });
        // The claim is live, so it must not read as lapsed after the restore that carried it.
        expect(await repo.findOneBy({ id: SESSION_ID, leaseExpiresAt: (0, typeorm_1.LessThan)(new Date()) })).toBeNull();
        const carried = await repo.findOneByOrFail({ id: SESSION_ID });
        expect(carried.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(leaseExpiresAt.getTime());
    });
    it('re-keys a name-keyed chat state on restore over a uuid sessions.id', async () => {
        // synchronize gives sessions.id a native uuid type, which has no `=` against the varchar key.
        await ds.query('DELETE FROM chat_states');
        const session = await seedSession(SESSION_ID, new Date('2026-01-01T00:00:00.000Z'));
        const chats = ds.getRepository(baileys_chat_state_entity_1.ChatState);
        await chats.save([
            { sessionId: session.name, chatId: 'by-name@c.us', archived: true, pinned: false },
            { sessionId: SESSION_ID, chatId: 'by-id@c.us', archived: false, pinned: true },
        ]);
        const archive = JSON.parse(JSON.stringify(await infra.exportData()));
        expect(await infra.importData({ tables: archive.tables })).toMatchObject({ imported: true, warnings: [] });
        const rows = await chats.find({ order: { chatId: 'ASC' } });
        expect(rows.map(r => [r.chatId, r.sessionId, r.archived, r.pinned])).toEqual([
            ['by-id@c.us', SESSION_ID, false, true],
            ['by-name@c.us', SESSION_ID, true, false],
        ]);
    });
    it('rolls back a rejected row with its real error instead of an aborted-transaction failure', async () => {
        await seedSession(SESSION_ID, new Date('2026-01-01T00:00:00.000Z'));
        const archive = JSON.parse(JSON.stringify(await infra.exportData()));
        const [row] = archive.tables.sessions;
        const res = await infra.importData({
            tables: {
                sessions: [
                    { ...row, id: OLD_ID },
                    { ...row, id: OLD_ID, name: 'dup' },
                ],
            },
        });
        expect(res.imported).toBe(false);
        expect(res.warnings).toHaveLength(1);
        expect(res.warnings[0]).toContain('duplicate key');
        expect((await ds.getRepository(session_entity_1.Session).find()).map(s => s.id)).toEqual([SESSION_ID]);
    });
});
