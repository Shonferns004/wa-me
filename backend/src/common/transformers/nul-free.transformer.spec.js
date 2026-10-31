"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../../modules/message/entities/message.entity");
const status_update_entity_1 = require("../../modules/status-store/entities/status-update.entity");
const integration_delivery_failure_entity_1 = require("../../modules/integration/entities/integration-delivery-failure.entity");
const webhook_delivery_failure_entity_1 = require("../../modules/webhook/entities/webhook-delivery-failure.entity");
const session_entity_1 = require("../../modules/session/entities/session.entity");
const session_engine_lifecycle_service_1 = require("../../modules/session/session-engine-lifecycle.service");
// PostgreSQL rejects U+0000 in text and varchar, so free text from WhatsApp, a plugin error or a webhook
// receiver that carried one failed its write there and the row was lost. SQLite stores it, which makes
// it the dialect that shows whether the character still reaches the column.
describe('free-text columns drop NUL characters on write', () => {
    let ds;
    const N = '\u0000';
    beforeAll(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message, status_update_entity_1.StatusUpdate, integration_delivery_failure_entity_1.IntegrationDeliveryFailure, webhook_delivery_failure_entity_1.WebhookDeliveryFailure, session_entity_1.Session],
            synchronize: true,
        });
        await ds.initialize();
    });
    afterAll(() => ds.destroy());
    const stored = (table, columns) => ds.query(`SELECT ${columns.map(c => `"${c}"`).join(', ')} FROM "${table}"`);
    it('messages: body, chatName and mediaMimetype, on insert, multi-row insert and update', async () => {
        const repo = ds.getRepository(message_entity_1.Message);
        const row = { sessionId: 's', chatId: 'c@c.us', from: 'c@c.us', to: 'me', type: 'text' };
        await repo.insert({ ...row, waMessageId: 'w1', body: `a${N}b`, chatName: `n${N}` });
        await repo
            .createQueryBuilder()
            .insert()
            .values([{ ...row, waMessageId: 'w2', body: `h${N}` }])
            .orIgnore()
            .execute();
        await repo.update({ waMessageId: 'w2' }, { body: `e${N}`, mediaMimetype: `image/jpeg${N}` });
        expect(await stored('messages', ['body', 'chatName', 'mediaMimetype'])).toEqual(expect.arrayContaining([
            { body: 'ab', chatName: 'n', mediaMimetype: null },
            { body: 'e', chatName: null, mediaMimetype: 'image/jpeg' },
        ]));
    });
    it('status_updates: caption, contact names and mediaMimetype, across a save and a re-save', async () => {
        const repo = ds.getRepository(status_update_entity_1.StatusUpdate);
        const row = repo.create({
            sessionId: 's',
            contactJid: 'c@s.whatsapp.net',
            contactName: `c${N}`,
            contactPushName: `p${N}`,
            waStatusId: 'st1',
            type: 'image',
            caption: `x${N}`,
            mediaOmitted: true,
            postedAt: 1,
            expiresAt: 2,
        });
        await repo.save(row);
        row.mediaMimetype = `image/png${N}`;
        await repo.save(row);
        expect(await stored('status_updates', ['caption', 'contactName', 'contactPushName', 'mediaMimetype'])).toEqual([
            { caption: 'x', contactName: 'c', contactPushName: 'p', mediaMimetype: 'image/png' },
        ]);
    });
    // The READY write sets status, phone, pushName and connectedAt in one UPDATE, so a NUL in the account's
    // own profile name failed all of it and left the session with no bound phone.
    it('sessions: the pushName of the READY row update', async () => {
        const repo = ds.getRepository(session_entity_1.Session);
        const { id } = await repo.save(repo.create({ name: 'nul-session' }));
        await repo.update(id, (0, session_engine_lifecycle_service_1.readyRowUpdate)('6281', `Bo${N}b`, new Date()));
        expect(await stored('sessions', ['phone', 'pushName', 'status'])).toEqual([
            { phone: '6281', pushName: 'Bob', status: 'ready' },
        ]);
    });
    it('the lastError of both dead-letter tables', async () => {
        await ds.getRepository(integration_delivery_failure_entity_1.IntegrationDeliveryFailure).save({
            direction: 'inbound',
            pluginId: 'p',
            instanceId: 'i',
            attempts: 1,
            lastError: `Unexpected token 'a', "a${N}" is not valid JSON`,
        });
        await ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure).insert({
            webhookId: 'w',
            sessionId: 's',
            event: 'message.received',
            url: 'https://example.com/hook',
            attempts: 3,
            lastError: `HTTP 500: Bad${N}`,
        });
        expect(await stored('integration_delivery_failures', ['lastError'])).toEqual([
            { lastError: `Unexpected token 'a', "a" is not valid JSON` },
        ]);
        expect(await stored('webhook_delivery_failures', ['lastError'])).toEqual([{ lastError: 'HTTP 500: Bad' }]);
    });
});
