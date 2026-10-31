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
Object.defineProperty(exports, "__esModule", { value: true });
exports.SettingsController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const settings_response_dto_1 = require("./dto/settings-response.dto");
const config_1 = require("@nestjs/config");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const bootstrap_security_1 = require("../../config/bootstrap-security");
let SettingsController = class SettingsController {
    configService;
    settings;
    constructor(configService) {
        this.configService = configService;
        // Initialize with values from configuration (reads from .env)
        const port = this.configService.get('port', 2785);
        this.settings = {
            general: {
                // The real advertised base URL (BASE_URL — the same value the startup banner and ingress URLs
                // use), not a hardcoded localhost guess that ignores the operator's configured host.
                apiBaseUrl: process.env.BASE_URL || `http://localhost:${port}`,
                // The engine auto-reconnects on a transient disconnect by default (there is no global off
                // switch; attempts are unlimited unless a session sets config.maxReconnectAttempts, which on
                // Baileys bounds only the reconnect after a logged-out close, not a transient drop). Reporting a hardcoded
                // `false` for a non-existent `engine.autoReconnect` key was actively misleading.
                autoReconnect: true,
                debugMode: this.configService.get('database.logging', false),
            },
            api: {
                rateLimit: this.configService.get('api.rateLimit.mediumLimit', 100),
                rateLimitWindow: this.configService.get('api.rateLimit.mediumTtl', 60000),
                // Reflect the REAL ENABLE_SWAGGER gate (off by default in production), not a hardcoded `true`
                // — otherwise the panel reports docs enabled in production where they are actually disabled.
                enableDocs: (0, bootstrap_security_1.isSwaggerEnabled)(process.env.ENABLE_SWAGGER, process.env.NODE_ENV),
            },
            // Fixed placeholders: no notification feature exists, so nothing here may report one as on.
            notifications: {
                emailEnabled: false,
                notificationEmail: '',
                webhookAlerts: false,
            },
        };
    }
    get() {
        // Settings expose environment-derived configuration (debug flag, reconnect policy, rate-limit
        // thresholds, base URL) that describes the deployment rather than any one session. Gate the read
        // at ADMIN and require an unrestricted key: the role check alone does not exclude a key confined
        // to specific sessions, which has no claim on deployment-wide configuration.
        return this.settings;
    }
};
exports.SettingsController = SettingsController;
__decorate([
    (0, common_1.Get)(),
    (0, auth_decorators_1.RequireRole)(api_key_entity_1.ApiKeyRole.ADMIN),
    (0, auth_decorators_1.RequireUnscopedKey)(),
    (0, swagger_1.ApiOperation)({ summary: 'Get application settings' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Current settings', type: settings_response_dto_1.SettingsResponseDto }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Object)
], SettingsController.prototype, "get", null);
exports.SettingsController = SettingsController = __decorate([
    (0, swagger_1.ApiTags)('settings'),
    (0, common_1.Controller)('settings'),
    __metadata("design:paramtypes", [config_1.ConfigService])
], SettingsController);
