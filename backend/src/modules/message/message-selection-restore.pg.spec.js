"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/* istanbul ignore file -- PG-gated: only runs under DATABASE_TYPE=postgres (test-postgres CI job);
   skipped in the default test job, so its lines would be unread and skew the global coverage gate. */
require("reflect-metadata");
const crypto_1 = require("crypto");
const typeorm_1 = require("typeorm");
const infra_data_service_1 = require("../infra/infra-data.service");
const session_entity_1 = require("../session/entities/session.entity");
const webhook_entity_1 = require("../webhook/entities/webhook.entity");
const message_entity_1 = require("./entities/message.entity");
const message_service_1 = require("./message.service");
const message_batch_entity_1 = require("./entities/message-batch.entity");
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
const send_idempotency_key_entity_1 = require("./entities/send-idempotency-key.entity");
const automation_rule_entity_1 = require("../automation/entities/automation-rule.entity");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const chat_scope_service_1 = require("../auth/chat-scope.service");
const postgres_utc_1 = require("../../database/postgres-utc");
const enabled = process.env.DATABASE_TYPE === 'postgres';
const deferred = () => {
    let resolve;
    const promise = new Promise(r => {
        resolve = r;
    });
    return { promise, resolve };
};
(enabled ? describe : describe.skip)('stored message selection during data restore', () => {
    const schema = `message_selection_${(0, crypto_1.randomBytes)(4).toString('hex')}`;
    const SID = '00000000-0000-4000-8000-000000000001';
    const OLD = '00000000-0000-4000-8000-000000000011';
    const MID = '00000000-0000-4000-8000-000000000012';
    const NEW = '00000000-0000-4000-8000-000000000013';
    const A = '100@g.us';
    const B = '200@g.us';
    let admin;
    let ds;
    let main;
    let repo;
    let service;
    let infra;
    let key;
    let releaseGate;
    let previousBudget;
    const chatScope = new chat_scope_service_1.ChatScopeService();
    beforeAll(async () => {
        const options = {
            type: 'postgres',
            host: process.env.DATABASE_HOST || '127.0.0.1',
            port: Number(process.env.DATABASE_PORT || 5432),
            username: process.env.DATABASE_USERNAME || 'fixture',
            password: process.env.DATABASE_PASSWORD || 'fixture',
            database: process.env.DATABASE_NAME || 'fixture',
        };
        admin = await new typeorm_1.DataSource(options).initialize();
        await admin.query(`CREATE SCHEMA "${schema}"`);
        ds = await new typeorm_1.DataSource({
            ...options,
            schema,
            extra: {
                ...(0, postgres_utc_1.postgresUtcExtra)(),
                options: `-c search_path=${schema},public`,
                max: 3,
                statement_timeout: 5000,
                connectionTimeoutMillis: 2000,
            },
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
        main = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [api_key_entity_1.ApiKey],
            synchronize: true,
        }).initialize();
        key = await main.getRepository(api_key_entity_1.ApiKey).save(main.getRepository(api_key_entity_1.ApiKey).create({
            name: 'scoped-viewer',
            keyHash: '0'.repeat(64),
            keyPrefix: 'dummy-prefix',
            role: api_key_entity_1.ApiKeyRole.VIEWER,
            allowedSessions: [SID],
            allowedChats: [A],
            allowedIps: null,
        }));
        repo = ds.getRepository(message_entity_1.Message);
        service = new message_service_1.MessageService(repo, {}, {}, {}, {
            findLidsForPhone: jest.fn().mockResolvedValue([]),
            findPhoneForLid: jest.fn().mockResolvedValue(null),
        }, {}, {});
        infra = new infra_data_service_1.InfraDataService({ get: (name, fallback) => (name === 'dataDatabase.type' ? 'postgres' : fallback) }, ds);
    });
    afterAll(async () => {
        releaseGate?.();
        if (ds?.isInitialized)
            await ds.destroy();
        if (main?.isInitialized)
            await main.destroy();
        if (admin?.isInitialized) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
            await admin.destroy();
        }
    });
    beforeEach(async () => {
        previousBudget = process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
        await ds.createQueryBuilder().delete().from(message_entity_1.Message).execute();
        await ds.createQueryBuilder().delete().from(session_entity_1.Session).execute();
        await ds.getRepository(session_entity_1.Session).save(ds.getRepository(session_entity_1.Session).create({
            id: SID,
            name: 'kept-session',
            status: session_entity_1.SessionStatus.DISCONNECTED,
            phone: null,
            pushName: null,
            config: {},
            proxyUrl: null,
            proxyType: null,
            connectedAt: null,
            lastActiveAt: null,
        }));
        for (const [id, second] of [
            [OLD, 0],
            [MID, 1],
            [NEW, 2],
        ]) {
            await repo.insert({
                id,
                sessionId: SID,
                waMessageId: id,
                chatId: A,
                from: A,
                to: 'me',
                body: `original-${second}`,
                type: 'image',
                timestamp: 1000 + second,
                direction: message_entity_1.MessageDirection.INCOMING,
                createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, second)),
                metadata: { media: { mimetype: 'image/png', data: 'A'.repeat(1000) } },
            });
        }
    });
    afterEach(() => {
        releaseGate?.();
        releaseGate = undefined;
        jest.restoreAllMocks();
        if (previousBudget === undefined)
            delete process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES;
        else
            process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = previousBudget;
    });
    it.each(['chat', 'time', 'type'])('preserves the original %s selection after data restore', async (drift) => {
        const archive = await infra.exportData();
        const row = archive.tables.messages.find(message => message.id === MID);
        expect(row).toBeDefined();
        row.body = 'replacement-outside-selection';
        if (drift === 'chat')
            row.chatId = B;
        if (drift === 'time')
            row.timestamp = 2000;
        if (drift === 'type')
            row.type = 'document';
        const selection = {
            chatId: A,
            inlineMedia: false,
            ...(drift === 'time' ? { since: 1000000, until: 1003000, orderBy: 'timestamp' } : {}),
            ...(drift === 'type' ? { type: 'image' } : {}),
        };
        expect(await chatScope.allows(key, A)).toBe(true);
        expect(await chatScope.allows(key, B)).toBe(false);
        chatScope.requireChat(key, A);
        const entered = deferred();
        const proceed = deferred();
        releaseGate = proceed.resolve;
        const createRunner = ds.createQueryRunner.bind(ds);
        let paused = false;
        jest.spyOn(ds, 'createQueryRunner').mockImplementation((...args) => {
            const runner = createRunner(...args);
            const query = runner.query.bind(runner);
            jest.spyOn(runner, 'query').mockImplementation(async (sql, ...parameters) => {
                if (!paused && /^\s*SELECT/i.test(sql) && sql.includes('"metadata"') && !sql.includes('OCTET_LENGTH')) {
                    paused = true;
                    entered.resolve();
                    await proceed.promise;
                }
                return query(sql, ...parameters);
            });
            return runner;
        });
        const reading = service.getMessages(SID, selection);
        await entered.promise;
        try {
            expect(await infra.importData(archive)).toMatchObject({ imported: true, warnings: [] });
            // Data restore does not replace the separate main DB's key or its A-only allowlist.
            const currentKey = await main.getRepository(api_key_entity_1.ApiKey).findOneByOrFail({ id: key.id });
            expect(currentKey.allowedChats).toEqual([A]);
            expect(await chatScope.allows(currentKey, B)).toBe(false);
        }
        finally {
            proceed.resolve();
        }
        const page = await reading;
        expect(page.messages.filter(message => message.id !== MID).map(message => message.id)).toEqual([NEW, OLD]);
        expect(new Set(page.messages.map(message => message.id)).size).toBe(page.messages.length);
        for (const message of page.messages) {
            expect(message.chatId).toBe(A);
            expect(message.body).not.toBe('replacement-outside-selection');
            if (drift === 'time') {
                expect(message.timestamp).toBeGreaterThanOrEqual(1000);
                expect(message.timestamp).toBeLessThan(1003);
            }
            if (drift === 'type')
                expect(message.type).toBe('image');
        }
    });
    it('still serves the picked page when the cursor row is deleted before its rows are read', async () => {
        const getMany = Object.getOwnPropertyDescriptor(typeorm_1.SelectQueryBuilder.prototype, 'getMany')
            .value;
        jest.spyOn(typeorm_1.SelectQueryBuilder.prototype, 'getMany').mockImplementationOnce(async function () {
            await repo.delete({ id: NEW });
            return getMany.call(this);
        });
        const page = await service.getMessages(SID, { chatId: A, after: NEW, inlineMedia: false });
        expect(page.total).toBe(3);
        expect(page.messages.map(message => message.id)).toEqual([MID, OLD]);
    });
    it('keeps newest-first ordering and encoded inline budget without restore', async () => {
        process.env.MESSAGE_LIST_INLINE_MEDIA_BUDGET_BYTES = '1500';
        const page = await service.getMessages(SID, { chatId: A });
        expect(page.messages.map(message => message.id)).toEqual([NEW, MID, OLD]);
        const inline = page.messages.map(message => message.metadata.media.data);
        expect(inline.map(data => typeof data === 'string')).toEqual([true, false, false]);
        expect(inline.reduce((bytes, data) => bytes + (data?.length ?? 0), 0)).toBeLessThanOrEqual(1500);
        const metadataOnly = await service.getMessages(SID, { chatId: A, inlineMedia: false });
        expect(metadataOnly.messages.map(message => message.id)).toEqual([NEW, MID, OLD]);
        for (const message of metadataOnly.messages)
            expect(message.metadata.media).toMatchObject({ omitted: true });
    });
});
