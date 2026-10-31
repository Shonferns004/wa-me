"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* istanbul ignore file: PG-gated, only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
require("reflect-metadata");
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const infra_data_controller_1 = require("./infra-data.controller");
const infra_data_service_1 = require("./infra-data.service");
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
const session_write_scope_1 = require("../../common/utils/session-write-scope");
/**
 * The replace-all import trims send_idempotency_keys with a statement that compares the claim's
 * varchar sessionId with sessions.id, a uuid on PostgreSQL. The comparison only holds because the
 * statement casts, and the cast is invisible on SQLite, where both are text: without it every import
 * on PostgreSQL answers imported:false with a warning about idempotency claims.
 */
const describePostgres = process.env.DATABASE_TYPE === 'postgres' ? describe : describe.skip;
describePostgres('InfraDataController.importData (postgres)', () => {
    const schema = `infra_import_${process.pid}_${(0, crypto_1.randomBytes)(4).toString('hex')}`;
    let admin;
    let ds;
    let controller;
    beforeAll(async () => {
        const options = {
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
        };
        admin = await new typeorm_1.DataSource(options).initialize();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = await new typeorm_1.DataSource({
            ...options,
            schema,
            extra: { ...(0, postgres_utc_1.postgresUtcExtra)(), options: `-c search_path=${schema},public` },
            // The full data-connection entity set: exportData validates its table registry against it.
            entities: [
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
            ],
            synchronize: true,
        }).initialize();
        const cfg = { get: (key, def) => (key === 'dataDatabase.type' ? 'postgres' : def) };
        controller = new infra_data_controller_1.InfraDataController(new infra_data_service_1.InfraDataService(cfg, ds, undefined, undefined, undefined));
    });
    afterAll(async () => {
        await ds?.destroy();
        if (admin?.isInitialized) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.destroy();
        }
    });
    it('drops the claims of a session the restore removes and keeps those of one it restores', async () => {
        const sessions = ds.getRepository(session_entity_1.Session);
        const claims = ds.getRepository(send_idempotency_key_entity_1.SendIdempotencyKey);
        const [kept, removed] = [(0, crypto_1.randomUUID)(), (0, crypto_1.randomUUID)()];
        for (const id of [kept, removed]) {
            await sessions.save(sessions.create({
                id,
                name: `session-${id.slice(0, 8)}`,
                status: session_entity_1.SessionStatus.READY,
                phone: null,
                pushName: null,
                config: {},
                proxyUrl: null,
                proxyType: null,
                connectedAt: null,
                lastActiveAt: null,
            }));
            await claims.save(claims.create({
                sessionId: id,
                idempotencyKey: 'order-42',
                route: 'send-text',
                requestHash: 'h',
                state: 'completed',
                responseBody: { messageId: `sent-by-${id}` },
                expiresAt: new Date(Date.now() + 3_600_000),
            }));
        }
        const dump = await controller.exportData();
        const onlyKept = {
            tables: {
                ...dump.tables,
                sessions: dump.tables.sessions.filter(row => row.id === kept),
            },
        };
        const result = await controller.importData(onlyKept);
        expect(result).toMatchObject({ imported: true });
        expect(result.warnings).toEqual([]);
        expect((await claims.find()).map(claim => claim.sessionId)).toEqual([kept]);
    });
    it('preserves reported mapping origin and restores legacy mappings as display data', async () => {
        const mappings = ds.getRepository(lid_mapping_entity_1.LidMapping);
        await mappings.insert([
            { lid: '111', phone: '628111', sessionId: null, isReported: true },
            { lid: '222', phone: '628222', sessionId: null, isReported: false },
        ]);
        const dump = await controller.exportData();
        await expect(controller.importData(dump)).resolves.toMatchObject({ imported: true, warnings: [] });
        expect(await mappings.findOneBy({ lid: '111' })).toMatchObject({ isReported: true });
        expect(await mappings.findOneBy({ lid: '222' })).toMatchObject({ isReported: false });
        const rows = dump.tables.lidMappings;
        for (const row of rows)
            delete row.isReported;
        await expect(controller.importData(dump)).resolves.toMatchObject({ imported: true, warnings: [] });
        expect(await mappings.findOneBy({ lid: '111' })).toMatchObject({ phone: '628111', isReported: false });
    });
    // A bigint column the export reads back as a string.
    it('restores the deletion mark of a chat state', async () => {
        const states = ds.getRepository(baileys_chat_state_entity_1.ChatState);
        await states.insert([{ sessionId: 's1', chatId: '628111@s.whatsapp.net', deletedAt: 1790000000000 }]);
        const dump = await controller.exportData();
        await expect(controller.importData(dump)).resolves.toMatchObject({ imported: true, warnings: [] });
        expect(await states.findOneBy({ chatId: '628111@s.whatsapp.net' })).toMatchObject({ deletedAt: 1790000000000 });
    });
    // The runtime pool cancels a statement that outlives statement_timeout (30 s by default), and the
    // clears of a replace-all import scale with the live tables, not with the archive. A slow trigger on
    // messages stands in for a table that has grown large: with the pool's timeout lowered below it, the
    // import only completes when it lifts the timeout for its own transaction.
    it('completes a restore whose clears outlast the runtime statement timeout', async () => {
        const dump = await controller.exportData();
        const strict = await new typeorm_1.DataSource({
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema,
            extra: { ...(0, postgres_utc_1.postgresUtcExtra)(), options: `-c search_path=${schema},public`, statement_timeout: 250 },
            entities: ds.options.entities,
            synchronize: false,
        }).initialize();
        const cfg = { get: (key, def) => (key === 'dataDatabase.type' ? 'postgres' : def) };
        const strictController = new infra_data_controller_1.InfraDataController(new infra_data_service_1.InfraDataService(cfg, strict, undefined, undefined, undefined));
        await admin.query(`CREATE FUNCTION "${schema}".slow_messages_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.6); RETURN NULL; END $$`);
        await admin.query(`CREATE TRIGGER slow_messages_delete BEFORE DELETE ON "${schema}".messages FOR EACH STATEMENT EXECUTE FUNCTION "${schema}".slow_messages_delete()`);
        try {
            // Guard the guard: the lowered timeout does cancel the slow clear outside the import's transaction.
            await expect(strict.query('DELETE FROM messages')).rejects.toThrow(/statement timeout/);
            await expect(strictController.importData(dump)).resolves.toMatchObject({ imported: true });
        }
        finally {
            await admin.query(`DROP TRIGGER IF EXISTS slow_messages_delete ON "${schema}".messages`);
            await admin.query(`DROP FUNCTION IF EXISTS "${schema}".slow_messages_delete()`);
            await strict.destroy();
        }
    });
    // Before its transaction opens, the import waits for the writes still in flight for the sessions it
    // removes. A write that has yet to get a client from the pool needs the one the import would hold, so on a
    // pool of one the import must not take it until the wait is over.
    it.each([0, 10_000])('waits out a write of a session it removes on a pool of one client (connection timeout %i ms)', async (connectionTimeoutMillis) => {
        const sessions = ds.getRepository(session_entity_1.Session);
        const removed = (0, crypto_1.randomUUID)();
        await sessions.save(sessions.create({
            id: removed,
            name: `removed-${removed.slice(0, 8)}`,
            status: session_entity_1.SessionStatus.READY,
            config: {},
        }));
        const dump = await controller.exportData();
        const withoutRemoved = {
            tables: {
                ...dump.tables,
                sessions: dump.tables.sessions.filter(row => row.id !== removed),
            },
        };
        const applicationName = `${schema}_pool_of_one`;
        const single = await new typeorm_1.DataSource({
            type: 'postgres',
            host: process.env.DATABASE_HOST || 'localhost',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'openwa',
            password: process.env.DATABASE_PASSWORD || 'openwa',
            database: process.env.DATABASE_NAME || 'openwa',
            schema,
            extra: {
                ...(0, postgres_utc_1.postgresUtcExtra)(),
                options: `-c search_path=${schema},public`,
                max: 1,
                connectionTimeoutMillis,
                application_name: applicationName,
            },
            entities: ds.options.entities,
            synchronize: false,
        }).initialize();
        const cfg = { get: (key, def) => (key === 'dataDatabase.type' ? 'postgres' : def) };
        const service = new infra_data_service_1.InfraDataService(cfg, single, undefined, undefined, undefined);
        // The write is let go once the import reads the sessions it removes, so it asks the pool for its client
        // after the import has begun.
        let reading;
        const read = new Promise(resolve => (reading = resolve));
        let letGo;
        const go = new Promise(resolve => (letGo = resolve));
        const realCreate = single.createQueryRunner.bind(single);
        jest.spyOn(single, 'createQueryRunner').mockImplementation((...args) => {
            const runner = realCreate(...args);
            const query = runner.query.bind(runner);
            runner.query = ((...queryArgs) => {
                if (/^SELECT id FROM sessions/.test(queryArgs[0]))
                    reading();
                return query(...queryArgs);
            });
            return runner;
        });
        const scope = (0, session_write_scope_1.captureSessionWrites)(single, removed);
        const writing = scope.write(async () => {
            await go;
            await single
                .getRepository(message_entity_1.Message)
                .insert({ sessionId: removed, chatId: '10000000001@c.us', from: 'me', to: '10000000001@c.us', body: 'm' });
        });
        const importing = service.importData(withoutRemoved);
        await read;
        letGo();
        const outcome = await Promise.race([
            importing.then(result => result.imported),
            new Promise(resolve => setTimeout(() => resolve('still waiting after 8 s'), 8_000)),
        ]);
        try {
            expect(outcome).toBe(true);
            await expect(writing).resolves.toBeUndefined();
            expect(await sessions.countBy({ id: removed })).toBe(0);
            expect(await ds.getRepository(message_entity_1.Message).countBy({ sessionId: removed })).toBe(0);
        }
        finally {
            jest.restoreAllMocks();
            scope.close();
            // Only when the import is stuck: cut its connection so the pool can close.
            if (outcome !== true) {
                await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [
                    applicationName,
                ]);
            }
            await Promise.allSettled([importing, writing]);
            await single.destroy();
        }
    }, 30_000);
});
