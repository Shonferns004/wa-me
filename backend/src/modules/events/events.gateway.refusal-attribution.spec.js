"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const auth_service_1 = require("../auth/auth.service");
const api_key_usage_tracker_service_1 = require("../auth/api-key-usage-tracker.service");
const audit_service_1 = require("../audit/audit.service");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const events_gateway_1 = require("./events.gateway");
/**
 * A refusal of a STORED key over the socket names that key in its audit row, as the REST guard,
 * Bull Board and the MCP gate do. Real AuthService and AuditService over an in-memory SQLite main
 * database, so the assertion reads the persisted row whatever way the key reaches it.
 */
describe('EventsGateway audit rows for a refused stored key', () => {
    const CLIENT_IP = '203.0.113.9';
    let ds;
    let keys;
    let audits;
    let service;
    let gateway;
    const makeSocket = (apiKey) => {
        const sock = {
            id: 'sock-attr',
            handshake: { headers: {}, query: {}, auth: { apiKey }, address: CLIENT_IP },
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
    const failedRows = async () => {
        // logWarn is fire-and-forget in the gateway; let the insert settle.
        await new Promise(resolve => setTimeout(resolve, 20));
        return audits.find({ where: { action: audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED } });
    };
    beforeAll(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [api_key_entity_1.ApiKey, audit_log_entity_1.AuditLog],
            synchronize: true,
        });
        await ds.initialize();
        keys = ds.getRepository(api_key_entity_1.ApiKey);
        audits = ds.getRepository(audit_log_entity_1.AuditLog);
    });
    afterAll(async () => {
        await ds.destroy();
    });
    beforeEach(async () => {
        await keys.clear();
        await audits.clear();
        const moduleRef = { get: () => gateway };
        service = new auth_service_1.AuthService(keys, new api_key_usage_tracker_service_1.ApiKeyUsageTracker(keys), moduleRef);
        gateway = new events_gateway_1.EventsGateway(service, new audit_service_1.AuditService(audits), {
            get: (_key, fallback) => fallback,
        });
    });
    it('names the key when a subscribe is refused because the key was revoked after connect', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'ws revoked later', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const sock = makeSocket(rawKey);
        await gateway.handleConnection(sock);
        expect(sock.disconnect).not.toHaveBeenCalled();
        // Revoked outside this process's API (another admin tool, a direct write), so no eviction ran.
        await keys.update({ id: apiKey.id }, { isActive: false });
        await gateway.handleMessage(sock, {
            type: 'subscribe',
            sessionId: 'a0b1c2d3-0000-4000-8000-000000000001',
            events: ['message.received'],
        });
        expect(sock.disconnect).toHaveBeenCalled();
        const rows = await failedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].errorMessage).toBe('API key is revoked');
        expect({ apiKeyId: rows[0].apiKeyId, apiKeyName: rows[0].apiKeyName }).toEqual({
            apiKeyId: apiKey.id,
            apiKeyName: 'ws revoked later',
        });
    });
    it('names the key when the handshake is refused for an expired stored key', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'ws expired', role: api_key_entity_1.ApiKeyRole.VIEWER });
        await keys.update({ id: apiKey.id }, { expiresAt: new Date(Date.now() - 60_000) });
        const sock = makeSocket(rawKey);
        await gateway.handleConnection(sock);
        expect(sock.disconnect).toHaveBeenCalled();
        const rows = await failedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].errorMessage).toBe('API key has expired');
        expect(rows[0].apiKeyId).toBe(apiKey.id);
    });
    it('names no key when the handshake presents one that matches no row', async () => {
        await service.createApiKey({ name: 'bystander', role: api_key_entity_1.ApiKeyRole.ADMIN });
        const sock = makeSocket('owa_k1_matches_no_row');
        await gateway.handleConnection(sock);
        expect(sock.disconnect).toHaveBeenCalled();
        const rows = await failedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].errorMessage).toBe('Invalid API key');
        expect({ apiKeyId: rows[0].apiKeyId, apiKeyName: rows[0].apiKeyName }).toEqual({
            apiKeyId: null,
            apiKeyName: null,
        });
    });
    it('writes the WebSocket row without a request id, as before', async () => {
        const { apiKey, rawKey } = await service.createApiKey({ name: 'ws shape', role: api_key_entity_1.ApiKeyRole.VIEWER });
        await keys.update({ id: apiKey.id }, { isActive: false });
        await gateway.handleConnection(makeSocket(rawKey));
        const rows = await failedRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].metadata).toEqual({ surface: 'websocket' });
    });
});
