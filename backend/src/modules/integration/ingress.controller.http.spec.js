"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const ingress_controller_1 = require("./ingress.controller");
const ingress_service_1 = require("./ingress.service");
const instance_throttler_guard_1 = require("./instance-throttler.guard");
// The controller spec's fake Response never runs Express's send(), so it cannot see a Content-Type that
// Express rejects while writing. This one answers through a real Nest/Express app.
describe('IngressController over HTTP: declared ack Content-Type', () => {
    let app;
    let declared = '';
    const handle = jest.fn(() => Promise.resolve({ status: 200, body: '{}', headers: { 'Content-Type': declared } }));
    beforeAll(async () => {
        const mod = await testing_1.Test.createTestingModule({
            controllers: [ingress_controller_1.IngressController],
            providers: [{ provide: ingress_service_1.IngressService, useValue: { handle } }],
        })
            .overrideGuard(instance_throttler_guard_1.InstanceThrottlerGuard)
            .useValue({ canActivate: () => true })
            .compile();
        app = mod.createNestApplication({ logger: false });
        await app.init();
    });
    afterAll(async () => {
        await app.close();
    });
    it.each([
        ['application/json', 'application/json; charset=utf-8'],
        ['application/json;', 'application/json; charset=utf-8'],
        ['application/json; charset=utf-8;', 'application/json; charset=utf-8'],
        ['application/json; foo', 'application/json; charset=utf-8'],
        ['text/plain;', 'text/plain; charset=utf-8'],
    ])('answers the ack for a declared %p', async (value, wire) => {
        declared = value;
        const res = await (0, supertest_1.default)(app.getHttpServer()).post('/ingress/p/i/hook').send('{}');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe(wire);
        expect(res.text).toBe('{}');
    });
});
