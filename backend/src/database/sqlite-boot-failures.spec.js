"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const promises_1 = require("node:fs/promises");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const typeorm_1 = require("typeorm");
const webhook_delivery_failure_entity_1 = require("../modules/webhook/entities/webhook-delivery-failure.entity");
const pg_boot_migrations_1 = require("./pg-boot-migrations");
describe('SQLite synchronize upgrades with legacy terminal failures', () => {
    it.each([false, true])('normalizes duplicates before creating the unique index (payload column=%s)', async (hasPayload) => {
        const directory = await (0, promises_1.mkdtemp)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'openwa-failure-upgrade-'));
        const options = {
            type: 'better-sqlite3',
            database: (0, node_path_1.join)(directory, 'data.sqlite'),
            entities: [webhook_delivery_failure_entity_1.WebhookDeliveryFailure],
            synchronize: true,
        };
        let ds;
        try {
            ds = await new typeorm_1.DataSource(options).initialize();
            await ds.query('DROP INDEX "UQ_webhook_delivery_failures_terminal"');
            const row = {
                webhookId: 'w',
                sessionId: 's1',
                event: 'message.received',
                url: 'https://receiver.example',
                idempotencyKey: 'k',
                attempts: 5,
                lastError: 'HTTP 503',
                createdAt: new Date('2026-10-05'),
            };
            await ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure).save([
                { ...row, id: 'a' },
                { ...row, id: 'b', attempts: 3, payload: { body: 'retained' } },
                { ...row, id: 'c', attempts: 0 },
                { ...row, id: 'd', idempotencyKey: undefined },
                { ...row, id: 'e', idempotencyKey: undefined },
            ]);
            if (!hasPayload)
                await ds.query('ALTER TABLE webhook_delivery_failures DROP COLUMN payload');
            await ds.destroy();
            ds = await (0, pg_boot_migrations_1.createBootDataSource)(options);
            if (!ds.isInitialized)
                await ds.initialize();
            const repository = ds.getRepository(webhook_delivery_failure_entity_1.WebhookDeliveryFailure);
            expect((await repository.find({ order: { id: 'ASC' } })).map(failure => failure.id)).toEqual([
                hasPayload ? 'b' : 'a',
                'c',
                'd',
                'e',
            ]);
            await expect(repository.insert({ ...row, id: 'f' })).rejects.toThrow(/UNIQUE constraint failed/);
        }
        finally {
            if (ds?.isInitialized)
                await ds.destroy();
            await (0, promises_1.rm)(directory, { recursive: true, force: true });
        }
    });
});
