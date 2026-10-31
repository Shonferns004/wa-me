"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const auth_service_1 = require("../auth/auth.service");
const api_key_usage_tracker_service_1 = require("../auth/api-key-usage-tracker.service");
const events_gateway_1 = require("./events.gateway");
/**
 * The gateway's periodic re-validation of the keys behind its live sockets, against a REAL
 * better-sqlite3 api_keys table and the real AuthService/ApiKeyUsageTracker.
 *
 * A stub cannot carry this: the sweep's whole risk is a fingerprint that moves for a column the
 * authentication hot path rewrites on its own (lastUsedAt, usageCount, updatedAt), which would
 * disconnect every live client once a minute. Only a real table, written by the real tracker,
 * proves it does not. The changes that never reach this process, a key deleted, revoked, expired or
 * narrowed by a direct write to this node's main database, are expressed the same way: straight to
 * the table.
 */
describe('EventsGateway API-key authorization sweep', () => {
    const CLIENT_IP = '203.0.113.5';
    let ds;
    let repo;
    let service;
    let gateway;
    const makeSocket = (apiKey, id = 'sock-1') => {
        const sock = {
            id,
            handshake: { headers: {}, query: {}, auth: { apiKey }, address: CLIENT_IP },
            data: {},
            emit: jest.fn(),
            // Socket.IO flips `disconnected` synchronously on disconnect(); the gateway reads it.
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
    const asSocket = (s) => s;
    const connect = async (rawKey, id = 'sock-1') => {
        const sock = makeSocket(rawKey, id);
        await gateway.handleConnection(asSocket(sock));
        expect(sock.disconnect).not.toHaveBeenCalled();
        return sock;
    };
    const subscribe = async (sock, sessionId, events, requestId = 'r1') => (await gateway.handleMessage(asSocket(sock), {
        type: 'subscribe',
        sessionId,
        events,
        requestId,
    }));
    const sweep = (now) => gateway.sweepApiKeyAuthorization(now);
    const evictionMessage = (sock) => sock.emit.mock.calls.map(([, frame]) => frame).find(frame => frame?.code === 'UNAUTHORIZED')
        ?.message;
    beforeAll(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [api_key_entity_1.ApiKey], synchronize: true });
        await ds.initialize();
        repo = ds.getRepository(api_key_entity_1.ApiKey);
    });
    afterAll(async () => {
        await ds.destroy();
    });
    beforeEach(async () => {
        await repo.clear();
        const moduleRef = { get: () => gateway };
        service = new auth_service_1.AuthService(repo, new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repo), moduleRef);
        gateway = new events_gateway_1.EventsGateway(service, { logWarn: jest.fn().mockResolvedValue(null) }, { get: (_key, fallback) => fallback });
    });
    it('evicts nobody when only the usage statistics moved', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'usage probe', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const sock = await connect(rawKey);
        // What the authentication hot path writes on its own, for every key in use.
        await repo.update({ id: apiKey.id }, { lastUsedAt: new Date(Date.now() + 5_000), usageCount: 99 });
        await service.validateApiKey(rawKey, CLIENT_IP);
        await sweep();
        expect(sock.disconnect).not.toHaveBeenCalled();
    });
    it('evicts nobody for a rename or a reordered allowlist', async () => {
        const { apiKey, rawKey } = await service.createApiKey({
            name: 'scoped key',
            allowedSessions: ['sess-b', 'sess-a'],
            allowedIps: [CLIENT_IP, '198.51.100.9'],
        });
        const sock = await connect(rawKey);
        await service.update(apiKey.id, {
            name: 'renamed key',
            allowedSessions: ['sess-a', 'sess-b'],
            allowedIps: ['198.51.100.9', CLIENT_IP],
        });
        expect(sock.disconnect).not.toHaveBeenCalled();
        await sweep();
        expect(sock.disconnect).not.toHaveBeenCalled();
    });
    it('evicts with the deleted reason when the row is gone', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'doomed key' });
        const sock = await connect(rawKey);
        await repo.delete({ id: apiKey.id });
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key has been deleted');
    });
    it('evicts with the revoked reason when the row went inactive elsewhere', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'revoked key' });
        const sock = await connect(rawKey);
        await repo.update({ id: apiKey.id }, { isActive: false });
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key has been revoked');
    });
    it('evicts with the expired reason once the stored expiry has passed', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'expiring key' });
        const sock = await connect(rawKey);
        // An expiry change also moves the authorization fingerprint; the client must still be told the
        // reason that actually applies.
        await repo.update({ id: apiKey.id }, { expiresAt: new Date(Date.now() - 1_000) });
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key has expired');
    });
    it('keeps a socket whose key has no expiry or a future one', async () => {
        const open = await connect((await service.createApiKey({ name: 'no expiry' })).rawKey, 'sock-1');
        const future = await service.createApiKey({
            name: 'future expiry',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        const later = await connect(future.rawKey, 'sock-2');
        await sweep();
        expect(open.disconnect).not.toHaveBeenCalled();
        expect(later.disconnect).not.toHaveBeenCalled();
    });
    it('evicts a socket when its stored expiry becomes invalid', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'invalid expiry' });
        const sock = await connect(rawKey);
        await repo.query('UPDATE api_keys SET expiresAt = ? WHERE id = ?', ['not-a-date', apiKey.id]);
        const current = await repo.findOneByOrFail({ id: apiKey.id });
        expect(current.expiresAt).toBeInstanceOf(Date);
        expect(Number.isFinite(current.expiresAt.getTime())).toBe(false);
        await expect(service.validateApiKey(rawKey, CLIENT_IP)).rejects.toThrow('API key has expired');
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key has expired');
    });
    it('evicts on the snapshot expiry when the api_keys table cannot be read', async () => {
        const { rawKey } = await service.createApiKey({
            name: 'expiring key',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        });
        const sock = await connect(rawKey);
        jest.spyOn(service, 'findAuthorizationStates').mockRejectedValue(new Error('database is locked'));
        await sweep(Date.now() + 7_200_000);
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key has expired');
    });
    it('evicts a socket that subscribed under a widening the row no longer carries', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'scoped key', allowedSessions: ['sess-a'] });
        const sock = await connect(rawKey);
        // Unscoped by a write this process never saw, subscribed to every session under it, then put
        // back. The snapshot matches the row again, but the wildcard rooms the widening granted are
        // never revisited, so the socket keeps receiving every session's events unless it is evicted.
        await repo.update({ id: apiKey.id }, { allowedSessions: null });
        expect((await subscribe(sock, '*', ['*'])).type).toBe('subscribed');
        await repo.update({ id: apiKey.id }, { allowedSessions: ['sess-a'] });
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key authorization changed; please reconnect');
    });
    it('evicts when the key was narrowed by a write this process never saw', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'narrowed key' });
        const sock = await connect(rawKey);
        await repo.update({ id: apiKey.id }, { allowedSessions: ['sess-1'] });
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key authorization changed; please reconnect');
    });
    it('evicts a socket that connected while its key was being revoked', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'racing key' });
        // The revoke commits (and evicts, finding nothing) after this socket validated and before it is
        // registered: without the sweep its snapshot stays authoritative for the life of the connection.
        const validate = jest.spyOn(service, 'validateApiKey').mockImplementationOnce(async (raw, ip) => {
            const key = await auth_service_1.AuthService.prototype.validateApiKey.call(service, raw, ip);
            await repo.update({ id: apiKey.id }, { isActive: false });
            gateway.evictApiKey(apiKey.id, 'revoked');
            return key;
        });
        const sock = await connect(rawKey);
        validate.mockRestore();
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key has been revoked');
    });
    it('does not refresh the connect-time snapshot on subscribe, so a narrowed key is still evicted', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'wildcard key' });
        const sock = await connect(rawKey);
        await subscribe(sock, '*', ['*']);
        // Narrowed elsewhere. The wildcard rooms joined above are never revisited, so the socket keeps
        // them until it is evicted; re-subscribing within the new scope must not launder its snapshot.
        await repo.update({ id: apiKey.id }, { allowedSessions: ['sess-1'] });
        const res = (await subscribe(sock, 'sess-1', ['message.received'], 'r2'));
        expect(res.type).toBe('subscribed');
        await sweep();
        expect(sock.disconnect).toHaveBeenCalledWith(true);
    });
    it('joins no room when the socket is evicted while its subscribe is in flight', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'in flight key' });
        const sock = await connect(rawKey);
        jest.spyOn(service, 'validateApiKey').mockImplementationOnce(async (raw, ip) => {
            const key = await auth_service_1.AuthService.prototype.validateApiKey.call(service, raw, ip);
            gateway.evictApiKey(apiKey.id, 'revoked'); // an operator revoke landing on the same tick
            return key;
        });
        const res = (await subscribe(sock, 'sess-1', ['message.received']));
        expect(res.code).toBe('UNAUTHORIZED');
        expect(sock.join).not.toHaveBeenCalled();
    });
    it('still evicts synchronously on an operator-driven change, before any sweep', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'demoted key' });
        const sock = await connect(rawKey);
        await service.update(apiKey.id, { role: api_key_entity_1.ApiKeyRole.VIEWER });
        expect(sock.disconnect).toHaveBeenCalledWith(true);
        expect(evictionMessage(sock)).toBe('API key authorization changed; please reconnect');
    });
    it('reads nothing when no socket is connected', async () => {
        const read = jest.spyOn(service, 'findAuthorizationStates');
        await sweep();
        expect(read).not.toHaveBeenCalled();
    });
});
