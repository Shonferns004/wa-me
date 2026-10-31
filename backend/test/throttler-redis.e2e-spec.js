"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_crypto_1 = require("node:crypto");
const net = __importStar(require("node:net"));
const ioredis_1 = __importDefault(require("ioredis"));
const redis_throttler_storage_1 = require("../src/common/throttler/redis-throttler.storage");
const throttler_redis_client_1 = require("../src/common/throttler/throttler-redis.client");
// Runs the throttler's Lua script against a real Redis: the unit spec mocks eval, so a wrong ARGV
// index or a repair branch that is never taken would pass there, and increment() fails open on a
// script error, which only logs. Gated on Redis the same way as queue-on.e2e-spec.ts: a developer
// box without one skips, GitHub Actions (which provides one) fails instead of skipping.
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const probeRedis = (host, port, timeoutMs) => {
    const script = `const s = require('net').connect(${port}, ${JSON.stringify(host)});` +
        `const t = setTimeout(() => process.exit(2), ${timeoutMs});` +
        `s.on('connect', () => { clearTimeout(t); s.end(); process.exit(0); });` +
        `s.on('error', () => { clearTimeout(t); process.exit(1); });`;
    return (0, node_child_process_1.spawnSync)(process.execPath, ['-e', script], { timeout: timeoutMs + 1000 }).status === 0;
};
const REDIS_AVAILABLE = probeRedis(REDIS_HOST, REDIS_PORT, 1000);
if (!REDIS_AVAILABLE && process.env.GITHUB_ACTIONS === 'true') {
    throw new Error(`throttler e2e: no Redis at ${REDIS_HOST}:${REDIS_PORT} under GitHub Actions; refusing to skip`);
}
const describeWithRedis = REDIS_AVAILABLE ? describe : describe.skip;
describeWithRedis('RedisThrottlerStorage against a real Redis', () => {
    const TTL_MS = 5000;
    const LIMIT = 2;
    const throttler = `e2e-${(0, node_crypto_1.randomUUID)()}`;
    const keyOf = (key) => `openwa:throttle:${throttler}:${key}`;
    let redis;
    let storage;
    let warn;
    beforeAll(() => {
        redis = new ioredis_1.default({ host: REDIS_HOST, port: REDIS_PORT, maxRetriesPerRequest: 1 });
        storage = new redis_throttler_storage_1.RedisThrottlerStorage(redis);
        warn = jest.spyOn(storage.logger, 'warn');
    });
    afterEach(async () => {
        // A script error is swallowed by the fail-open path; this is where it would show.
        expect(warn).not.toHaveBeenCalled();
        const keys = await redis.keys(keyOf('*'));
        if (keys.length)
            await redis.del(...keys);
    });
    afterAll(async () => {
        await storage.onModuleDestroy();
    });
    it('arms the window TTL on the first hit', async () => {
        const record = await storage.increment('first', TTL_MS, LIMIT, 60_000, throttler);
        expect(record).toEqual({ totalHits: 1, timeToExpire: 5, isBlocked: false, timeToBlockExpire: 0 });
        const pttl = await redis.pttl(keyOf('first'));
        expect(pttl).toBeGreaterThan(0);
        expect(pttl).toBeLessThanOrEqual(TTL_MS);
    });
    it('resets a counter left without a TTL to a fresh first hit and arms its TTL', async () => {
        await redis.set(keyOf('legacy'), 999);
        const record = await storage.increment('legacy', TTL_MS, LIMIT, 60_000, throttler);
        expect(record).toEqual({ totalHits: 1, timeToExpire: 5, isBlocked: false, timeToBlockExpire: 0 });
        expect(await redis.get(keyOf('legacy'))).toBe('1');
        expect(await redis.pttl(keyOf('legacy'))).toBeGreaterThan(0);
    });
    it('blocks past the limit until the window expires, without extending it', async () => {
        for (let i = 0; i < LIMIT; i++)
            await storage.increment('busy', TTL_MS, LIMIT, 60_000, throttler);
        const record = await storage.increment('busy', TTL_MS, LIMIT, 60_000, throttler);
        const pttl = await redis.pttl(keyOf('busy'));
        expect(record.totalHits).toBe(LIMIT + 1);
        expect(record.isBlocked).toBe(true);
        expect(record.timeToBlockExpire).toBeGreaterThanOrEqual(Math.ceil(pttl / 1000));
        expect(record.timeToBlockExpire).toBeLessThanOrEqual(TTL_MS / 1000);
        expect(pttl).toBeGreaterThan(0);
    });
});
// A Redis that stays connected and stops answering never errors its socket. The client the app builds has to
// turn that into one command timeout for the first guarded request and an immediate allow for everything after
// it, instead of one timeout per throttler tier on every request.
describeWithRedis('the throttler client against a Redis that stops answering', () => {
    const throttler = `e2e-stall-${(0, node_crypto_1.randomUUID)()}`;
    const sockets = new Set();
    let blackhole = false;
    let proxy;
    let storage;
    let client;
    let cleaner;
    beforeAll(async () => {
        proxy = net.createServer(peer => {
            const upstream = net.connect(REDIS_PORT, REDIS_HOST);
            sockets.add(peer).add(upstream);
            peer.on('data', data => {
                if (!blackhole)
                    upstream.write(data);
            });
            upstream.on('data', data => {
                if (!blackhole)
                    peer.write(data);
            });
            const end = () => {
                peer.destroy();
                upstream.destroy();
            };
            peer.on('close', end);
            upstream.on('close', end);
            peer.on('error', () => undefined);
            upstream.on('error', () => undefined);
        });
        await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
        client = new ioredis_1.default({
            ...(0, throttler_redis_client_1.buildThrottlerRedisOptions)(),
            host: '127.0.0.1',
            port: proxy.address().port,
        });
        client.on('error', () => undefined);
        await new Promise(resolve => client.once('ready', () => resolve()));
        storage = new redis_throttler_storage_1.RedisThrottlerStorage(client);
        jest.spyOn(storage.logger, 'warn').mockImplementation(() => { });
        cleaner = new ioredis_1.default({ host: REDIS_HOST, port: REDIS_PORT });
    });
    afterAll(async () => {
        blackhole = false;
        // The client can still report the stall it was put through after this file is done, when the mocked logger is
        // gone and a log line fails the whole run: its errors have nobody left to tell.
        client.removeAllListeners('error');
        client.on('error', () => undefined);
        const keys = await cleaner.keys(`openwa:throttle:*:${throttler}*`);
        if (keys.length)
            await cleaner.del(...keys);
        cleaner.disconnect();
        await storage.onModuleDestroy();
        for (const socket of sockets)
            socket.destroy();
        await new Promise(resolve => proxy.close(() => resolve()));
    });
    const timed = async (tier) => {
        const started = Date.now();
        await storage.increment(throttler, 10_000, 5, 0, tier);
        return Date.now() - started;
    };
    it('costs the first request one command timeout and every request after it nothing', async () => {
        expect((await storage.increment(throttler, 10_000, 5, 0, 'warmup')).totalHits).toBe(1);
        blackhole = true;
        const firstRequest = [await timed('short'), await timed('medium'), await timed('long')];
        // The tiers behind the first command do not each wait out a timeout of their own.
        expect(firstRequest[1] + firstRequest[2]).toBeLessThan(1000);
        expect(firstRequest[0] + firstRequest[1] + firstRequest[2]).toBeLessThan(3000);
        expect(await timed('short')).toBeLessThan(500);
    }, 20_000);
});
