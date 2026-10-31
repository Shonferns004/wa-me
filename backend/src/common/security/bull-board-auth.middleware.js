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
var BullBoardAuthMiddleware_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BullBoardAuthMiddleware = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const auth_service_1 = require("../../modules/auth/auth.service");
const api_key_entity_1 = require("../../modules/auth/entities/api-key.entity");
const audit_service_1 = require("../../modules/audit/audit.service");
const audit_log_entity_1 = require("../../modules/audit/entities/audit-log.entity");
const auth_failure_audit_limiter_1 = require("../../modules/audit/auth-failure-audit-limiter");
const mcp_rate_limit_1 = require("../../modules/mcp/mcp-rate-limit");
const ip_1 = require("../utils/ip");
const bearer_token_1 = require("./bearer-token");
const request_context_1 = require("../services/request-context");
/**
 * Protects the Bull Board UI (/admin/queues).
 *
 * Bull Board is mounted as raw Express middleware by @bull-board/nestjs, so the
 * global ApiKeyGuard — which only runs on Nest controller handlers — does not
 * cover it. This middleware requires a valid ADMIN-role API key, supplied via
 * the X-API-Key header or an Authorization: Bearer token.
 *
 * The ?apiKey query-string fallback was removed: an ADMIN key in the
 * URL leaks into proxy/access logs, browser history, bookmarks, and the Referer header.
 *
 * A pre-auth per-IP throttle (mirroring the MCP mount's createIpThrottle) bounds a credential-probing
 * flood BEFORE it reaches the validateApiKey DB lookup. It uses the same KeyRateLimiter + IP-rate-limit
 * settings as MCP, so the two raw-Express mounts share one generous pre-auth IP-flood policy.
 *
 * Audit trail at this boundary (the Nest guard cannot see this mount):
 *  - 401/403 rejections are recorded as WARN API_KEY_AUTH_FAILED, mirroring the REST guard and the
 *    MCP mount. The pre-auth IP throttle above is the flood bound — a throttled 429 is NOT audited,
 *    so a probing flood cannot drown the audit table either.
 *    A 401 row also draws on a per-IP budget shared with the REST guard (auth-failure-audit-limiter).
 *  - An authenticated non-GET/HEAD request is recorded as INFO QUEUE_BOARD_MUTATED with method+path.
 *    This is a boundary trace of queue-mutation attempts reaching the Bull Board router (the UI's
 *    retry/remove/pause actions are POSTs); it deliberately does NOT model Bull Board's internal
 *    per-action outcomes, which are invisible from middleware.
 * Session-restricted keys are refused outright: the board is deployment-global, so a key confined to
 * a subset of sessions has no scope to enforce against it.
 * Both are fire-and-forget: audit logging is best-effort and must never affect the auth decision.
 */
let BullBoardAuthMiddleware = BullBoardAuthMiddleware_1 = class BullBoardAuthMiddleware {
    authService;
    configService;
    auditService;
    ipRateLimiter;
    constructor(authService, configService, auditService, ipRateLimiter) {
        this.authService = authService;
        this.configService = configService;
        this.auditService = auditService;
        // Default to MCP's pre-auth per-IP policy (max 120 / 60s) when not supplied. Tests inject a tight
        // limiter; production (instantiated manually in main.ts) takes the default.
        this.ipRateLimiter = ipRateLimiter ?? BullBoardAuthMiddleware_1.createDefaultIpLimiter();
    }
    static createDefaultIpLimiter() {
        const { max, windowMs } = (0, mcp_rate_limit_1.readIpRateLimitConfig)();
        return new mcp_rate_limit_1.KeyRateLimiter(max, windowMs);
    }
    async use(req, _res, next) {
        try {
            const clientIp = this.getClientIp(req);
            // Pre-auth, per-IP throttle — runs BEFORE the credential check so a login-attempt flood is rejected
            // before the DB lookup. Mirrors MCP's createIpThrottle. Throws HttpException(429) when exceeded;
            // forwarded to Nest's exception layer below as a standard 429.
            this.ipRateLimiter.check((0, ip_1.limiterKeyForIp)(clientIp));
            const rawKey = this.extractKey(req);
            if (!rawKey) {
                throw new auth_service_1.UnresolvedApiKeyException('API key is required to access the queue dashboard');
            }
            const apiKey = await this.authService.validateApiKey(rawKey, clientIp);
            // Stamp the resolved actor before the two authorization checks below, matching ApiKeyGuard.
            // Both of those throw, and the catch that audits the denial cannot see `apiKey` — it is a const
            // inside this try. Without the stamp, a denial on the most privileged UI in the deployment was
            // recorded against an IP alone, so the operator could not tell which key had tried to reach the
            // queue dashboard without ADMIN, or which confined key had tried to escape its session fence.
            // This mount runs inside the request-context scope (requestContextMiddleware is installed
            // ahead of it in main.ts), so the stamp reaches AuditService.
            (0, request_context_1.setRequestActor)({ apiKeyId: apiKey.id, apiKeyName: apiKey.name, ipAddress: clientIp });
            if (!this.authService.hasPermission(apiKey, api_key_entity_1.ApiKeyRole.ADMIN)) {
                throw new common_1.ForbiddenException('Admin role required to access the queue dashboard');
            }
            // The board shows and mutates every queue in the deployment, and carries no session dimension
            // to scope against. validateApiKey above is called without a session id, so a key restricted to
            // specific sessions passes its scope check by default — reject it here instead. This mirrors
            // @RequireUnscopedKey on the REST surface, which cannot reach this raw-Express mount.
            if ((apiKey.allowedSessions?.length ?? 0) > 0) {
                throw new common_1.ForbiddenException('API keys restricted to specific sessions cannot access the queue dashboard');
            }
            // A key restricted to selected chats is refused here too. This mount is the third surface
            // outside ApiKeyGuard (beside /events and the MCP mount), and the board shows and mutates the
            // webhook job queue, whose payloads carry every chat's events — so it has no chat dimension to
            // scope against and must refuse such a key outright.
            if ((apiKey.allowedChats?.length ?? 0) > 0) {
                throw new common_1.ForbiddenException('API keys restricted to selected chats cannot access the queue dashboard');
            }
            // Boundary trace of queue-mutation attempts. GET/HEAD are the UI's read/poll traffic; every
            // other method reaching the Bull Board router mutates queue state, so record it with the
            // authenticated key, the resolved client IP, and the method + full path (no query string).
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                void this.auditService?.logInfo(audit_log_entity_1.AuditAction.QUEUE_BOARD_MUTATED, {
                    apiKey,
                    ipAddress: clientIp,
                    method: req.method,
                    path: this.auditPath(req),
                });
            }
            next();
        }
        catch (err) {
            // Audit the rejected/denied attempt for a forensic trail, like the REST guard and the MCP
            // mount do. A throttle overrun (HttpException 429) is deliberately NOT audited: the limiter
            // already rejected it, and logging each throttled hit would let a flood write unbounded rows.
            // A 401 that resolved no key draws on the per-IP budget it shares with the REST guard; any
            // rejection of a stored key, 401 or 403, is always recorded.
            if (this.auditService && (err instanceof common_1.UnauthorizedException || err instanceof common_1.ForbiddenException)) {
                const clientIp = this.getClientIp(req);
                if (!(err instanceof auth_service_1.UnresolvedApiKeyException) || (0, auth_failure_audit_limiter_1.allowUnauthenticatedAuditRow)(clientIp)) {
                    void this.auditService.logWarn(audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED, {
                        ipAddress: clientIp,
                        method: req.method,
                        path: this.auditPath(req),
                        errorMessage: err.message,
                    });
                }
            }
            // Forward to Nest's exception layer so the response uses the standard format. A throttle overrun
            // surfaces here as an HttpException(429) → rendered as a standard 429 by the global exception filter.
            next(err);
        }
    }
    /** Full request path (mount prefix included) with any query string stripped. */
    auditPath(req) {
        const url = req.originalUrl ?? req.url ?? '';
        return url.split('?')[0];
    }
    extractKey(req) {
        // No ?apiKey query fallback — an admin key in the URL leaks into logs/history.
        return (0, bearer_token_1.presentedApiKey)(req.headers);
    }
    getClientIp(req) {
        // Mirror the ApiKeyGuard's IP model so allowedIps is enforced consistently for the queue UI:
        // X-Forwarded-For is honored only behind a configured trusted proxy.
        const trustedProxies = this.configService.get('security.trustedProxies') ?? [];
        return (0, ip_1.resolveClientIp)(req, trustedProxies);
    }
};
exports.BullBoardAuthMiddleware = BullBoardAuthMiddleware;
exports.BullBoardAuthMiddleware = BullBoardAuthMiddleware = BullBoardAuthMiddleware_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [auth_service_1.AuthService,
        config_1.ConfigService,
        audit_service_1.AuditService,
        mcp_rate_limit_1.KeyRateLimiter])
], BullBoardAuthMiddleware);
