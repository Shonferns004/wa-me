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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const health_response_dto_1 = require("./dto/health-response.dto");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const config_1 = require("@nestjs/config");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const throttler_1 = require("@nestjs/throttler");
const shutdown_service_1 = require("../../common/services/shutdown.service");
const auth_service_1 = require("../auth/auth.service");
const audit_service_1 = require("../audit/audit.service");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const ws_rate_limit_1 = require("../events/ws-rate-limit");
const ip_1 = require("../../common/utils/ip");
const bearer_token_1 = require("../../common/security/bearer-token");
/** Bound each dependency probe so a hung connection can't stall the readiness check. */
const READINESS_PROBE_TIMEOUT_MS = 3000;
// Source the running version from package.json (same pattern as swagger.config.ts) so authenticated
// callers (e.g. the dashboard) read it live and never show a stale build-time-baked version. Read
// once at module load.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: APP_VERSION } = require('../../../package.json');
let HealthController = class HealthController {
    mainDataSource;
    dataDataSource;
    shutdownService;
    authService;
    configService;
    auditService;
    constructor(mainDataSource, dataDataSource, shutdownService, authService, configService, auditService) {
        this.mainDataSource = mainDataSource;
        this.dataDataSource = dataDataSource;
        this.shutdownService = shutdownService;
        this.authService = authService;
        this.configService = configService;
        this.auditService = auditService;
        // Bounds the audit rows one source IP can write per minute through this deliberately
        // unthrottled route: the health probes themselves must never be rate-limited, but without a
        // cap a key-probing flood would turn the audit trail into the flood's storage.
        this.authFailureAuditLimiter = new ws_rate_limit_1.SlidingWindowLimiter(10, 60_000);
    }
    authFailureAuditLimiter;
    // Bounds the key lookups one client can drive through this unthrottled route. Charged before the
    // lookup and refunded when the key validates, so only failed presentations spend it: past the
    // budget the probe still answers 200, without `version` and without touching the key table.
    keyValidationLimiter = new ws_rate_limit_1.SlidingWindowLimiter(30, 60_000);
    async check(req) {
        const body = {
            status: 'ok',
            timestamp: new Date().toISOString(),
        };
        // The exact running version is disclosed only to authenticated callers; the route itself stays
        // public so uptime probes keep working without credentials.
        if (await this.hasValidApiKey(req)) {
            body.version = APP_VERSION;
        }
        return body;
    }
    /**
     * The route is @Public, so the global ApiKeyGuard never runs here — resolve a presented key the
     * same way the guard does (X-API-Key header or Bearer token, trusted-proxy-aware client IP so an
     * allowedIps-restricted key is enforced identically). Any outcome other than a validated key —
     * none presented, invalid, revoked, IP-denied — withholds the version; it never fails the check.
     */
    async hasValidApiKey(req) {
        const rawKey = (0, bearer_token_1.presentedApiKey)(req.headers);
        if (!rawKey)
            return false;
        const clientIp = (0, ip_1.resolveClientIp)(req, this.configService.get('security.trustedProxies') ?? []);
        const subject = (0, ip_1.limiterKeyForIp)(clientIp);
        if (!this.keyValidationLimiter.allow(subject))
            return false;
        try {
            await this.authService.validateApiKey(rawKey, clientIp);
            this.keyValidationLimiter.refund(subject);
            return true;
        }
        catch (err) {
            // A PRESENTED key that failed validation is a credential probe against an endpoint every
            // other key-validation surface audits (REST guard, WebSocket, MCP mount, Bull Board). This
            // route was the one blind spot: the failure only withheld the version, invisibly. Fire-and-
            // forget and rate-bounded per IP (constructor): audit logging must never fail the probe.
            if (this.authFailureAuditLimiter.allow(subject)) {
                void this.auditService.logWarn(audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED, {
                    ipAddress: clientIp,
                    method: req.method,
                    path: req.path,
                    errorMessage: err instanceof Error ? err.message : String(err),
                });
            }
            return false;
        }
    }
    liveness() {
        // Liveness only reflects process liveness — deliberately static so a transient
        // dependency outage doesn't trigger a pod KILL (that's readiness' job).
        return { status: 'ok' };
    }
    async readiness() {
        // While draining (shutdown started), report 503 so the LB/orchestrator stops
        // routing new traffic before teardown — even if the DBs are still up.
        if (this.shutdownService.isShuttingDown()) {
            throw new common_1.ServiceUnavailableException({ status: 'error', details: { shutdown: { status: 'draining' } } });
        }
        const [main, data] = await Promise.all([
            this.probeDatabase(this.mainDataSource),
            this.probeDatabase(this.dataDataSource),
        ]);
        const details = {
            mainDatabase: { status: main },
            dataDatabase: { status: data },
        };
        if (main === 'down' || data === 'down') {
            // 503 so orchestrators/LBs stop routing traffic to a node with a dead DB.
            throw new common_1.ServiceUnavailableException({ status: 'error', details });
        }
        return { status: 'ok', details };
    }
    async probeDatabase(dataSource) {
        try {
            await this.withTimeout(dataSource.query('SELECT 1'), READINESS_PROBE_TIMEOUT_MS);
            return 'up';
        }
        catch {
            return 'down';
        }
    }
    async withTimeout(work, ms) {
        let timer;
        const timeout = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('readiness probe timed out')), ms);
        });
        try {
            return await Promise.race([work, timeout]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }
};
exports.HealthController = HealthController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Basic health check' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Application is healthy', type: health_response_dto_1.HealthCheckResponseDto }),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "check", null);
__decorate([
    (0, common_1.Get)('live'),
    (0, swagger_1.ApiOperation)({ summary: 'Liveness probe for Kubernetes' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Application is alive', type: health_response_dto_1.LivenessResponseDto }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], HealthController.prototype, "liveness", null);
__decorate([
    (0, common_1.Get)('ready'),
    (0, swagger_1.ApiOperation)({ summary: 'Readiness probe — verifies the auth/audit + data databases respond' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Application is ready to accept traffic', type: health_response_dto_1.ReadinessResponseDto }),
    (0, swagger_1.ApiResponse)({
        status: 503,
        description: 'A required dependency is down, or the node is draining for shutdown (details.shutdown.status = draining)',
        type: health_response_dto_1.ReadinessResponseDto,
    }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], HealthController.prototype, "readiness", null);
exports.HealthController = HealthController = __decorate([
    (0, swagger_1.ApiTags)('health'),
    (0, common_1.Controller)('health'),
    (0, auth_decorators_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    __param(0, (0, typeorm_1.InjectDataSource)('main')),
    __param(1, (0, typeorm_1.InjectDataSource)('data')),
    __metadata("design:paramtypes", [typeorm_2.DataSource,
        typeorm_2.DataSource,
        shutdown_service_1.ShutdownService,
        auth_service_1.AuthService,
        config_1.ConfigService,
        audit_service_1.AuditService])
], HealthController);
