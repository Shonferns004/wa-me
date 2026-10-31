"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const crypto_1 = require("crypto");
const config_1 = require("@nestjs/config");
const typeorm_1 = require("typeorm");
const session_entity_1 = require("../session/entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
const webhook_entity_1 = require("./entities/webhook.entity");
const webhook_delivery_failure_entity_1 = require("./entities/webhook-delivery-failure.entity");
const webhook_outbox_event_entity_1 = require("./entities/webhook-outbox-event.entity");
const webhook_outbox_service_1 = require("./webhook-outbox.service");
const webhook_redrive_service_1 = require("./webhook-redrive.service");
const webhook_service_1 = require("./webhook.service");
const record_delivery_failure_1 = require("./utils/record-delivery-failure");
const _1787200000000_DeduplicateTerminalWebhookFailures_1 = require("../../database/migrations/1787200000000-DeduplicateTerminalWebhookFailures");
const chat_media_archive_service_1 = require("../chat-media/chat-media-archive.service");
const message_metadata_1 = require("../message/message-metadata");
const describePostgres = process.env.DATABASE_TYPE === 'postgres' ? describe : describe.skip;
describePostgres('webhook and media recovery on PostgreSQL', () => {
    let admin;
    let ds;
    let second;
    let failures;
    let webhooks;
    let sessionId;
    const schema = `recovery_${process.pid}_${(0, crypto_1.randomBytes)(4).toString('hex')}`;
    const logger = { error: jest.fn() };
    const config = new config_1.ConfigService({ webhook: { failurePayloadRetentionHours: 24 } });
    const input = {
        sessionId: '',
        webhookId: '',
        event: 'message.received',
        url: 'https://receiver.example',
        idempotencyKey: 'key',
        attempts: 3,
        lastError: 'HTTP 503: unavailable',
    };
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
        const scoped = {
            ...options,
            schema,
            extra: { options: `-c search_path=${schema},public` },
            entities: [session_entity_1.Session, webhook_entity_1.Webhook, webhook_delivery_failure_entity_1.WebhookDeliveryFailure, webhook_outbox_event_entity_1.WebhookOutboxEvent, message_entity_1.Message],
        };
        ds = await new typeorm_1.DataSource({ ...scoped, synchronize: true }).initialize();
        second = await new typeorm_1.DataSource(scoped).initialize();
        failures = ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
        webhooks = ds.getRepository(webhook_entity_1.Webhook);
        sessionId = (await ds.getRepository(session_entity_1.Session).save({ name: schema })).id;
        input.sessionId = sessionId;
    });
    beforeEach(async () => {
        await failures.clear();
        await ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent).clear();
        await webhooks.clear();
        const webhook = await webhooks.save({ sessionId, url: input.url, events: ['message.received'], active: true });
        input.webhookId = webhook.id;
    });
    afterEach(() => jest.restoreAllMocks());
    afterAll(async () => {
        if (second?.isInitialized)
            await second.destroy();
        if (ds?.isInitialized)
            await ds.destroy();
        if (admin?.isInitialized) {
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
            await admin.destroy();
        }
    });
    it('filters subscriptions before a batch and advances past failed deliveries', async () => {
        await failures.save({
            ...input,
            webhookId: 'removed',
            idempotencyKey: 'skipped',
            payload: {},
            createdAt: new Date(Date.now() - 3000),
        });
        await failures.save({
            ...input,
            idempotencyKey: 'bad',
            payload: { body: 'bad' },
            createdAt: new Date(Date.now() - 2000),
        });
        await failures.save({
            ...input,
            idempotencyKey: 'healthy',
            payload: { body: 'healthy' },
            createdAt: new Date(Date.now() - 1000),
        });
        await failures.save({ ...input, event: 'message.ack', idempotencyKey: 'unsubscribed', payload: {} });
        await failures.save({
            ...input,
            idempotencyKey: 'expired',
            payload: {},
            createdAt: new Date(Date.now() - 25 * 3600000),
        });
        const delivery = {
            redeliver: jest.fn(async (_webhook, _session, _event, key) => {
                if (key === 'bad') {
                    await (0, record_delivery_failure_1.recordWebhookDeliveryFailure)(failures, logger, { ...input, idempotencyKey: key, attempts: 1 });
                    return 'failed';
                }
                await failures.delete({ idempotencyKey: key });
                return 'delivered';
            }),
        };
        const service = new webhook_redrive_service_1.WebhookRedriveService(webhooks, failures, delivery, config);
        expect(await service.redrive({ limit: 1 }, [sessionId])).toMatchObject({ failed: 1, remaining: 2 });
        expect(await service.redrive({ limit: 1 }, [sessionId])).toMatchObject({ delivered: 1, remaining: 1 });
        expect(delivery.redeliver.mock.calls.map(call => call[3])).toEqual(['bad', 'healthy']);
        const unsubscribed = await failures.findOneByOrFail({ idempotencyKey: 'unsubscribed' });
        await webhooks.update({ id: input.webhookId }, { events: ['*'] });
        expect(await service.redrive({ ids: [unsubscribed.id] })).toMatchObject({ delivered: 1, remaining: 0 });
        const disabled = new webhook_redrive_service_1.WebhookRedriveService(webhooks, failures, delivery, new config_1.ConfigService({ webhook: { failurePayloadRetentionHours: 0 } }));
        expect(await disabled.redrive({})).toMatchObject({ redriven: 0, remaining: 0 });
        expect(await service.redrive({ sessionId: 'outside' }, [sessionId])).toMatchObject({ redriven: 0 });
    });
    // The replay skips an opt-in event for a webhook that only subscribes to '*' without spending an
    // attempt, so a row selected for one would sit at the head of every batch for good.
    it('leaves an opt-in event out of the batch of a webhook that only subscribes to *', async () => {
        await webhooks.update({ id: input.webhookId }, { events: ['*'] });
        await failures.save({
            ...input,
            event: 'message.receipt',
            idempotencyKey: 'receipt',
            payload: {},
            createdAt: new Date(Date.now() - 2000),
        });
        await failures.save({
            ...input,
            idempotencyKey: 'ordinary',
            payload: { body: 'ok' },
            createdAt: new Date(Date.now() - 1000),
        });
        const delivery = {
            redeliver: jest.fn(async (_webhook, _session, _event, key) => {
                await failures.delete({ idempotencyKey: key });
                return 'delivered';
            }),
        };
        const service = new webhook_redrive_service_1.WebhookRedriveService(webhooks, failures, delivery, config);
        expect(await service.redrive({ limit: 1 }, [sessionId])).toMatchObject({ delivered: 1, remaining: 0 });
        expect(delivery.redeliver.mock.calls.map(call => call[3])).toEqual(['ordinary']);
        await webhooks.update({ id: input.webhookId }, { events: ['message.receipt'] });
        expect(await service.redrive({ limit: 1 }, [sessionId])).toMatchObject({ delivered: 1, remaining: 0 });
        expect(delivery.redeliver.mock.calls.map(call => call[3])).toEqual(['ordinary', 'receipt']);
    });
    it('lists a row of a deleted webhook or another session as not replayable, a disabled one as replayable', async () => {
        const listing = new webhook_service_1.WebhookService(webhooks, failures, {}, config, {});
        const save = () => webhooks.save({ sessionId, url: input.url, events: ['message.received'] });
        const [disabled, deleted] = [await save(), await save()];
        await webhooks.update({ id: disabled.id }, { active: false });
        const add = (webhookId, idempotencyKey, rowSession = sessionId) => failures.save(failures.create({ ...input, webhookId, idempotencyKey, sessionId: rowSession, payload: { id: 1 } }));
        const rows = {
            kept: await add(input.webhookId, 'kept'),
            disabled: await add(disabled.id, 'disabled'),
            deleted: await add(deleted.id, 'deleted'),
            foreign: await add(input.webhookId, 'foreign', (0, crypto_1.randomUUID)()),
        };
        await webhooks.delete({ id: deleted.id });
        const flags = new Map((await listing.listDeliveryFailures({}, null)).map(r => [r.id, r.replayable]));
        expect(flags.get(rows.kept.id)).toBe(true);
        expect(flags.get(rows.disabled.id)).toBe(true);
        expect(flags.get(rows.deleted.id)).toBe(false);
        expect(flags.get(rows.foreign.id)).toBe(false);
    });
    it('converges two connections on one terminal identity', async () => {
        const result = await Promise.all([
            (0, record_delivery_failure_1.recordWebhookDeliveryFailure)(failures, logger, input),
            (0, record_delivery_failure_1.recordWebhookDeliveryFailure)(second.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure), logger, { ...input, attempts: 1 }),
        ]);
        expect(result.sort()).toEqual([false, true]);
        expect(await failures.count()).toBe(1);
        expect((await failures.findOneByOrFail({ idempotencyKey: 'key' })).attempts).toBe(4);
    });
    it('upgrades duplicate terminal records while preserving replay data', async () => {
        await ds.query(`DROP INDEX "${schema}"."UQ_webhook_delivery_failures_terminal"`);
        await failures.save({ ...input, payload: { body: 'retained' } });
        await failures.save({ ...input, attempts: 5 });
        const migration = new _1787200000000_DeduplicateTerminalWebhookFailures_1.DeduplicateTerminalWebhookFailures1787200000000();
        await migration.up(ds.createQueryRunner());
        expect(await failures.count()).toBe(1);
        const row = await failures.findOneOrFail({ where: { idempotencyKey: 'key' }, select: { id: true, payload: true } });
        expect(row.payload).toEqual({ body: 'retained' });
        await expect(failures.save({ ...input })).rejects.toThrow();
    });
    it('advances outbox pages without rounding PostgreSQL timestamp precision', async () => {
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        for (let i = 1; i <= 3; i++) {
            const row = await repository.save({
                webhookId: input.webhookId,
                sessionId,
                event: input.event,
                idempotencyKey: `precision-${i}`,
                deliveryId: `job-${i}`,
                payload: { body: 'retained' },
                state: 'queued',
                attempts: 0,
            });
            await ds.query('UPDATE webhook_outbox_events SET "createdAt" = $1 WHERE id = $2', [
                `2026-01-01 00:00:00.000${i}00`,
                row.id,
            ]);
        }
        let cursor;
        for (let i = 1; i <= 3; i++) {
            const rows = await outbox.findStale(new Date(), 1, cursor);
            expect(rows.map(row => row.idempotencyKey)).toEqual([`precision-${i}`]);
            cursor = rows[0].id;
        }
        expect(await outbox.findStale(new Date(), 1, cursor)).toEqual([]);
    });
    it('retains queued outbox data and never reopens a settled row', async () => {
        const repository = ds.getRepository(webhook_outbox_event_entity_1.WebhookOutboxEvent);
        const outbox = new webhook_outbox_service_1.WebhookOutboxService(repository);
        await outbox.open({ ...input, payload: { body: 'retained' }, deliveryId: 'job' });
        await outbox.markQueued(input.webhookId, 'key', 'job');
        await repository.update({ idempotencyKey: 'key' }, { createdAt: new Date(0) });
        expect(await outbox.pruneSettled(1)).toBe(0);
        expect(await outbox.findStale(new Date(), 1)).toEqual([
            expect.objectContaining({ state: 'queued', payload: { body: 'retained' } }),
        ]);
        await outbox.close(input.webhookId, 'key', 'dispatched');
        await outbox.markQueued(input.webhookId, 'key', 'late');
        expect(await repository.findOneByOrFail({ idempotencyKey: 'key' })).toMatchObject({
            state: 'dispatched',
            payload: null,
        });
    });
    it('publishes verified media atomically and preserves concurrent metadata', async () => {
        const repository = ds.getRepository(message_entity_1.Message);
        const bytes = Buffer.from('verified media');
        const storage = {
            putFile: jest.fn().mockResolvedValue(undefined),
            getFile: jest.fn().mockResolvedValue(bytes),
            deleteFile: jest.fn().mockResolvedValue(undefined),
        };
        const archive = new chat_media_archive_service_1.ChatMediaArchiveService(repository, storage, new config_1.ConfigService({ chatMedia: { archiveEnabled: true, inlineMode: 'archive' } }));
        const metadata = { media: { mimetype: 'image/png', data: bytes.toString('base64') } };
        const base = {
            sessionId,
            chatId: 'test@c.us',
            from: 'test@c.us',
            to: 'self@c.us',
            body: '',
            type: 'image',
            direction: message_entity_1.MessageDirection.INCOMING,
            status: message_entity_1.MessageStatus.SENT,
            timestamp: 1,
            metadata,
        };
        const first = await repository.save({ ...base, waMessageId: 'success' });
        expect(await archive.archive(first)).not.toBeNull();
        expect((await repository.findOneByOrFail({ id: first.id })).metadata?.media).toMatchObject({
            archived: true,
            omitted: true,
        });
        await (0, message_metadata_1.updateMessageMetadata)(repository, { id: first.id }, current => (0, message_metadata_1.mergeSentMetadata)(current, { ...metadata, quotedMessage: { id: 'quoted' } }));
        const archived = (await repository.findOneByOrFail({ id: first.id })).metadata;
        expect(archived.media).toMatchObject({ archived: true, omitted: true });
        expect(archived.quotedMessage).toEqual({ id: 'quoted' });
        const update = repository.update.bind(repository);
        jest.spyOn(repository, 'update').mockImplementationOnce(async (where, patch) => {
            await update({ id: first.id }, { metadata: { ...archived, reactions: { a: 'first' } } });
            return update(where, patch);
        });
        await (0, message_metadata_1.updateMessageMetadata)(repository, { id: first.id }, current => ({
            ...current,
            reactions: { ...current.reactions, b: 'second' },
        }));
        expect((await repository.findOneByOrFail({ id: first.id })).metadata).toMatchObject({
            media: { archived: true, omitted: true },
            reactions: { a: 'first', b: 'second' },
        });
        const raced = await repository.save({ ...base, waMessageId: 'race' });
        const find = repository.findOne.bind(repository);
        jest.spyOn(repository, 'findOne').mockImplementationOnce(async (options) => {
            const snapshot = await find(options);
            await repository.update({ id: raced.id }, { metadata: { ...metadata, reactions: ['kept'] } });
            return snapshot;
        });
        expect(await archive.archive(raced)).toBeNull();
        expect(await repository.findOneByOrFail({ id: raced.id })).toMatchObject({
            mediaPath: null,
            metadata: { ...metadata, reactions: ['kept'] },
        });
    });
});
