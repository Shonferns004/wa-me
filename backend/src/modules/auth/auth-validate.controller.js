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
exports.AuthValidateController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const auth_decorators_1 = require("./decorators/auth.decorators");
const api_key_entity_1 = require("./entities/api-key.entity");
const dto_1 = require("./dto");
const engine_factory_1 = require("../../engine/engine.factory");
let AuthValidateController = class AuthValidateController {
    engineFactory;
    constructor(engineFactory) {
        this.engineFactory = engineFactory;
    }
    validate(apiKey) {
        // This route is behind the global API-key guard, so only a validated key reaches this handler
        // (a missing/invalid key 401s first). The guard has already verified the key — including its
        // client-IP and session-scope restrictions — and attached it to the request. Re-validating here
        // would repeat that work without the client IP, double-counting usage and, for an IP-restricted
        // key, failing closed (no IP) and wrongly reporting valid:false. So we trust the guard's result.
        // The valid:false branch is unreachable in normal operation; it's retained as defense-in-depth in
        // case the guard config ever changes, keeping the endpoint safe to expose directly.
        if (!apiKey) {
            return { valid: false };
        }
        // The engine rides along because GET /infra/engines/current is admin-only, and the dashboard needs
        // it for every role that can post a status or read channels. `scoped` lets it skip the routes that
        // refuse a session-scoped key (@RequireUnscopedKey) instead of sending reads the guard rejects.
        return {
            valid: true,
            role: apiKey.role,
            engineType: this.engineFactory.getCurrentEngine(),
            scoped: (apiKey.allowedSessions?.length ?? 0) > 0,
        };
    }
};
exports.AuthValidateController = AuthValidateController;
__decorate([
    (0, common_1.Post)('validate'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, swagger_1.ApiOperation)({ summary: 'Validate an API key' }),
    (0, swagger_1.ApiHeader)({ name: 'X-API-Key', description: 'API key to validate' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'API key is valid', type: dto_1.ValidateApiKeyResponseDto }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'Invalid or missing API key' }),
    (0, swagger_1.ApiResponse)({
        status: 403,
        description: 'The key is valid but refused here: its allowedIps exclude this client, or it is restricted to selected chats',
    }),
    __param(0, (0, auth_decorators_1.CurrentApiKey)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [api_key_entity_1.ApiKey]),
    __metadata("design:returntype", Object)
], AuthValidateController.prototype, "validate", null);
exports.AuthValidateController = AuthValidateController = __decorate([
    (0, swagger_1.ApiTags)('auth'),
    (0, common_1.Controller)('auth'),
    __metadata("design:paramtypes", [engine_factory_1.EngineFactory])
], AuthValidateController);
