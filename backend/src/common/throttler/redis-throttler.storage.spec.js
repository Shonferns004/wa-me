"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const redis_throttler_storage_1 = require("./redis-throttler.storage");
const makeRedis = (opts) => ({
    eval: jest.fn().mockResolvedValue([opts.hits, opts.ttlMs]),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
});
describe('RedisThrottlerStorage', () => {
    it('atomically increments, arms/repairs the TTL, and reports remaining seconds', async () => {
        const redis = makeRedis({ hits: 1, ttlMs: 1500 });
        const rec = await new redis_throttler_storage_1.RedisThrottlerStorage(redis).increment('1.2.3.4', 1000, 10, 60000, 'short');
        expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("redis.call('INCR', KEYS[1])"), 1, 'openwa:throttle:short:1.2.3.4', '1000');
        expect(rec).toEqual({ totalHits: 1, timeToExpire: 2, isBlocked: false, timeToBlockExpire: 0 });
    });
    // The block is the counter itself, so it lifts when the window key expires, not after blockDuration:
    // advertising blockDuration made a client that honours Retry-After wait up to an hour for nothing.
    it('over the limit (incr>limit) is blocked until the window expires, in seconds', async () => {
        const redis = makeRedis({ hits: 1001, ttlMs: 4200 });
        const rec = await new redis_throttler_storage_1.RedisThrottlerStorage(redis).increment('k', 3600000, 1000, 3600000, 'long');
        expect(rec.isBlocked).toBe(true);
        expect(rec.totalHits).toBe(1001);
        expect(rec.timeToBlockExpire).toBe(5); // ceil(4200ms / 1000), not the 3600 s blockDuration
    });
    it('never advertises a zero Retry-After on a blocked request', async () => {
        const redis = makeRedis({ hits: 11, ttlMs: 0 });
        const rec = await new redis_throttler_storage_1.RedisThrottlerStorage(redis).increment('k', 1000, 10, 60000, 'short');
        expect(rec.isBlocked).toBe(true);
        expect(rec.timeToBlockExpire).toBe(1);
    });
    it('fails OPEN on a Redis error (returns a non-blocking record so the limiter never self-DoSes)', async () => {
        const redis = makeRedis({ hits: 1, ttlMs: 1000 });
        redis.eval.mockRejectedValue(new Error('ECONNREFUSED'));
        const rec = await new redis_throttler_storage_1.RedisThrottlerStorage(redis).increment('k', 1000, 10, 60000, 'short');
        expect(rec).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
    });
    it('fails open FAST when the client rejects while disconnected (no queue/timeout stall)', async () => {
        const redis = makeRedis({ hits: 1, ttlMs: 1000 });
        // The exact rejection ioredis produces with enableOfflineQueue:false — issued commands must not
        // wait for reconnect; the request is decided on the fail-open path immediately.
        redis.eval.mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
        const storage = new redis_throttler_storage_1.RedisThrottlerStorage(redis);
        const result = await Promise.race([
            storage.increment('k', 1000, 10, 60000, 'short'),
            new Promise(resolve => setTimeout(() => resolve('slow'), 100)),
        ]);
        expect(result).toEqual({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 });
    });
    it('attaches an error listener so connection failures surface as structured logs, never unhandled events', () => {
        const redis = makeRedis({ hits: 1, ttlMs: 1000 });
        new redis_throttler_storage_1.RedisThrottlerStorage(redis);
        expect(redis.on).toHaveBeenCalledWith('error', expect.any(Function));
        const calls = redis.on.mock.calls;
        const errorCall = calls.find(([event]) => event === 'error');
        expect(errorCall).toBeDefined();
        const listener = errorCall[1];
        expect(() => listener(new Error('ECONNREFUSED'))).not.toThrow();
    });
    it('onModuleDestroy drains the client with quit() and always disconnects the socket', async () => {
        const redis = makeRedis({ hits: 1, ttlMs: 1000 });
        await new redis_throttler_storage_1.RedisThrottlerStorage(redis).onModuleDestroy();
        expect(redis.quit).toHaveBeenCalledTimes(1);
        expect(redis.disconnect).toHaveBeenCalledTimes(1);
    });
    it('onModuleDestroy still disconnects when quit() rejects (client already offline)', async () => {
        const redis = makeRedis({ hits: 1, ttlMs: 1000 });
        // With enableOfflineQueue:false a quit() issued mid-outage rejects instantly WITHOUT closing the
        // socket — teardown must not propagate that rejection nor skip the disconnect.
        redis.quit.mockRejectedValue(new Error("Stream isn't writeable and enableOfflineQueue options is false"));
        const storage = new redis_throttler_storage_1.RedisThrottlerStorage(redis);
        await expect(storage.onModuleDestroy()).resolves.toBeUndefined();
        expect(redis.disconnect).toHaveBeenCalledTimes(1);
    });
    it('onModuleDestroy does not hang when quit() never settles (deadline, then force disconnect)', async () => {
        jest.useFakeTimers();
        try {
            const redis = makeRedis({ hits: 1, ttlMs: 1000 });
            redis.quit.mockReturnValue(new Promise(() => undefined)); // half-open socket: QUIT never answered
            const storage = new redis_throttler_storage_1.RedisThrottlerStorage(redis);
            const destroy = storage.onModuleDestroy();
            await jest.advanceTimersByTimeAsync(redis_throttler_storage_1.THROTTLER_REDIS_QUIT_TIMEOUT_MS);
            await destroy;
            expect(redis.disconnect).toHaveBeenCalledTimes(1);
        }
        finally {
            jest.useRealTimers();
        }
    });
});
