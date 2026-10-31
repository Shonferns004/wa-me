"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* istanbul ignore file: PG-gated, only runs under DATABASE_TYPE=postgres (test-postgres CI job). */
require("reflect-metadata");
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const infra_data_service_1 = require("./infra-data.service");
const export_tables_1 = require("./export-tables");
const session_entity_1 = require("../session/entities/session.entity");
const webhook_entity_1 = require("../webhook/entities/webhook.entity");
const message_entity_1 = require("../message/entities/message.entity");
const message_batch_entity_1 = require("../message/entities/message-batch.entity");
const template_entity_1 = require("../template/entities/template.entity");
const baileys_stored_message_entity_1 = require("../../engine/adapters/baileys-stored-message.entity");
const lid_mapping_entity_1 = require("../../engine/identity/lid-mapping.entity");
const baileys_chat_state_entity_1 = require("../../engine/adapters/baileys-chat-state.entity");
const plugin_instance_entity_1 = require("../integration/entities/plugin-instance.entity");
const conversation_mapping_entity_1 = require("../integration/entities/conversation-mapping.entity");
const ingress_event_entity_1 = require("../integration/entities/ingress-event.entity");
const webhook_delivery_failure_entity_1 = require("../webhook/entities/webhook-delivery-failure.entity");
const webhook_outbox_event_entity_1 = require("../webhook/entities/webhook-outbox-event.entity");
const integration_delivery_failure_entity_1 = require("../integration/entities/integration-delivery-failure.entity");
const status_update_entity_1 = require("../status-store/entities/status-update.entity");
const send_idempotency_key_entity_1 = require("../message/entities/send-idempotency-key.entity");
const automation_rule_entity_1 = require("../automation/entities/automation-rule.entity");
const postgres_utc_1 = require("../../database/postgres-utc");
const entities = [
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
    send_idempotency_key_entity_1.SendIdempotencyKey,
];
async function seedSession(ds) {
    const id = (0, crypto_1.randomUUID)();
    await ds.getRepository(session_entity_1.Session).save(ds.getRepository(session_entity_1.Session).create({
        id,
        name: `session-${id}`,
        status: session_entity_1.SessionStatus.DISCONNECTED,
        config: {},
        phone: null,
        pushName: null,
        proxyUrl: null,
        proxyType: null,
        connectedAt: null,
        lastActiveAt: null,
    }));
    return id;
}
const optionalTables = export_tables_1.EXPORT_TABLES.filter(entry => entry.optional).map(entry => ({
    table: entry.table,
    key: entry.key,
}));
const describePostgres = process.env.DATABASE_TYPE === 'postgres' ? describe : describe.skip;
describePostgres('PostgreSQL restore tolerates absent optional archive tables', () => {
    jest.setTimeout(20000);
    const options = {
        type: 'postgres',
        host: process.env.DATABASE_HOST || 'localhost',
        port: Number(process.env.DATABASE_PORT || 5432),
        username: process.env.DATABASE_USERNAME || 'openwa',
        password: process.env.DATABASE_PASSWORD || 'openwa',
        database: process.env.DATABASE_NAME || 'openwa',
    };
    let admin;
    let ds;
    let service;
    let schema;
    let sessionId;
    beforeAll(async () => {
        admin = await new typeorm_1.DataSource(options).initialize();
    });
    beforeEach(async () => {
        schema = `restore_${(0, crypto_1.randomUUID)().replaceAll('-', '')}`;
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = await new typeorm_1.DataSource({
            ...options,
            schema,
            // Only the scratch schema: a table dropped from it must read as absent, not resolve to one in public.
            // gen_random_uuid() is core since PostgreSQL 13; uuid_generate_v4() lives in an extension that an earlier spec may
            // have installed in public, which this search_path no longer reaches.
            uuidExtension: 'pgcrypto',
            extra: { ...(0, postgres_utc_1.postgresUtcExtra)(), options: `-c search_path=${schema}` },
            entities,
            synchronize: true,
        }).initialize();
        service = new infra_data_service_1.InfraDataService({ get: (key, fallback) => (key === 'dataDatabase.type' ? 'postgres' : fallback) }, ds);
        sessionId = await seedSession(ds);
    });
    afterEach(async () => {
        if (ds?.isInitialized)
            await ds.destroy();
        if (admin?.isInitialized && schema)
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });
    afterAll(async () => {
        if (admin?.isInitialized)
            await admin.destroy();
    });
    it('restores an archive against an intact synchronized schema', async () => {
        const dump = await service.exportData();
        expect(dump.skippedTables).toEqual([]);
        await expect(service.importData(dump)).resolves.toMatchObject({ imported: true, warnings: [] });
        expect(await ds.getRepository(session_entity_1.Session).findOneBy({ id: sessionId })).not.toBeNull();
    });
    it.each(optionalTables)('restores the real empty-table export when $table is absent', async ({ table, key }) => {
        await ds.query(`DROP TABLE "${table}" CASCADE`);
        const dump = await service.exportData();
        expect(dump.skippedTables).toContain(table);
        expect(dump.tables[key]).toEqual([]);
        await expect(service.importData(dump)).resolves.toMatchObject({ imported: true, warnings: [] });
        expect(await ds.getRepository(session_entity_1.Session).findOneBy({ id: sessionId })).not.toBeNull();
        const runner = ds.createQueryRunner();
        try {
            expect(await runner.hasTable(table)).toBe(false);
        }
        finally {
            await runner.release();
        }
    });
    it('rolls back completed clears and inserts after a genuine malformed row', async () => {
        const before = await ds.query('SELECT * FROM sessions ORDER BY id');
        const dump = await service.exportData();
        const addedId = (0, crypto_1.randomUUID)();
        const kept = dump.tables.sessions[0];
        dump.tables.sessions = [
            { ...kept, id: addedId, name: 'valid-first-row' },
            { ...kept, createdAt: 'invalid-timestamp' },
        ];
        const result = await service.importData(dump);
        expect(result.imported).toBe(false);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(await ds.query('SELECT * FROM sessions ORDER BY id')).toEqual(before);
        expect(await ds.getRepository(session_entity_1.Session).findOneBy({ id: addedId })).toBeNull();
    });
    it('rejects a nonempty table payload that the target schema cannot restore atomically', async () => {
        const dump = await service.exportData();
        await ds.query('DROP TABLE message_batches');
        const before = await ds.query('SELECT * FROM sessions ORDER BY id');
        dump.tables.messageBatches = [
            {
                id: (0, crypto_1.randomUUID)(),
                batch_id: 'unsupported-target',
                session_id: sessionId,
                status: 'pending',
                messages: '[]',
                options: null,
                progress: null,
                results: null,
                current_index: 0,
                created_at: '2020-01-01T00:00:00.000Z',
                updated_at: '2020-01-01T00:00:00.000Z',
                started_at: null,
                completed_at: null,
            },
        ];
        const result = await service.importData(dump);
        expect(result.imported).toBe(false);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(await ds.query('SELECT * FROM sessions ORDER BY id')).toEqual(before);
    });
    it('rolls back a genuine DELETE error instead of treating it as an optional table', async () => {
        const before = await ds.query('SELECT * FROM sessions ORDER BY id');
        const dump = await service.exportData();
        await ds.query(`CREATE FUNCTION fail_clear() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture blocked delete'; END $$`);
        await ds.query('CREATE TRIGGER fail_clear BEFORE DELETE ON messages FOR EACH STATEMENT EXECUTE FUNCTION fail_clear()');
        await expect(service.importData(dump)).rejects.toThrow('fixture blocked delete');
        expect(await ds.query('SELECT * FROM sessions ORDER BY id')).toEqual(before);
    });
});
