"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var ApiKeyGuard_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.ApiKeyGuard = void 0;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const config_1 = require("@nestjs/config");
const auth_service_1 = require("../auth.service");
const chat_scope_service_1 = require("../chat-scope.service");
const bulk_message_dto_1 = require("../../message/dto/bulk-message.dto");
const auth_decorators_1 = require("../decorators/auth.decorators");
const ip_1 = require("../../../common/utils/ip");
const bearer_token_1 = require("../../../common/security/bearer-token");
const request_context_1 = require("../../../common/services/request-context");
const audit_service_1 = require("../../audit/audit.service");
const audit_log_entity_1 = require("../../audit/entities/audit-log.entity");
const auth_failure_audit_limiter_1 = require("../../audit/auth-failure-audit-limiter");
let ApiKeyGuard = class ApiKeyGuard {
    static { ApiKeyGuard_1 = this; }
    authService;
    reflector;
    configService;
    auditService;
    chatScope;
    constructor(authService, reflector, configService, auditService, chatScope) {
        this.authService = authService;
        this.reflector = reflector;
        this.configService = configService;
        this.auditService = auditService;
        this.chatScope = chatScope;
    }
    async canActivate(context) {
        // Check if route is marked as public
        const isPublic = this.reflector.getAllAndOverride(auth_decorators_1.PUBLIC_KEY, [context.getHandler(), context.getClass()]);
        if (isPublic) {
            return true;
        }
        const request = context.switchToHttp().getRequest();
        try {
            return await this.authorize(request, context);
        }
        catch (err) {
            // Record rejected/denied authentication attempts so the audit log has a forensic trail for
            // credential probing. Fire-and-forget: audit logging is best-effort and must never turn a
            // 401/403 into a failure of the guard itself.
            if (err instanceof common_1.UnauthorizedException || err instanceof common_1.ForbiddenException) {
                // Stamp at least the IP so the failed-auth audit row below is attributable even though the
                // key was never resolved. setRequestActor is a no-op outside a request scope.
                const clientIp = this.getClientIp(request);
                (0, request_context_1.setRequestActor)({ ipAddress: clientIp });
                // A 401 that resolved no key is bounded per client IP (see UnresolvedApiKeyException); any
                // rejection of a stored key, 401 or 403, is always recorded.
                if (!(err instanceof auth_service_1.UnresolvedApiKeyException) || (0, auth_failure_audit_limiter_1.allowUnauthenticatedAuditRow)(clientIp)) {
                    void this.auditService.logWarn(audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED, {
                        ipAddress: clientIp,
                        method: request.method,
                        path: request.path,
                        errorMessage: err.message,
                    });
                }
            }
            throw err;
        }
    }
    async authorize(request, context) {
        const apiKeyHeader = this.extractApiKey(request);
        if (!apiKeyHeader) {
            throw new auth_service_1.UnresolvedApiKeyException('API key is required');
        }
        const requiredRole = this.reflector.getAllAndOverride(auth_decorators_1.REQUIRED_ROLE_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        // Resolve the session id used for the key's allowedSessions scope. `:sessionId` is always a
        // session; the bare `:id` param is only a session on controllers marked @SessionScoped (i.e.
        // SessionController) — on other routes `:id` is an unrelated resource id (API key, plugin, …)
        // and must NOT be fed to the allowedSessions check, which would spuriously deny a scoped key.
        const sessionScoped = this.reflector.getAllAndOverride(auth_decorators_1.SESSION_SCOPED_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        const sessionId = (request.params['sessionId'] || (sessionScoped ? request.params['id'] : undefined));
        const clientIp = this.getClientIp(request);
        // Validate API key
        const apiKey = await this.authService.validateApiKey(apiKeyHeader, clientIp, sessionId);
        // Stamp the resolved actor into the per-request async context so downstream audit log writes —
        // which fire from services deep in the call stack without DI access to the key — can attribute
        // the action to this key + IP. Without this every audit row's apiKey/ipAddress column is blank
        // because call sites pass only { sessionId } etc.
        //
        // Stamped HERE, the moment the key is known, rather than after the authorization checks below:
        // both of those throw, and the catch that audits the denial cannot see `apiKey` (it is a const
        // inside this method). Stamping afterwards meant every 403 the guard raised was recorded against
        // an IP alone — behind NAT or a proxy without TRUSTED_PROXIES that IP is common to every tenant,
        // so the operator could see that a key had been denied but not which one to revoke.
        (0, request_context_1.setRequestActor)({ apiKeyId: apiKey.id, apiKeyName: apiKey.name, ipAddress: clientIp });
        if (requiredRole && !this.authService.hasPermission(apiKey, requiredRole)) {
            throw new common_1.ForbiddenException(`Insufficient permissions. Required: ${requiredRole}`);
        }
        // Chat fence — DEFAULT DENY. A key carrying `allowedChats` may reach only a handler marked
        // @ChatScoped, and only for a chat inside its allowlist. Surfaces with no chat dimension
        // (webhooks, automation rules, status, key management, channels) — and every route added later —
        // are refused without being enumerated. An unrestricted key (no allowlist) skips this entirely,
        // so the model stays fail-open for every key that was not scoped.
        if (this.chatScope.isRestricted(apiKey)) {
            const chatScoped = this.reflector.getAllAndOverride(auth_decorators_1.CHAT_SCOPED_KEY, [
                context.getHandler(),
                context.getClass(),
            ]);
            if (!chatScoped) {
                throw new common_1.ForbiddenException('API key is restricted to selected chats');
            }
            await this.assertChatsAllowed(request, apiKey, context);
        }
        // Routes marked @RequireUnscopedKey carry no session dimension, so the allowedSessions check
        // above can never bite on them. A session-scoped key reaching such a surface (e.g. API-key
        // lifecycle management) could mint or widen credentials beyond its own confinement — reject it
        // outright, whatever its role. The denial is audited by the caller's catch block.
        const requireUnscoped = this.reflector.getAllAndOverride(auth_decorators_1.UNSCOPED_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (requireUnscoped && (apiKey.allowedSessions?.length ?? 0) > 0) {
            throw new common_1.ForbiddenException('Session-scoped API keys are not permitted on this route');
        }
        // Attach API key to request for use in controllers
        request.apiKey = apiKey;
        // Expose the trusted-proxy-aware client IP so controllers (e.g. the audit trail on key lifecycle
        // ops) reuse the already-resolved value instead of re-deriving it.
        request.clientIp = clientIp;
        return true;
    }
    /** Route params the guard treats as a chat id. */
    static CHAT_ROUTE_PARAMS = ['chatId', 'groupId', 'contactId'];
    /** Body fields that name a chat; bulk send nests the same name inside `messages[]`. */
    static CHAT_BODY_FIELDS = ['chatId', 'fromChatId', 'toChatId'];
    /** The bulk cap, shared with the DTO so the two cannot drift; applied BEFORE any per-entry lookup. */
    static CHAT_BULK_MAX = bulk_message_dto_1.BULK_MESSAGES_MAX;
    /**
     * Every chat id the guard can see in the request: route params, `?chatId=`, the body fields sends
     * use, and each `messages[].chatId`. A field that is PRESENT but not a string is rejected rather
     * than skipped — the global ValidationPipe coerces afterwards (enableImplicitConversion), so
     * skipping here would let a handler receive a string the fence never checked.
     */
    chatIdsIn(request) {
        const out = [];
        for (const name of ApiKeyGuard_1.CHAT_ROUTE_PARAMS)
            out.push([name, request.params[name]]);
        out.push(['chatId', (request.query ?? {})['chatId']]);
        const body = request.body;
        if (body === null || typeof body !== 'object')
            return out;
        const b = body;
        for (const field of ApiKeyGuard_1.CHAT_BODY_FIELDS)
            out.push([field, b[field]]);
        const messages = b.messages;
        if (messages === undefined || messages === null)
            return out;
        if (!Array.isArray(messages))
            throw new common_1.BadRequestException('messages must be an array');
        // Reject an oversized batch here, before the per-entry lid lookups below: the pipe's
        // @ArrayMaxSize(100) only runs after the guard, so without this one request could drive
        // thousands of sequential table queries.
        if (messages.length > ApiKeyGuard_1.CHAT_BULK_MAX) {
            throw new common_1.BadRequestException(`messages must contain at most ${ApiKeyGuard_1.CHAT_BULK_MAX} entries`);
        }
        messages.forEach((item, i) => {
            if (item === null || typeof item !== 'object')
                return;
            out.push([`messages[${i}].chatId`, item.chatId]);
        });
        return out;
    }
    /**
     * Enforce a restricted key's allowlist. Only the chat ids actually present are expanded (at most
     * two lid-table lookups each), so a route that names no chat costs nothing.
     */
    async assertChatsAllowed(request, apiKey, context) {
        // A bulk send repeats the same chat freely; each distinct id is expanded once.
        const checked = new Set();
        for (const [field, value] of this.chatIdsIn(request)) {
            if (value === undefined || value === null)
                continue;
            if (typeof value !== 'string') {
                throw new common_1.BadRequestException(`${field} must be a single chat id string`);
            }
            if (value.length === 0 || checked.has(value))
                continue;
            checked.add(value);
            if (!(await this.chatScope.allows(apiKey, value))) {
                throw new common_1.ForbiddenException('API key not authorized for this chat');
            }
        }
        // `quotedMessageId` is a chat reference the guard does not otherwise read: the quote resolves
        // from the global message store, so a restricted key could quote a message from a chat outside
        // its allowlist into an allowed one. Refuse it outright, unless the handler is marked
        // @ChatQuotedAllowed because it binds the quote to the chat it sends into (the reply route).
        const quotedAllowed = this.reflector.getAllAndOverride(auth_decorators_1.CHAT_QUOTED_ALLOWED_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        const body = request.body;
        if (!quotedAllowed && body !== null && typeof body === 'object') {
            const quoted = body.quotedMessageId;
            if (quoted !== undefined && quoted !== null && quoted !== '') {
                throw new common_1.ForbiddenException('API key is restricted to selected chats');
            }
        }
    }
    extractApiKey(request) {
        // Both the X-API-Key header and Authorization Bearer are supported.
        return (0, bearer_token_1.presentedApiKey)(request.headers);
    }
    /**
     * Resolve the real client IP used for the API key's allowedIps whitelist.
     *
     * X-Forwarded-For is client-controllable, so it is only honored when the
     * request actually arrives from a configured trusted proxy (TRUSTED_PROXIES).
     * With no trusted proxies configured, the header is ignored entirely and the
     * direct socket address is used — preventing IP-whitelist spoofing.
     */
    getClientIp(request) {
        const trustedProxies = this.configService.get('security.trustedProxies') ?? [];
        return (0, ip_1.resolveClientIp)(request, trustedProxies);
    }
};
exports.ApiKeyGuard = ApiKeyGuard;
exports.ApiKeyGuard = ApiKeyGuard = ApiKeyGuard_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [auth_service_1.AuthService,
        core_1.Reflector,
        config_1.ConfigService,
        audit_service_1.AuditService,
        chat_scope_service_1.ChatScopeService])
], ApiKeyGuard);
