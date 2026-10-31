"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const metrics_module_1 = require("./metrics.module");
const request_metrics_middleware_1 = require("../../common/middleware/request-metrics.middleware");
jest.mock('../../common/middleware/request-metrics.middleware', () => ({
    requestMetricsBoundaryMiddleware: jest.fn((_req, _res, next) => next()),
}));
// MetricsModule's own imports need a database; only its middleware binding is under test, so a bare
// module borrows that `configure`.
let BoundaryOnlyModule = class BoundaryOnlyModule {
    configure(consumer) {
        metrics_module_1.MetricsModule.prototype.configure.call(this, consumer);
    }
};
BoundaryOnlyModule = __decorate([
    (0, common_1.Module)({})
], BoundaryOnlyModule);
describe('MetricsModule request-metrics boundary', () => {
    let app;
    let warn;
    beforeAll(async () => {
        warn = jest.spyOn(common_1.Logger.prototype, 'warn').mockImplementation(() => undefined);
        const moduleRef = await testing_1.Test.createTestingModule({ imports: [BoundaryOnlyModule] }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        app.setGlobalPrefix('api');
        await app.init();
    });
    afterAll(async () => {
        warn.mockRestore();
        await app.close();
    });
    it('binds without the legacy-wildcard warning Nest prints for an unnamed `*`', () => {
        const messages = warn.mock.calls.map(call => String(call[0]));
        expect(messages.filter(m => m.includes('Unsupported route path'))).toEqual([]);
    });
    it('still runs for every /api route and nothing outside it', async () => {
        const boundary = jest.mocked(request_metrics_middleware_1.requestMetricsBoundaryMiddleware);
        const hits = async (path) => {
            boundary.mockClear();
            await (0, supertest_1.default)(app.getHttpServer()).get(path);
            return boundary.mock.calls.length;
        };
        expect(await hits('/api/x')).toBe(1);
        expect(await hits('/api/nope/deep')).toBe(1);
        expect(await hits('/other')).toBe(0);
    });
});
