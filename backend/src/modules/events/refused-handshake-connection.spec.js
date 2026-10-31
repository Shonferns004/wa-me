"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
// Loaded ahead of AuthService: the two modules import each other, and the gateway's constructor metadata
// must see a defined AuthService.
const events_gateway_1 = require("./events.gateway");
const typeorm_1 = require("typeorm");
const ws_1 = __importDefault(require("ws"));
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const config_1 = require("@nestjs/config");
const auth_service_1 = require("../auth/auth.service");
const api_key_usage_tracker_service_1 = require("../auth/api-key-usage-tracker.service");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const chat_scope_service_1 = require("../auth/chat-scope.service");
const audit_service_1 = require("../audit/audit.service");
const redis_io_adapter_1 = require("./redis-io.adapter");
/**
 * A peer whose /events handshake the gateway refuses must not keep its connection. The real gateway in a
 * real Nest application behind the production adapter (RedisIoAdapter, which also refuses the root
 * namespace), driven with raw Engine.IO frames by a peer that answers pings. Only the connect timeout is
 * shortened (400 ms instead of 45 s) so the test can wait past it.
 */
class ShortConnectTimeoutAdapter extends redis_io_adapter_1.RedisIoAdapter {
    createIOServer(port, options) {
        const short = { ...options, connectTimeout: 400, pingInterval: 150, pingTimeout: 150 };
        return super.createIOServer(port, short);
    }
}
describe('a refused /events handshake', () => {
    let app;
    let peers;
    let port;
    let redisEnabled;
    beforeEach(async () => {
        redisEnabled = process.env.REDIS_ENABLED;
        delete process.env.REDIS_ENABLED;
        peers = [];
        const moduleRef = await testing_1.Test.createTestingModule({
            providers: [
                events_gateway_1.EventsGateway,
                {
                    provide: auth_service_1.AuthService,
                    useValue: { validateApiKey: jest.fn().mockRejectedValue(new common_1.UnauthorizedException('Invalid API key')) },
                },
                { provide: audit_service_1.AuditService, useValue: { logWarn: jest.fn().mockResolvedValue(null) } },
                { provide: config_1.ConfigService, useValue: { get: (_key, fallback) => fallback } },
                { provide: chat_scope_service_1.ChatScopeService, useValue: new chat_scope_service_1.ChatScopeService() },
            ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        app.useWebSocketAdapter(new ShortConnectTimeoutAdapter(app));
        await app.listen(0, '127.0.0.1');
        port = app.getHttpServer().address().port;
    });
    afterEach(async () => {
        for (const ws of peers)
            ws.terminate();
        await app.close();
        if (redisEnabled === undefined)
            delete process.env.REDIS_ENABLED;
        else
            process.env.REDIS_ENABLED = redisEnabled;
    });
    /** A websocket peer that answers pings like a live client and sends `connect` once the server has opened. */
    const open = (connect) => {
        const ws = new ws_1.default(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
        peers.push(ws);
        const frames = [];
        let closed = false;
        ws.on('message', (data) => {
            const frame = data.toString();
            frames.push(frame);
            if (frame === '2')
                ws.send('3');
            if (frame.startsWith('0'))
                ws.send(connect);
        });
        ws.on('close', () => {
            closed = true;
        });
        return { frames, closed: () => closed };
    };
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    it('closes the connection of a peer refused for its key, as it does one refused at the root namespace', async () => {
        const refused = open('40/events,{"apiKey":"owa_k1_not_a_key"}');
        const rootPeer = open('40');
        await wait(250);
        // The refusal reached the peer: an UNAUTHORIZED frame, then the namespace disconnect.
        expect(refused.frames.some(frame => frame.includes('UNAUTHORIZED'))).toBe(true);
        expect(refused.frames.some(frame => frame.startsWith('41/events'))).toBe(true);
        // Past the connect timeout neither peer holds a namespace, and neither may hold a connection.
        await wait(500);
        expect({ rootPeerClosed: rootPeer.closed(), refusedPeerClosed: refused.closed() }).toEqual({
            rootPeerClosed: true,
            refusedPeerClosed: true,
        });
    });
    it('leaves no connection behind for handshakes refused by the per-address handshake limit either', async () => {
        // 10 handshakes a minute per address are validated; the rest are refused as RATE_LIMITED.
        const opened = Array.from({ length: 12 }, () => open('40/events,{"apiKey":"owa_k1_not_a_key"}'));
        await wait(900);
        expect(opened.some(peer => peer.frames.some(frame => frame.includes('RATE_LIMITED')))).toBe(true);
        expect(opened.filter(peer => !peer.closed()).length).toBe(0);
    });
});
/**
 * Every place the gateway refuses a socket closes its transport, not just its namespace: the handshake
 * window, a missing key, the per-key socket cap, a refused key, a subscribe whose key stopped validating, and
 * a subscribe whose chat fence changed. Real AuthService over in-memory SQLite.
 */
describe('every /events refusal closes the transport', () => {
    const SESSION = 'a0b1c2d3-0000-4000-8000-000000000001';
    const LIMIT_ENV = ['WS_RATE_LIMIT_HANDSHAKE_MAX', 'WS_MAX_SOCKETS_PER_KEY'];
    let ds;
    let keys;
    let service;
    let gateway;
    const saved = {};
    const makeSocket = (apiKey) => {
        const sock = {
            id: `sock-${Math.random().toString(36).slice(2)}`,
            handshake: { headers: {}, query: {}, auth: apiKey === undefined ? {} : { apiKey }, address: '203.0.113.21' },
            data: {},
            emit: jest.fn(),
            disconnect: jest.fn(() => {
                sock.disconnected = true;
            }),
            join: jest.fn(),
            leave: jest.fn(),
            rooms: new Set(),
            disconnected: false,
        };
        return sock;
    };
    const connect = async (apiKey) => {
        const sock = makeSocket(apiKey);
        await gateway.handleConnection(sock);
        return sock;
    };
    const subscribe = (sock) => gateway.handleMessage(sock, { type: 'subscribe', sessionId: SESSION, events: ['*'] });
    const build = () => {
        const moduleRef = { get: () => gateway };
        service = new auth_service_1.AuthService(keys, new api_key_usage_tracker_service_1.ApiKeyUsageTracker(keys), moduleRef);
        return new events_gateway_1.EventsGateway(service, { logWarn: jest.fn().mockResolvedValue(null) }, { get: (_key, fallback) => fallback });
    };
    beforeAll(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [api_key_entity_1.ApiKey], synchronize: true });
        await ds.initialize();
        keys = ds.getRepository(api_key_entity_1.ApiKey);
    });
    afterAll(async () => {
        await ds.destroy();
    });
    beforeEach(async () => {
        for (const name of LIMIT_ENV)
            saved[name] = process.env[name];
        await keys.clear();
        gateway = build();
    });
    afterEach(() => {
        for (const name of LIMIT_ENV) {
            if (saved[name] === undefined)
                delete process.env[name];
            else
                process.env[name] = saved[name];
        }
    });
    it('closes a handshake refused by the per-address window', async () => {
        process.env.WS_RATE_LIMIT_HANDSHAKE_MAX = '1';
        gateway = build();
        await connect('owa_k1_not_a_key');
        const second = await connect('owa_k1_not_a_key');
        expect(second.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
        expect(second.disconnect).toHaveBeenCalledWith(true);
    });
    it('closes a handshake that carries no key', async () => {
        const sock = await connect();
        expect(sock.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'UNAUTHORIZED' }));
        expect(sock.disconnect).toHaveBeenCalledWith(true);
    });
    it('closes a handshake over the per-key socket cap', async () => {
        process.env.WS_MAX_SOCKETS_PER_KEY = '1';
        gateway = build();
        const { rawKey } = await service.createApiKey({ name: 'cap probe', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const first = await connect(rawKey);
        expect(first.disconnect).not.toHaveBeenCalled();
        const second = await connect(rawKey);
        expect(second.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'RATE_LIMITED' }));
        expect(second.disconnect).toHaveBeenCalledWith(true);
    });
    it('closes a handshake whose key is refused', async () => {
        const sock = await connect('owa_k1_not_a_key');
        expect(sock.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'UNAUTHORIZED' }));
        expect(sock.disconnect).toHaveBeenCalledWith(true);
    });
    it('closes a socket whose key stopped validating before a subscribe', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'revoked later', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const sock = await connect(rawKey);
        await keys.update({ id: apiKey.id }, { isActive: false });
        await subscribe(sock);
        expect(sock.disconnect).toHaveBeenCalledWith(true);
    });
    it('closes a socket whose chat fence changed before a subscribe', async () => {
        const { apiKey, rawKey } = await service.createApiKey({
            name: 'fence moved',
            role: api_key_entity_1.ApiKeyRole.VIEWER,
            allowedChats: ['628111000111@c.us'],
        });
        const sock = await connect(rawKey);
        await keys.update({ id: apiKey.id }, { allowedChats: ['628222000222@c.us'] });
        await subscribe(sock);
        expect(sock.emit).toHaveBeenCalledWith('message', expect.objectContaining({ code: 'UNAUTHORIZED', message: 'API key authorization changed; please reconnect' }));
        expect(sock.disconnect).toHaveBeenCalledWith(true);
    });
});
