"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const message_type_backfill_service_1 = require("./message-type-backfill.service");
describe('MessageTypeBackfillService', () => {
    const makeService = (opts = {}) => {
        const query = opts.query ?? jest.fn().mockResolvedValue(undefined);
        const runner = {
            hasTable: jest.fn().mockResolvedValue(opts.hasTable ?? true),
            query,
            release: jest.fn().mockResolvedValue(undefined),
        };
        const repo = { manager: { connection: { createQueryRunner: () => runner } } };
        const config = {
            get: (key, fallback) => (key === 'dataDatabase.synchronize' ? opts.synchronize : fallback),
        };
        return { service: new message_type_backfill_service_1.MessageTypeBackfillService(repo, config), runner, query };
    };
    it('converts the legacy wwebjs tokens with one statement under DATABASE_SYNCHRONIZE=true', async () => {
        const { service, runner, query } = makeService({ synchronize: true });
        await service.onApplicationBootstrap();
        expect(query).toHaveBeenCalledTimes(1);
        const [sql] = query.mock.calls[0];
        expect(sql).toContain(`WHEN 'chat' THEN 'text'`);
        expect(sql).toContain(`WHEN 'ptt' THEN 'voice'`);
        expect(sql).toContain(`WHEN 'multi_vcard' THEN 'contact'`);
        expect(runner.release).toHaveBeenCalledTimes(1);
    });
    it.each([false, undefined])('leaves a migration-managed database to the migration (synchronize: %s)', async (synchronize) => {
        const { service, runner, query } = makeService({ synchronize });
        await service.onApplicationBootstrap();
        expect(query).not.toHaveBeenCalled();
        expect(runner.release).not.toHaveBeenCalled();
    });
    it('does nothing when the config is not injected', async () => {
        const query = jest.fn();
        const repo = {
            manager: { connection: { createQueryRunner: () => ({ query }) } },
        };
        await expect(new message_type_backfill_service_1.MessageTypeBackfillService(repo).onApplicationBootstrap()).resolves.toBeUndefined();
        expect(query).not.toHaveBeenCalled();
    });
    it('does not crash boot if the backfill query fails, and still releases the runner', async () => {
        const { service, runner } = makeService({
            synchronize: true,
            query: jest.fn().mockRejectedValue(new Error('db down')),
        });
        await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
        expect(runner.release).toHaveBeenCalledTimes(1);
    });
});
