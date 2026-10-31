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
exports.MetricsController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const throttler_1 = require("@nestjs/throttler");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const metrics_service_1 = require("./metrics.service");
const swagger_config_1 = require("../../config/swagger.config");
/**
 * Prometheus scrape endpoint. `@Public()` bypasses the API-key guard and
 * `@SkipThrottle()` keeps a scrape interval from eating the rate-limit budget; access is
 * instead gated by METRICS_TOKEN inside the service (disabled-by-default), which bounds
 * failed token attempts per client on its own.
 */
let MetricsController = class MetricsController {
    metricsService;
    constructor(metricsService) {
        this.metricsService = metricsService;
    }
    // @Req (not @Headers('authorization')) so the OpenAPI op doesn't sprout a spurious required
    // `authorization` header parameter — the bearer is expressed via the security scheme above.
    async scrape(req, res) {
        this.metricsService.assertScrapeAuthorized(req.headers.authorization, req);
        // Set only once authorized: a text/plain type on a refused (JSON) reply makes Nest log a warning.
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        return this.metricsService.render();
    }
};
exports.MetricsController = MetricsController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: 'Prometheus metrics (requires METRICS_TOKEN bearer)' }),
    (0, swagger_1.ApiSecurity)(swagger_config_1.METRICS_BEARER_SCHEME),
    (0, swagger_1.ApiResponse)({
        status: 200,
        description: 'Prometheus exposition text',
        content: { 'text/plain': { schema: { type: 'string' } } },
    }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'METRICS_TOKEN is configured but the bearer is missing or wrong' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Metrics endpoint is disabled (METRICS_TOKEN unset)' }),
    (0, swagger_1.ApiResponse)({ status: 429, description: 'Too many failed token attempts from this client; retry after a minute' }),
    (0, common_1.Header)('Cache-Control', 'no-store')
    // @Req (not @Headers('authorization')) so the OpenAPI op doesn't sprout a spurious required
    // `authorization` header parameter — the bearer is expressed via the security scheme above.
    ,
    __param(0, (0, common_1.Req)()),
    __param(1, (0, common_1.Res)({ passthrough: true })),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], MetricsController.prototype, "scrape", null);
exports.MetricsController = MetricsController = __decorate([
    (0, swagger_1.ApiTags)('metrics'),
    (0, common_1.Controller)('metrics'),
    (0, auth_decorators_1.Public)(),
    (0, throttler_1.SkipThrottle)(),
    __metadata("design:paramtypes", [metrics_service_1.MetricsService])
], MetricsController);
