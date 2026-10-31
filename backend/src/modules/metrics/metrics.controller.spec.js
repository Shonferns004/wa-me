"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const metrics_controller_1 = require("./metrics.controller");
const metrics_service_1 = require("./metrics.service");
describe('MetricsController', () => {
    let app;
    let warn;
    const metricsService = { assertScrapeAuthorized: jest.fn(), render: jest.fn() };
    beforeAll(async () => {
        const moduleRef = await testing_1.Test.createTestingModule({
            controllers: [metrics_controller_1.MetricsController],
            providers: [{ provide: metrics_service_1.MetricsService, useValue: metricsService }],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
    });
    beforeEach(() => {
        warn = jest.spyOn(common_1.Logger.prototype, 'warn').mockImplementation(() => undefined);
        metricsService.assertScrapeAuthorized.mockReset();
        metricsService.render.mockReset().mockResolvedValue('openwa_up 1\n');
    });
    afterEach(() => warn.mockRestore());
    afterAll(async () => {
        await app.close();
    });
    it('answers a scrape with Prometheus text that is never cached', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/metrics');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^text\/plain/);
        expect(res.headers['content-type']).toContain('version=0.0.4');
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.text).toBe('openwa_up 1\n');
    });
    it('answers a refused scrape as JSON without logging a content-type warning', async () => {
        metricsService.assertScrapeAuthorized.mockImplementation(() => {
            throw new common_1.NotFoundException();
        });
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/metrics');
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(warn).not.toHaveBeenCalled();
        expect(metricsService.render).not.toHaveBeenCalled();
    });
});
