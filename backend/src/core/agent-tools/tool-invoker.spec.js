"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const tool_invoker_1 = require("./tool-invoker");
const api_key_entity_1 = require("../../modules/auth/entities/api-key.entity");
const readTool = {
    name: 'T',
    description: 'd',
    tier: 'read',
    inputSchema: zod_1.z.object({ n: zod_1.z.number() }),
    handler: input => Promise.resolve({ got: input.n }),
};
function auth(over = {}) {
    return {
        validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null, ...over }),
        hasPermission: jest.fn().mockReturnValue(true),
    };
}
describe('invokeTool', () => {
    it('rejects a missing key', async () => {
        await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, undefined, auth())).rejects.toBeInstanceOf(common_1.UnauthorizedException);
    });
    it('validates input AFTER auth and runs the handler', async () => {
        const a = auth();
        const out = await (0, tool_invoker_1.invokeTool)(readTool, { n: 5 }, 'rawkey', a);
        expect(a.validateApiKey).toHaveBeenCalledWith('rawkey', undefined, undefined);
        expect(out).toEqual({ got: 5 });
    });
    it('hands the cancellation signal to the handler', async () => {
        const handler = jest.fn().mockResolvedValue('ok');
        const tool = { ...readTool, handler };
        const controller = new AbortController();
        await (0, tool_invoker_1.invokeTool)(tool, { n: 1 }, 'rawkey', auth(), undefined, undefined, undefined, controller.signal);
        expect(handler).toHaveBeenCalledWith({ n: 1 }, expect.objectContaining({ id: 'k1' }), undefined, controller.signal);
    });
    it('refuses a chat-restricted key on a tool that declares no chat scope', async () => {
        const a = auth({ allowedChats: ['123@g.us'] });
        await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, 'rawkey', a)).rejects.toBeInstanceOf(common_1.ForbiddenException);
    });
    it('maps a zod failure to BadRequestException', async () => {
        await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 'x' }, 'rawkey', auth())).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    // PostgreSQL rejects U+0000 in every text parameter, so an argument holding one failed the tool's
    // query or write as an internal error.
    it('refuses a NUL character anywhere in the input before the handler runs', async () => {
        const handler = jest.fn();
        const tool = {
            ...readTool,
            inputSchema: zod_1.z.object({ chatId: zod_1.z.string(), vars: zod_1.z.record(zod_1.z.string(), zod_1.z.string()) }),
            handler,
        };
        await expect((0, tool_invoker_1.invokeTool)(tool, { chatId: 'a@c.us', vars: { name: 'x\u0000' } }, 'rawkey', auth())).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(handler).not.toHaveBeenCalled();
    });
    it('passes sessionId from input to validateApiKey when sessionScoped', async () => {
        const a = auth();
        const scoped = {
            ...readTool,
            sessionScoped: true,
            inputSchema: zod_1.z.object({ sessionId: zod_1.z.string() }),
            handler: () => Promise.resolve('ok'),
        };
        await (0, tool_invoker_1.invokeTool)(scoped, { sessionId: 's1' }, 'rawkey', a);
        expect(a.validateApiKey).toHaveBeenCalledWith('rawkey', undefined, 's1');
    });
    it('fails closed for a sessionScoped tool when no sessionId is supplied (no auth with an unscoped id)', async () => {
        const a = auth();
        // A sessionScoped tool whose input omits sessionId (e.g. an optional/loose schema): the per-key
        // allowedSessions check would be skipped if undefined reached validateApiKey, so fence it here.
        const scoped = {
            ...readTool,
            sessionScoped: true,
            inputSchema: zod_1.z.object({ sessionId: zod_1.z.string().optional() }),
            handler: () => Promise.resolve('ok'),
        };
        await expect((0, tool_invoker_1.invokeTool)(scoped, {}, 'rawkey', a)).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(a.validateApiKey).not.toHaveBeenCalled();
    });
    it('rejects when validateApiKey throws for an out-of-scope session', async () => {
        const a = auth();
        a.validateApiKey.mockRejectedValueOnce(new common_1.ForbiddenException('API key not authorized for this session'));
        const scoped = {
            ...readTool,
            sessionScoped: true,
            inputSchema: zod_1.z.object({ sessionId: zod_1.z.string() }),
            handler: () => Promise.resolve('ok'),
        };
        await expect((0, tool_invoker_1.invokeTool)(scoped, { sessionId: 'other-session' }, 'rawkey', a)).rejects.toBeInstanceOf(common_1.ForbiddenException);
    });
    it('enforces requiredRole via hasPermission', async () => {
        const a = auth();
        a.hasPermission.mockReturnValue(false);
        const writeTool = { ...readTool, tier: 'write', requiredRole: api_key_entity_1.ApiKeyRole.OPERATOR };
        await expect((0, tool_invoker_1.invokeTool)(writeTool, { n: 1 }, 'rawkey', a)).rejects.toBeInstanceOf(common_1.ForbiddenException);
    });
    // FIX 3(b): onAuthenticated callback
    it('calls onAuthenticated with apiKey.id after successful validateApiKey', async () => {
        const a = auth({ id: 'key-abc' });
        const onAuthenticated = jest.fn();
        await (0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, 'rawkey', a, onAuthenticated);
        expect(onAuthenticated).toHaveBeenCalledTimes(1);
        expect(onAuthenticated).toHaveBeenCalledWith('key-abc');
    });
    it('does NOT call onAuthenticated when validateApiKey throws', async () => {
        const a = auth();
        a.validateApiKey.mockRejectedValueOnce(new common_1.UnauthorizedException('bad key'));
        const onAuthenticated = jest.fn();
        await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, 'rawkey', a, onAuthenticated)).rejects.toBeInstanceOf(common_1.UnauthorizedException);
        expect(onAuthenticated).not.toHaveBeenCalled();
    });
    it('works without onAuthenticated (backward compatible)', async () => {
        const a = auth();
        // No 5th argument — must not throw
        await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, 'rawkey', a)).resolves.toBeDefined();
    });
    // onAuthFailure: MCP auth-failure audit hook (mirrors the REST ApiKeyGuard). Fires at the auth boundary
    // only — never on success, never on input-validation/handler errors (parity with the guard).
    describe('onAuthFailure callback (MCP auth-failure audit boundary)', () => {
        it('is invoked with the error on a missing key (Unauthorized)', async () => {
            const onAuthFailure = jest.fn();
            await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, undefined, auth(), undefined, onAuthFailure)).rejects.toBeInstanceOf(common_1.UnauthorizedException);
            expect(onAuthFailure).toHaveBeenCalledTimes(1);
            expect(onAuthFailure.mock.calls[0][0]).toBeInstanceOf(common_1.UnauthorizedException);
        });
        it('is invoked on a wrong-role rejection (Forbidden)', async () => {
            const a = auth();
            a.hasPermission.mockReturnValue(false);
            const onAuthFailure = jest.fn();
            const writeTool = { ...readTool, tier: 'write', requiredRole: api_key_entity_1.ApiKeyRole.OPERATOR };
            await expect((0, tool_invoker_1.invokeTool)(writeTool, { n: 1 }, 'rawkey', a, undefined, onAuthFailure)).rejects.toBeInstanceOf(common_1.ForbiddenException);
            expect(onAuthFailure).toHaveBeenCalledTimes(1);
        });
        it('is invoked when validateApiKey rejects (IP/revoked/expired/session-not-allowed)', async () => {
            const a = auth();
            a.validateApiKey.mockRejectedValueOnce(new common_1.ForbiddenException('IP address not allowed'));
            const onAuthFailure = jest.fn();
            await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, 'rawkey', a, undefined, onAuthFailure)).rejects.toBeInstanceOf(common_1.ForbiddenException);
            expect(onAuthFailure).toHaveBeenCalledTimes(1);
        });
        it('is NOT invoked on a successful auth (happy path)', async () => {
            const onAuthFailure = jest.fn();
            await (0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, 'rawkey', auth(), undefined, onAuthFailure);
            expect(onAuthFailure).not.toHaveBeenCalled();
        });
        it('is NOT invoked on a post-auth zod validation error (BadRequest)', async () => {
            const onAuthFailure = jest.fn();
            await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 'bad' }, 'rawkey', auth(), undefined, onAuthFailure)).rejects.toBeInstanceOf(common_1.BadRequestException);
            expect(onAuthFailure).not.toHaveBeenCalled();
        });
        it('is NOT invoked when a tool handler throws after successful auth', async () => {
            const onAuthFailure = jest.fn();
            const throwingHandler = {
                ...readTool,
                handler: () => Promise.reject(new common_1.ForbiddenException('handler-level forbid')),
            };
            await expect((0, tool_invoker_1.invokeTool)(throwingHandler, { n: 1 }, 'rawkey', auth(), undefined, onAuthFailure)).rejects.toBeInstanceOf(common_1.ForbiddenException);
            // A handler-thrown 403 is NOT an auth failure — must not be audited as api_key_auth_failed.
            expect(onAuthFailure).not.toHaveBeenCalled();
        });
        it('works without onAuthFailure (backward compatible)', async () => {
            // No 6th argument — a missing key still rejects without calling an undefined hook.
            await expect((0, tool_invoker_1.invokeTool)(readTool, { n: 1 }, undefined, auth())).rejects.toBeInstanceOf(common_1.UnauthorizedException);
        });
    });
});
