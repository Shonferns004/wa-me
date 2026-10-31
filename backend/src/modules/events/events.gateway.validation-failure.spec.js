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
 * A key the gateway could not read is not a key it refused. When the key table fails, the handshake and the
 * subscribe answer a server failure, as the REST guard lets the error through as a 500, and no
 * API_KEY_AUTH_FAILED row is written for a credential nobody judged. Real AuthService and AuditService over
 * in-memory SQLite; only the key lookup is made to fail.
 */
describe('EventsGateway when the API key table cannot be read', () => {
    const SESSION = 'a0b1c2d3-0000-4000-8000-000000000002';
    let ds;
    let keys;
    let audits;
    let service;
    let gateway;
    const makeSocket = (apiKey) => {
        const sock = {
            id: 'sock-db',
            handshake: { headers: {}, query: {}, auth: { apiKey }, address: '203.0.113.31' },
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
    const lookupFailsOnce = () => {
        jest
            .spyOn(keys, 'findOne')
            .mockRejectedValueOnce(new typeorm_1.QueryFailedError('SELECT', [], new Error('SQLITE_BUSY: database is locked')));
    };
    const codes = (sock) => sock.emit.mock.calls.map(([, frame]) => frame.code);
    const failedRows = async () => {
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
        jest.restoreAllMocks();
        await keys.clear();
        await audits.clear();
        const moduleRef = { get: () => gateway };
        service = new auth_service_1.AuthService(keys, new api_key_usage_tracker_service_1.ApiKeyUsageTracker(keys), moduleRef);
        gateway = new events_gateway_1.EventsGateway(service, new audit_service_1.AuditService(audits), {
            get: (_key, fallback) => fallback,
        });
    });
    it('answers the handshake as a server failure and audits no refused credential', async () => {
        const { rawKey } = await service.createApiKey({ name: 'db down at connect', role: api_key_entity_1.ApiKeyRole.VIEWER });
        lookupFailsOnce();
        const sock = makeSocket(rawKey);
        await gateway.handleConnection(sock);
        expect(codes(sock)).toEqual(['INTERNAL_ERROR']);
        expect(sock.disconnect).toHaveBeenCalled();
        expect(await failedRows()).toEqual([]);
    });
    it('answers the subscribe as a server failure, keeps the socket and joins nothing', async () => {
        const { rawKey } = await service.createApiKey({ name: 'db down at subscribe', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const sock = makeSocket(rawKey);
        await gateway.handleConnection(sock);
        expect(sock.disconnect).not.toHaveBeenCalled();
        lookupFailsOnce();
        const failed = (await gateway.handleMessage(sock, {
            type: 'subscribe',
            sessionId: SESSION,
            events: ['message.received'],
        }));
        expect(failed.code).toBe('INTERNAL_ERROR');
        expect(sock.disconnect).not.toHaveBeenCalled();
        expect(sock.join).not.toHaveBeenCalled();
        expect(await failedRows()).toEqual([]);
        // Once the table answers again the same socket subscribes normally.
        const retried = (await gateway.handleMessage(sock, {
            type: 'subscribe',
            sessionId: SESSION,
            events: ['message.received'],
        }));
        expect(retried.type).toBe('subscribed');
    });
    it('still refuses and audits a handshake whose key is not a string', async () => {
        const sock = makeSocket(12345);
        await gateway.handleConnection(sock);
        expect(codes(sock)).toEqual(['UNAUTHORIZED']);
        expect(sock.disconnect).toHaveBeenCalled();
        expect(await failedRows()).toHaveLength(1);
    });
});
