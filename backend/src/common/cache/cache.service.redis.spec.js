"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_net_1 = require("node:net");
const node_events_1 = require("node:events");
const ioredis_1 = __importDefault(require("ioredis"));
const cache_service_1 = require("./cache.service");
const logger_service_1 = require("../services/logger.service");
jest.mock('ioredis');
// A local RESP peer keeps real ioredis command deadlines, queues and reconnection in the test.
describe('CacheService connected response deadlines', () => {
    const RealRedis = jest.requireActual('ioredis').default;
    const RedisMock = ioredis_1.default;
    let service;
    let client;
    let blocked;
    let received;
    let sockets;
    let server;
    let operations;
    beforeEach(async () => {
        operations = [];
        for (const method of ['log', 'warn', 'debug']) {
            jest.spyOn(logger_service_1.LoggerService.prototype, method).mockImplementation(() => undefined);
        }
        blocked = new Set();
        received = jest.fn();
        sockets = new Set();
        server = (0, node_net_1.createServer)(socket => {
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            let pending = Buffer.alloc(0);
            socket.on('data', chunk => {
                pending = Buffer.concat([pending, chunk]);
                while (pending.length) {
                    const headerEnd = pending.indexOf('\r\n');
                    if (headerEnd < 0)
                        return;
                    const count = Number(pending.subarray(1, headerEnd).toString());
                    let cursor = headerEnd + 2;
                    const args = [];
                    for (let i = 0; i < count; i++) {
                        const end = pending.indexOf('\r\n', cursor);
                        if (end < 0)
                            return;
                        const length = Number(pending.subarray(cursor + 1, end).toString());
                        if (pending.length < end + 2 + length + 2)
                            return;
                        args.push(pending.subarray(end + 2, end + 2 + length).toString());
                        cursor = end + 2 + length + 2;
                    }
                    pending = pending.subarray(cursor);
                    const command = args[0].toLowerCase();
                    received(command);
                    if (!blocked.has(command))
                        socket.write(command === 'get' ? '$-1\r\n' : '+OK\r\n');
                }
            });
        });
        server.listen(0, '127.0.0.1');
        await (0, node_events_1.once)(server, 'listening');
        const address = server.address();
        RedisMock.mockImplementation((options) => {
            client = new RealRedis({
                ...options,
                host: '127.0.0.1',
                port: address.port,
                username: undefined,
                password: undefined,
                tls: undefined,
                enableReadyCheck: false,
            });
            return client;
        });
        service = new cache_service_1.CacheService({ get: () => true });
        expect(await service.isAvailable()).toBe(false);
        if (client.status !== 'ready')
            await (0, node_events_1.once)(client, 'ready');
    });
    afterEach(async () => {
        const ended = new Promise(resolve => client.once('end', () => resolve()));
        await service.onModuleDestroy();
        await ended;
        await Promise.allSettled(operations);
        expect(client.status).toBe('end');
        for (const socket of sockets)
            socket.destroy();
        await new Promise(resolve => server.close(() => resolve()));
        RedisMock.mockReset();
        jest.restoreAllMocks();
    });
    const withinDeadline = async (operation) => {
        operations.push(operation);
        let timer;
        try {
            return await Promise.race([
                operation,
                new Promise(resolve => {
                    timer = setTimeout(() => resolve('pending'), 3000);
                }),
            ]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    };
    it('fails silent connected polls softly, clears their queue and recovers on the same client', async () => {
        expect(await service.isAvailable()).toBe(true);
        blocked.add('ping');
        const recovered = new Promise(resolve => client.once('ready', () => resolve()));
        expect(await withinDeadline(Promise.all([service.isAvailable(), service.isAvailable(), service.isAvailable()]))).toEqual([false, false, false]);
        blocked.clear();
        await recovered;
        expect(await service.isAvailable()).toBe(true);
        expect(client.commandQueue.length).toBe(0);
        expect(RedisMock).toHaveBeenCalledTimes(1);
    }, 10000);
    it('bounds silent reads and writes without replaying an expired write after reconnect', async () => {
        blocked.add('get');
        blocked.add('setex');
        const recovered = new Promise(resolve => client.once('ready', () => resolve()));
        // The client the service built carries the deadlines, so commands issued on it directly settle too.
        expect(await withinDeadline(Promise.allSettled([client.get('s1'), client.setex('s1', 60, 'ready')]))).toEqual([
            expect.objectContaining({ status: 'rejected' }),
            expect.objectContaining({ status: 'rejected' }),
        ]);
        blocked.clear();
        await recovered;
        expect(await service.isAvailable()).toBe(true);
        expect(received.mock.calls.filter(([command]) => command === 'setex')).toHaveLength(1);
        expect(client.commandQueue.length).toBe(0);
    }, 10000);
});
