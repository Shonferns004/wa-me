"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const throttler_1 = require("@nestjs/throttler");
const redis_throttler_storage_1 = require("./redis-throttler.storage");
describe('RedisThrottlerStorage lifecycle wiring', () => {
    it('Nest invokes onModuleDestroy on the storage instance registered via a factory provider', async () => {
        const redis = {
            eval: jest.fn(),
            on: jest.fn(),
            quit: jest.fn().mockResolvedValue('OK'),
            disconnect: jest.fn(),
        };
        const storage = new redis_throttler_storage_1.RedisThrottlerStorage(redis);
        // Mirror @nestjs/throttler's ThrottlerStorageProvider: a useFactory returning options.storage.
        const moduleRef = await testing_1.Test.createTestingModule({
            providers: [
                { provide: 'THROTTLER_OPTIONS', useValue: { storage } },
                {
                    provide: throttler_1.ThrottlerStorage,
                    useFactory: (options) => options.storage,
                    inject: ['THROTTLER_OPTIONS'],
                },
            ],
        }).compile();
        await moduleRef.close();
        expect(redis.quit).toHaveBeenCalledTimes(1);
        expect(redis.disconnect).toHaveBeenCalledTimes(1);
    });
});
