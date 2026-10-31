"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const fs_1 = require("fs");
const path_1 = require("path");
const typeorm_1 = require("typeorm");
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
/**
 * What docs/14 (Timestamps travel as UTC) says a SQLite-made archive holds, checked against an export from
 * a SQLite data database the migration chain built, the default deployment: created and updated columns
 * keep SQLite's zone-less UTC text, the columns the app writes itself are ISO 8601 with Z.
 */
const SQLITE_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{3})?$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
describe('a SQLite-made export archive', () => {
    let ds;
    beforeAll(async () => {
        const dir = (0, path_1.join)(__dirname, '..', '..', 'database', 'migrations');
        const migrations = (0, fs_1.readdirSync)(dir)
            .filter(f => f.endsWith('.js') && !f.endsWith('.spec.js'))
            .sort()
            .map(f => Object.values(jest.requireActual((0, path_1.join)(dir, f))).find(v => typeof v === 'function' && v.prototype?.up !== undefined));
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
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
            migrations: migrations,
        });
        await ds.initialize();
        await ds.runMigrations({ transaction: 'all' });
        const session = await ds.getRepository(session_entity_1.Session).save(ds.getRepository(session_entity_1.Session).create({
            name: 'stamp-probe',
            status: session_entity_1.SessionStatus.DISCONNECTED,
            config: {},
            connectedAt: new Date('2026-10-28T23:01:07.123Z'),
        }));
        await ds.getRepository(message_entity_1.Message).save(ds.getRepository(message_entity_1.Message).create({
            sessionId: session.id,
            waMessageId: 'wa-1',
            chatId: '628222@c.us',
            from: '628222@c.us',
            to: '628111@c.us',
            body: 'hello',
            type: 'text',
            direction: message_entity_1.MessageDirection.INCOMING,
            timestamp: 1798844587123,
        }));
    });
    afterAll(async () => {
        await ds?.destroy();
    });
    it('keeps SQLite text for created and updated columns and ISO 8601 with Z for the others', async () => {
        const cfg = { get: (_key, def) => def };
        const archive = await new infra_data_service_1.InfraDataService(cfg, ds).exportData();
        const [session] = archive.tables.sessions;
        const [message] = archive.tables.messages;
        expect([session.createdAt, session.updatedAt, message.createdAt]).toEqual([
            expect.stringMatching(SQLITE_TEXT),
            expect.stringMatching(SQLITE_TEXT),
            expect.stringMatching(SQLITE_TEXT),
        ]);
        expect(session.connectedAt).toMatch(ISO_UTC);
    });
    it('is described as it is in docs/14', () => {
        const doc = (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '..', '..', '..', 'docs', '14-migration-guide.md'), 'utf8');
        const note = doc.slice(doc.indexOf('**Timestamps travel as UTC.**')).split('\n\n')[0];
        expect(note).toContain('`YYYY-MM-DD HH:MM:SS`');
        expect(note).not.toMatch(/Every stamp in the archive is ISO 8601/);
    });
});
