"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Enable the MCP server before AppModule is imported.
process.env.MCP_ENABLED = 'true';
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("../src/app.module");
const app_validation_1 = require("../src/config/app-validation");
const auth_service_1 = require("../src/modules/auth/auth.service");
const api_key_entity_1 = require("../src/modules/auth/entities/api-key.entity");
const session_service_1 = require("../src/modules/session/session.service");
const message_service_1 = require("../src/modules/message/message.service");
// --- MCP protocol helpers ---
const MCP_HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
};
function jsonRpcRequest(method, params = {}, id = 1) {
    return { jsonrpc: '2.0', method, params, id };
}
/**
 * Parse the MCP response. The StreamableHTTP transport sends:
 *   - `text/event-stream` SSE for normal requests (tools/list, tools/call)
 *   - `application/json` directly for some responses
 *
 * Supertest parses `application/json` into `.body`. For SSE, `.body` is empty
 * and the actual content is in `.text` (raw string). We try both.
 */
function parseMcpResponse(res) {
    // If supertest parsed JSON, body will be a non-empty object
    if (typeof res.body === 'object' && res.body !== null && Object.keys(res.body).length > 0) {
        return res.body;
    }
    // SSE format: "event: message\ndata: {...}\n\n" — extract the data line
    const text = res.text ?? '';
    const match = /^data:\s*(.+)$/m.exec(text);
    if (match) {
        return JSON.parse(match[1]);
    }
    // Plain JSON text fallback
    if (text.trim().startsWith('{')) {
        return JSON.parse(text);
    }
    return {};
}
// --- Test suite ---
describe('MCP server (e2e)', () => {
    let app;
    let viewerKey;
    let chatKey;
    let ipKey;
    const scopedSession = '11111111-1111-4111-8111-111111111111';
    const initialize = () => jsonRpcRequest('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
    });
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        const authService = app.get(auth_service_1.AuthService);
        viewerKey = (await authService.createApiKey({ name: 'e2e-mcp-viewer', role: api_key_entity_1.ApiKeyRole.VIEWER })).rawKey;
        chatKey = (await authService.createApiKey({
            name: 'e2e-mcp-chat',
            role: api_key_entity_1.ApiKeyRole.VIEWER,
            allowedSessions: [scopedSession],
            allowedChats: ['628123@c.us'],
        })).rawKey;
        ipKey = (await authService.createApiKey({ name: 'e2e-mcp-ip', role: api_key_entity_1.ApiKeyRole.VIEWER, allowedIps: ['127.0.0.1'] }))
            .rawKey;
    }, 30_000);
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore TypeORM multi-datasource teardown quirk */
        }
    });
    // ---------------------------------------------------------------------------
    // 1. MCP endpoint is reachable with a key: initialize succeeds
    // ---------------------------------------------------------------------------
    it('POST /mcp with initialize request responds with 200', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('X-API-Key', viewerKey)
            .send(initialize());
        expect([200, 202]).toContain(res.status);
    });
    // ---------------------------------------------------------------------------
    // 2. tools/list returns the tool catalogue with known names
    // ---------------------------------------------------------------------------
    it('tools/list returns the tool catalogue', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('Authorization', `Bearer ${viewerKey}`)
            .send(jsonRpcRequest('tools/list'));
        expect(res.status).toBe(200);
        const body = parseMcpResponse(res);
        const result = body.result;
        expect(result).toBeDefined();
        const tools = result?.tools;
        expect(Array.isArray(tools)).toBe(true);
        expect(tools.length).toBeGreaterThan(0);
        // Verify well-known tools are present
        const names = tools.map(t => t.name);
        expect(names).toContain('SessionFindAll');
    });
    // ---------------------------------------------------------------------------
    // 3. Every request needs a valid key: nothing is answered before it
    // ---------------------------------------------------------------------------
    it('initialize without a key answers 401 and discloses no server info', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).post('/mcp').set(MCP_HEADERS).send(initialize());
        expect(res.status).toBe(401);
        expect(res.headers['www-authenticate']).toBe('Bearer');
        expect(res.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing API key' }, id: null });
        expect(res.text).not.toContain('serverInfo');
    });
    it('tools/list with an unknown key answers 401 and lists no tools', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('X-API-Key', 'owa_k1_not-a-real-key')
            .send(jsonRpcRequest('tools/list'));
        expect(res.status).toBe(401);
        expect(res.text).not.toContain('SessionFindAll');
    });
    it('tools/call without a key answers 401', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .send(jsonRpcRequest('tools/call', { name: 'SessionFindAll', arguments: {} }));
        expect(res.status).toBe(401);
    });
    it('refuses a key with an IP allow-list at the gate, as every MCP tool call does', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('X-API-Key', ipKey)
            .send(jsonRpcRequest('tools/list'));
        expect(res.status).toBe(403);
        expect(res.headers['www-authenticate']).toBeUndefined();
    });
    // Role, session and chat scope stay per tool call, answered in-band once the key passes the gate.
    it('a chat-restricted key passes the gate and is refused in-band by the tool call', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('X-API-Key', chatKey)
            .send(jsonRpcRequest('tools/call', { name: 'SessionFindAll', arguments: {} }));
        expect(res.status).toBe(200);
        const result = parseMcpResponse(res).result;
        expect(result?.isError).toBe(true);
        const content = result?.content;
        expect(content?.find(c => c.type === 'text')?.text ?? '').toMatch(/restricted to selected chats/i);
    });
    it('a chat-restricted key receives only allowed chats before pagination', async () => {
        const list = jest
            .spyOn(app.get(session_service_1.SessionService), 'listChats')
            .mockResolvedValue([{ id: 'other@c.us' }, { id: '628123@c.us' }]);
        try {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/mcp')
                .set(MCP_HEADERS)
                .set('X-API-Key', chatKey)
                .send(jsonRpcRequest('tools/call', { name: 'SessionGetChats', arguments: { sessionId: scopedSession, limit: 1 } }));
            expect(res.status).toBe(200);
            const result = parseMcpResponse(res).result;
            expect(result.isError).not.toBe(true);
            expect(JSON.parse(result.content[0].text)).toEqual([{ id: '628123@c.us' }]);
            expect(list).toHaveBeenCalledWith(scopedSession, undefined);
        }
        finally {
            list.mockRestore();
        }
    });
    it('a chat-restricted key cannot read history from another chat', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('X-API-Key', chatKey)
            .send(jsonRpcRequest('tools/call', {
            name: 'MessageHistory',
            arguments: { sessionId: scopedSession, chatId: 'other@c.us' },
        }));
        expect(res.status).toBe(200);
        const result = parseMcpResponse(res).result;
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('API key not authorized for this chat');
    });
    it('chat filtering retains the session fence', async () => {
        const list = jest.spyOn(app.get(session_service_1.SessionService), 'listChats');
        try {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/mcp')
                .set(MCP_HEADERS)
                .set('X-API-Key', chatKey)
                .send(jsonRpcRequest('tools/call', {
                name: 'SessionGetChats',
                arguments: { sessionId: '22222222-2222-4222-8222-222222222222' },
            }));
            expect(res.status).toBe(200);
            const result = parseMcpResponse(res).result;
            expect(result.isError).toBe(true);
            expect(list).not.toHaveBeenCalled();
        }
        finally {
            list.mockRestore();
        }
    });
    // ---------------------------------------------------------------------------
    // 4. Unsupported Content-Type → 415
    // ---------------------------------------------------------------------------
    it('POST /mcp with wrong Content-Type returns 415', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set({ 'Content-Type': 'text/plain', Accept: 'application/json, text/event-stream' })
            .set('X-API-Key', viewerKey)
            .send('{}');
        expect(res.status).toBe(415);
    });
    // ---------------------------------------------------------------------------
    // 4b. GET / DELETE: the stateless transport offers no SSE stream and no session,
    //     so both answer 405 (an SDK client treats anything else as an error)
    // ---------------------------------------------------------------------------
    it('GET and DELETE /mcp answer 405 with Allow: POST', async () => {
        const server = app.getHttpServer();
        const get = await (0, supertest_1.default)(server).get('/mcp').set('Accept', 'text/event-stream');
        expect(get.status).toBe(405);
        expect(get.headers['allow']).toBe('POST');
        expect(get.body).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
        const del = await (0, supertest_1.default)(server).delete('/mcp');
        expect(del.status).toBe(405);
        expect(del.headers['allow']).toBe('POST');
    });
    it('a session-restricted key cannot invoke a tool for another session', async () => {
        const { rawKey } = await app.get(auth_service_1.AuthService).createApiKey({
            name: 'e2e-mcp-session',
            role: api_key_entity_1.ApiKeyRole.VIEWER,
            allowedSessions: [scopedSession],
        });
        const chats = jest.spyOn(app.get(session_service_1.SessionService), 'getChats').mockResolvedValue([]);
        const call = (sessionId) => (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('X-API-Key', rawKey)
            .send(jsonRpcRequest('tools/call', { name: 'SessionGetChats', arguments: { sessionId } }));
        try {
            const allowed = await call(scopedSession);
            expect(allowed.status).toBe(200);
            expect(parseMcpResponse(allowed).result.isError).not.toBe(true);
            expect(chats).toHaveBeenCalledWith(scopedSession, { limit: undefined, offset: undefined });
            chats.mockClear();
            const denied = await call('22222222-2222-4222-8222-222222222222');
            expect(denied.status).toBe(200);
            const result = parseMcpResponse(denied).result;
            expect(result.isError).toBe(true);
            expect(JSON.parse(result.content[0].text)).toMatchObject({ message: 'API key not authorized for this session' });
            expect(chats).not.toHaveBeenCalled();
        }
        finally {
            chats.mockRestore();
        }
    });
});
describe('MCP read-only mode and tool rate limits (e2e)', () => {
    let app;
    const savedEnv = {
        MCP_READONLY: process.env.MCP_READONLY,
        MCP_RATE_LIMIT_MAX: process.env.MCP_RATE_LIMIT_MAX,
    };
    beforeAll(async () => {
        process.env.MCP_READONLY = 'true';
        process.env.MCP_RATE_LIMIT_MAX = '2';
        const moduleFixture = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
    }, 30_000);
    afterAll(async () => {
        try {
            await app?.close();
        }
        finally {
            for (const [key, value] of Object.entries(savedEnv)) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
    });
    it('hides write tools and refuses a direct write call even with an admin key', async () => {
        const { rawKey } = await app.get(auth_service_1.AuthService).createApiKey({ name: 'e2e-mcp-readonly', role: api_key_entity_1.ApiKeyRole.ADMIN });
        const send = jest.spyOn(app.get(message_service_1.MessageService), 'sendText');
        try {
            const listed = await (0, supertest_1.default)(app.getHttpServer())
                .post('/mcp')
                .set(MCP_HEADERS)
                .set('X-API-Key', rawKey)
                .send(jsonRpcRequest('tools/list'));
            expect(listed.status).toBe(200);
            const tools = parseMcpResponse(listed).result.tools;
            expect(tools.map(tool => tool.name)).toContain('SessionFindAll');
            expect(tools.map(tool => tool.name)).not.toContain('MessageSendText');
            const called = await (0, supertest_1.default)(app.getHttpServer())
                .post('/mcp')
                .set(MCP_HEADERS)
                .set('X-API-Key', rawKey)
                .send(jsonRpcRequest('tools/call', {
                name: 'MessageSendText',
                arguments: { sessionId: '11111111-1111-4111-8111-111111111111', chatId: '628123@c.us', text: 'test' },
            }));
            expect(called.status).toBe(200);
            const result = parseMcpResponse(called).result;
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toMatch(/Tool MessageSendText not found/i);
            expect(send).not.toHaveBeenCalled();
        }
        finally {
            send.mockRestore();
        }
    });
    it('returns an in-band rate-limit error before the handler and keeps another key usable', async () => {
        const auth = app.get(auth_service_1.AuthService);
        const first = await auth.createApiKey({ name: 'e2e-mcp-rate-first', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const second = await auth.createApiKey({ name: 'e2e-mcp-rate-second', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const stats = jest.spyOn(app.get(session_service_1.SessionService), 'getStats');
        const call = (key) => (0, supertest_1.default)(app.getHttpServer())
            .post('/mcp')
            .set(MCP_HEADERS)
            .set('X-API-Key', key)
            .send(jsonRpcRequest('tools/call', { name: 'SessionGetStats', arguments: {} }));
        try {
            for (let i = 0; i < 2; i++) {
                const response = await call(first.rawKey);
                expect(response.status).toBe(200);
                expect(parseMcpResponse(response).result.isError).not.toBe(true);
            }
            expect(stats).toHaveBeenCalledTimes(2);
            const limited = await call(first.rawKey);
            expect(limited.status).toBe(200);
            const result = parseMcpResponse(limited).result;
            expect(result.isError).toBe(true);
            expect(JSON.parse(result.content[0].text)).toMatchObject({ message: 'MCP rate limit exceeded' });
            expect(stats).toHaveBeenCalledTimes(2);
            const independent = await call(second.rawKey);
            expect(independent.status).toBe(200);
            expect(parseMcpResponse(independent).result.isError).not.toBe(true);
            expect(stats).toHaveBeenCalledTimes(3);
        }
        finally {
            stats.mockRestore();
        }
    });
});
