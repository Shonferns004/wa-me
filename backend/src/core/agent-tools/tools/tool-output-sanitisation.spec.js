"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Tests for tool output sanitisation.
 * Each test documents a data-leak or schema bug that was present before the fix.
 */
const common_1 = require("@nestjs/common");
const tool_invoker_1 = require("../tool-invoker");
const webhook_tools_1 = require("./webhook.tools");
const session_tools_1 = require("./session.tools");
const tool_result_1 = require("../../../modules/mcp/tool-result");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAuth(over = {}) {
    return {
        validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null, ...over }),
        hasPermission: jest.fn().mockReturnValue(true),
    };
}
/** Minimal webhook entity shape that carries the sensitive fields. */
function stubWebhookEntity() {
    return {
        id: 'wh-1',
        sessionId: 'sess-1',
        url: 'https://example.com/hook',
        events: ['message.received'],
        filters: null,
        active: true,
        retryCount: 3,
        lastTriggeredAt: null,
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
        // sensitive fields that MUST be stripped:
        secret: 'super-secret-hmac-key',
        headers: { Authorization: 'Bearer token123' },
    };
}
/** Minimal session entity shape that carries the sensitive fields. */
function stubSessionEntity() {
    return {
        id: 'sess-1',
        name: 'my-bot',
        status: 'ready',
        phone: '628123456789',
        pushName: 'John',
        connectedAt: new Date('2024-01-01'),
        lastActiveAt: new Date('2024-01-02'),
        createdAt: new Date('2024-01-01'),
        updatedAt: new Date('2024-01-02'),
        lastError: null,
        // sensitive fields that MUST be stripped:
        config: { apiToken: 'secret-config-value' },
        proxyUrl: 'socks5://user:pass@proxy:1080',
    };
}
// ---------------------------------------------------------------------------
// FIX 1: webhook tools must not leak `secret` or `headers`
// ---------------------------------------------------------------------------
describe('FIX 1: webhook tools strip secret + headers', () => {
    const entity = stubWebhookEntity();
    it('WebhooksList output has no secret or headers keys', async () => {
        const webhookSvc = {
            findAll: jest.fn().mockResolvedValue([entity]),
        };
        const tool = (0, webhook_tools_1.webhookTools)(webhookSvc).find(t => t.name === 'WebhooksList');
        const auth = makeAuth();
        const result = (await (0, tool_invoker_1.invokeTool)(tool, {}, 'key', auth));
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('secret');
        expect(result[0]).not.toHaveProperty('headers');
        expect(result[0]).toHaveProperty('id', 'wh-1');
    });
    it('WebhookFindBySession output has no secret or headers keys', async () => {
        const webhookSvc = {
            findBySession: jest.fn().mockResolvedValue([entity]),
        };
        const tool = (0, webhook_tools_1.webhookTools)(webhookSvc).find(t => t.name === 'WebhookFindBySession');
        const auth = makeAuth();
        const result = (await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 'sess-1' }, 'key', auth));
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('secret');
        expect(result[0]).not.toHaveProperty('headers');
    });
    it('WebhookFindOne output has no secret or headers keys', async () => {
        const webhookSvc = {
            findOne: jest.fn().mockResolvedValue(entity),
        };
        const tool = (0, webhook_tools_1.webhookTools)(webhookSvc).find(t => t.name === 'WebhookFindOne');
        const auth = makeAuth();
        const result = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 'sess-1', webhookId: 'wh-1' }, 'key', auth);
        expect(result).not.toHaveProperty('secret');
        expect(result).not.toHaveProperty('headers');
        expect(result).toHaveProperty('id', 'wh-1');
    });
});
// ---------------------------------------------------------------------------
// FIX 2: session tools must not leak `config` or `proxyUrl`
// ---------------------------------------------------------------------------
describe('FIX 2: session tools strip config + proxyUrl', () => {
    const entity = stubSessionEntity();
    it('SessionFindOne output has no config or proxyUrl keys', async () => {
        const sessionSvc = {
            findOne: jest.fn().mockResolvedValue(entity),
            engineLoaded: jest.fn().mockReturnValue(false),
        };
        const tool = (0, session_tools_1.sessionTools)(sessionSvc).find(t => t.name === 'SessionFindOne');
        const auth = makeAuth();
        const result = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 'sess-1' }, 'key', auth);
        expect(result).not.toHaveProperty('config');
        expect(result).not.toHaveProperty('proxyUrl');
        expect(result).toHaveProperty('id', 'sess-1');
    });
    it('SessionFindAll output items have no config or proxyUrl keys', async () => {
        const sessionSvc = {
            findAll: jest.fn().mockResolvedValue([entity]),
            engineLoaded: jest.fn().mockReturnValue(false),
        };
        const tool = (0, session_tools_1.sessionTools)(sessionSvc).find(t => t.name === 'SessionFindAll');
        const auth = makeAuth();
        const result = (await (0, tool_invoker_1.invokeTool)(tool, {}, 'key', auth));
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('config');
        expect(result[0]).not.toHaveProperty('proxyUrl');
    });
});
// ---------------------------------------------------------------------------
// FIX 5: empty sessionId must be rejected (scope-skip prevention)
// ---------------------------------------------------------------------------
describe('FIX 5: empty sessionId is rejected at validation', () => {
    it('a sessionScoped tool rejects sessionId: "" with BadRequestException', async () => {
        const sessionSvc = {
            findOne: jest.fn().mockResolvedValue(stubSessionEntity()),
            engineLoaded: jest.fn().mockReturnValue(false),
        };
        const tool = (0, session_tools_1.sessionTools)(sessionSvc).find(t => t.name === 'SessionFindOne');
        const auth = makeAuth();
        await expect((0, tool_invoker_1.invokeTool)(tool, { sessionId: '' }, 'key', auth)).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    it('a webhook sessionScoped tool rejects sessionId: "" with BadRequestException', async () => {
        const webhookSvc = {
            findBySession: jest.fn().mockResolvedValue([]),
        };
        const tool = (0, webhook_tools_1.webhookTools)(webhookSvc).find(t => t.name === 'WebhookFindBySession');
        const auth = makeAuth();
        await expect((0, tool_invoker_1.invokeTool)(tool, { sessionId: '' }, 'key', auth)).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
});
// ---------------------------------------------------------------------------
// FIX 6: non-HTTP errors must not leak raw error.message on the wire
// ---------------------------------------------------------------------------
describe('FIX 6: handleToolError sanitises non-HTTP errors', () => {
    it('a plain Error yields a generic wire message, not the raw text', () => {
        const result = (0, tool_result_1.handleToolError)(new Error('db connection string leaked: postgres://secret@host/db'));
        const content = result.content[0].text;
        const payload = JSON.parse(content);
        expect(payload.message).toBe('Internal error');
        expect(payload.message).not.toContain('postgres');
    });
    it('an HttpException keeps its client-safe message', () => {
        const err = new common_1.HttpException('Session not found', 404);
        const result = (0, tool_result_1.handleToolError)(err);
        const content = result.content[0].text;
        const payload = JSON.parse(content);
        expect(payload.message).toBe('Session not found');
    });
    it('an UnauthorizedException keeps its message', () => {
        const err = new common_1.UnauthorizedException('Missing API key');
        const result = (0, tool_result_1.handleToolError)(err);
        const content = result.content[0].text;
        const payload = JSON.parse(content);
        expect(payload.message).toBe('Missing API key');
    });
});
// ---------------------------------------------------------------------------
// FIX 7: BadRequestException with string-array detail must expose the array,
//         not the generic 'Bad Request Exception' string
// ---------------------------------------------------------------------------
describe('FIX 7: handleToolError exposes structured BadRequestException detail', () => {
    it('BadRequestException with string[] detail returns the array, not the generic string', () => {
        const err = new common_1.BadRequestException(['sessionId: too small', 'limit: max 100']);
        const result = (0, tool_result_1.handleToolError)(err);
        const content = result.content[0].text;
        const payload = JSON.parse(content);
        expect(payload.success).toBe(false);
        expect(payload.message).not.toBe('Bad Request Exception');
        expect(Array.isArray(payload.message)).toBe(true);
        expect(payload.message).toContain('sessionId: too small');
        expect(payload.message).toContain('limit: max 100');
    });
    it('BadRequestException with a plain string stays as that string', () => {
        const err = new common_1.BadRequestException('Session x not found');
        const result = (0, tool_result_1.handleToolError)(err);
        const content = result.content[0].text;
        const payload = JSON.parse(content);
        expect(payload.message).toBe('Session x not found');
    });
    it('NotFoundException with a plain string stays as that string', () => {
        const err = new common_1.NotFoundException('Session x not found');
        const result = (0, tool_result_1.handleToolError)(err);
        const content = result.content[0].text;
        const payload = JSON.parse(content);
        expect(payload.name).toBe('NotFoundException');
        expect(payload.message).toBe('Session x not found');
    });
    it('plain Error still yields Internal error (no leakage)', () => {
        const result = (0, tool_result_1.handleToolError)(new Error('db secret leaked'));
        const content = result.content[0].text;
        const payload = JSON.parse(content);
        expect(payload.message).toBe('Internal error');
    });
    it('result is marked isError=true', () => {
        const err = new common_1.BadRequestException(['sessionId: too small']);
        const result = (0, tool_result_1.handleToolError)(err);
        expect(result.isError).toBe(true);
    });
});
