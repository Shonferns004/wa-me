"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auditMcpAuthFailure = auditMcpAuthFailure;
exports.createIpThrottle = createIpThrottle;
exports.createKeyGate = createKeyGate;
exports.resolveMcpReadOnly = resolveMcpReadOnly;
exports.mountMcpServer = mountMcpServer;
const common_1 = require("@nestjs/common");
const logger_service_1 = require("../../common/services/logger.service");
const express_1 = __importDefault(require("express"));
const tool_invoker_1 = require("../../core/agent-tools/tool-invoker");
const auth_service_1 = require("../auth/auth.service");
const auth_failure_audit_limiter_1 = require("../audit/auth-failure-audit-limiter");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const tool_result_1 = require("./tool-result");
const ip_1 = require("../../common/utils/ip");
const bootstrap_security_1 = require("../../config/bootstrap-security");
const bearer_token_1 = require("../../common/security/bearer-token");
const logger = (0, logger_service_1.createLogger)('any');
/**
 * Extract the raw API key from request headers. Accepts X-Api-Key or Bearer token. The mount gate parses
 * the Express headers and hands the key it validated to the per-tool check as `authInfo`, so the two
 * cannot disagree on what the credential is (the SDK's own header copy joins duplicate headers).
 */
function extractApiKey(headers = {}) {
    return (0, bearer_token_1.presentedApiKey)(headers);
}
/**
 * Mirror the REST ApiKeyGuard's auth-failure audit trail for MCP. The MCP mount is raw Express (outside
 * the Nest guard pipeline), so without this a credential-probing flood against /mcp leaves no forensic
 * record. Records a WARN `API_KEY_AUTH_FAILED` for rejected/denied authentication attempts (401/403 only);
 * non-auth errors (e.g. a 400 from bad tool input) are NOT audited — parity with the REST guard, which
 * only records Unauthorized/Forbidden. A rejection that names no stored key (UnresolvedApiKeyException)
 * draws on the per-IP budget the REST guard and Bull Board share; a stored key's rejection is always
 * recorded. Fire-and-forget; best-effort (AuditService swallows insert errors).
 */
function auditMcpAuthFailure(auditService, error, reqContext) {
    if (!auditService)
        return;
    if (error instanceof auth_service_1.UnresolvedApiKeyException && !(0, auth_failure_audit_limiter_1.allowUnauthenticatedAuditRow)(reqContext.ipAddress ?? '')) {
        return;
    }
    if (error instanceof common_1.UnauthorizedException || error instanceof common_1.ForbiddenException) {
        void auditService.logWarn(audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED, {
            ipAddress: reqContext.ipAddress,
            method: reqContext.method,
            path: reqContext.path,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
    }
}
/** Read TRUSTED_PROXIES once as a list (shared by the pre-auth throttle and the audit IP resolver). */
function readTrustedProxies() {
    return (0, ip_1.parseTrustedProxies)(process.env.TRUSTED_PROXIES);
}
/** Resolve the trusted-proxy-aware client IP + HTTP method/path for an audit record. */
function resolveReqContext(req) {
    return {
        ipAddress: (0, ip_1.resolveClientIp)(req, readTrustedProxies()),
        method: req.method,
        path: req.path,
    };
}
/**
 * Build the MCP server ONCE and register all tools from the registry.
 * The SDK's `registerTool` accepts `any` (z4.$ZodType) directly, so we
 * pass `tool.inputSchema` verbatim — no `.shape` extraction needed.
 */
function buildServer(registry, authService, rateLimiter, readOnly, serverInfo, auditService, reqContext, chatScope) {
    const server = {};
    const tools = registry.list({ readOnly });
    for (const tool of tools) {
        server.registerTool(tool.name, {
            description: tool.description,
            // The SDK's InputArgs is inferred from this property. Widening it to the whole
            // `ZodRawShapeCompat | any` constraint would collapse the callback type it derives, so
            // the cast names any exactly — which zod v4's $ZodType satisfies.
            inputSchema: tool.inputSchema,
            annotations: {
                readOnlyHint: tool.tier === 'read',
                destructiveHint: tool.destructive ?? false,
                idempotentHint: tool.idempotent ?? tool.tier === 'read',
            },
        }, async (input, extra) => {
            const rawKey = extra.authInfo?.token ?? extractApiKey(extra.requestInfo?.headers);
            try {
                const result = await (0, tool_invoker_1.invokeTool)(tool, input, rawKey, authService, id => rateLimiter.check(id), 
                // onAuthFailure: mirror the REST ApiKeyGuard — record rejected/denied auth attempts (401/403
                // only) at the auth boundary so the audit trail covers MCP credential probing. Fires inside
                // invokeTool's authorization checks (before the tool handler), so handler-thrown 403s are NOT mislabeled
                // as auth failures. Best-effort; success and non-auth errors skip this.
                error => auditMcpAuthFailure(auditService, error, reqContext), chatScope, extra.signal);
                return (0, tool_result_1.smartToolResult)(result);
            }
            catch (error) {
                return (0, tool_result_1.handleToolError)(error);
            }
        });
    }
    return server;
}
/**
 * Mount the MCP Streamable-HTTP transport on the existing Nest/Express adapter
 * at `POST {basePath}` (default `/mcp`), single-port.
 *
 * Tool handlers are built ONCE at mount time (closure over registry/authService/rateLimiter).
 * Every POST passes the per-IP throttle and then the key gate before any MCP method runs.
 * Per-request: mint a fresh any + StreamableHTTPServerTransport, handle, tear down.
 * Stateless (sessionIdGenerator: undefined): no session map; GET/DELETE answer 405.
 * Creating a new any per request is safe and avoids the single-transport constraint;
 * tool registration is O(n) pure function calls with no I/O overhead.
 */
/**
 * Pre-auth, per-IP throttle for the raw-Express /mcp mount. The global Nest throttler doesn't cover this
 * mount (it bypasses the guard pipeline) and the per-key limiter only fires AFTER key validation — so a
 * missing/invalid/revoked key otherwise reaches a DB lookup unthrottled. This gates by resolved client IP
 * first and returns a JSON-RPC 429 directly (raw Express wouldn't convert a thrown HttpException).
 */
function createIpThrottle(ipRateLimiter) {
    return (req, res, next) => {
        const ip = (0, ip_1.limiterKeyForIp)((0, ip_1.resolveClientIp)(req, readTrustedProxies()));
        // The unit of work is the JSON-RPC message, not the HTTP request: the transport dispatches every
        // element of a batch, and each tools/call element runs its own key lookup and auth-failure audit.
        // An over-budget batch throws on the first check past the cap, so a huge array costs at most
        // `max + 1` checks.
        const messages = Array.isArray(req.body) ? Math.max(1, req.body.length) : 1;
        try {
            for (let i = 0; i < messages; i++)
                ipRateLimiter.check(ip);
            next();
        }
        catch (err) {
            const status = err instanceof common_1.HttpException ? err.getStatus() : 429;
            res.status(status).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: err instanceof Error ? err.message : 'MCP rate limit exceeded' },
                id: null,
            });
        }
    };
}
/**
 * Mount gate: every POST must carry a valid API key before the transport answers anything, including
 * `initialize` (server version) and `tools/list` (tool catalogue). Runs after the per-IP throttle so a
 * flood never reaches the key lookup. Validated with no client IP and no session, as the per-tool check
 * does: a key with `allowedIps` is refused on MCP, and role, session and chat scope stay per tool call.
 * Neither the per-key limiter nor the key's usage stats are charged here; invokeTool charges both per
 * tool call, so a request counts once.
 */
function createKeyGate(authService, auditService) {
    return async (req, res, next) => {
        try {
            const rawKey = extractApiKey(req.headers);
            if (!rawKey)
                throw new auth_service_1.UnresolvedApiKeyException('Missing API key');
            await authService.validateApiKey(rawKey, undefined, undefined, { recordUsage: false });
            // The transport forwards req.auth to every tool call as extra.authInfo.
            req.auth = { token: rawKey, clientId: 'api-key', scopes: [] };
        }
        catch (err) {
            if (err instanceof common_1.HttpException) {
                auditMcpAuthFailure(auditService, err, resolveReqContext(req));
                const status = err.getStatus();
                if (status === 401)
                    res.set('WWW-Authenticate', 'Bearer');
                res.status(status).json({ jsonrpc: '2.0', error: { code: -32000, message: err.message }, id: null });
                return;
            }
            logger.error('Error authenticating MCP request', err instanceof Error ? err.stack : String(err));
            res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
            return;
        }
        next();
    };
}
/**
 * Resolve the MCP read-only flag with a SECURE default: read-only unless the operator explicitly opts
 * out with MCP_READONLY=false. Previously an unset MCP_READONLY defaulted to read-WRITE, silently
 * exposing state-changing tools (send messages, group ops) to any MCP caller the moment MCP_ENABLED
 * was on. An explicit `options.readOnly` (tests / programmatic mounts) still wins.
 */
function resolveMcpReadOnly(optionsReadOnly) {
    return optionsReadOnly ?? process.env.MCP_READONLY !== 'false';
}
function mountMcpServer(httpAdapter, registry, authService, rateLimiter, ipRateLimiter, options = {}, auditService, chatScope) {
    const basePath = (options.basePath ?? '/mcp').replace(/\/$/, '') || '/mcp';
    const serverInfo = options.serverInfo ?? { name: 'openwa', version: '0.0.0' };
    const readOnly = resolveMcpReadOnly(options.readOnly);
    // Eagerly compute the tool list at mount time to validate the registry is populated
    // and to emit the log line once. The actual any is re-created per request to
    // avoid the SDK's single-transport-at-a-time constraint under concurrent load.
    const tools = registry.list({ readOnly });
    logger.log(`MCP server mounted at POST ${basePath} (${tools.length} tools, readOnly=${readOnly})`);
    const handler = async (req, res) => {
        const server = buildServer(registry, authService, rateLimiter, readOnly, serverInfo, auditService, resolveReqContext(req), chatScope);
        const transport = new Function({ sessionIdGenerator: undefined });
        try {
            res.on('close', () => {
                void transport.close();
                void server.close();
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        }
        catch (error) {
            logger.error('Error handling MCP request', error instanceof Error ? error.stack : String(error));
            if (!res.headersSent) {
                res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
            }
        }
    };
    const adapter = httpAdapter;
    // The route throttle gates the auth DB lookup and per-request MCP server/transport construction. The
    // process-wide capped json() in src/configure-app.ts runs first for all routes; this route-level parser is a
    // defensive fallback and no-ops once the global parser has consumed the body. It sits before the
    // throttle so the throttle always sees a parsed body and can charge a batch per message.
    // `inflate: false` matches the global parsers: a compressed body is refused by the budget
    // middleware long before this runs, and this keeps the fallback from becoming the one parser that
    // would still gunzip an unaccounted body if that ordering ever changed.
    // `limit` mirrors the same global cap for the same reason: without it a middleware reorder would
    // silently leave this mount uncapped.
    const bodyLimit = (0, bootstrap_security_1.resolveBodyLimit)(process.env.BODY_SIZE_LIMIT);
    adapter.post(basePath, express_1.default.json({ limit: bodyLimit, inflate: false }), createIpThrottle(ipRateLimiter), createKeyGate(authService, auditService), handler);
    // Stateless transport: no standalone SSE stream and no session to delete. The Streamable HTTP spec
    // requires a GET to be answered with a stream or 405, and SDK clients treat anything but 405 as an
    // error on every connect. Routing these to the transport would open a stream (GET) or answer 200
    // (DELETE), so they are refused here without touching auth or the DB.
    const methodNotAllowed = (_req, res) => {
        res
            .status(405)
            .set('Allow', 'POST')
            .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    };
    adapter.get(basePath, methodNotAllowed);
    adapter.delete(basePath, methodNotAllowed);
}
