"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const session_controller_1 = require("./session.controller");
const session_service_1 = require("./session.service");
const audit_service_1 = require("../audit/audit.service");
const chat_scope_service_1 = require("../auth/chat-scope.service");
// Nest answers a handler's returned null with an empty body, so the documented JSON `null` can only
// be seen through a real Nest/Express app.
describe('SessionController over HTTP: GET presence', () => {
    let app;
    const getPresence = jest.fn();
    const url = '/sessions/0a941dac-a965-45e7-b318-74ae8be134f0/presence/628123@c.us';
    beforeAll(async () => {
        const mod = await testing_1.Test.createTestingModule({
            controllers: [session_controller_1.SessionController],
            providers: [
                { provide: session_service_1.SessionService, useValue: { getPresence } },
                { provide: audit_service_1.AuditService, useValue: {} },
                chat_scope_service_1.ChatScopeService,
            ],
        }).compile();
        app = mod.createNestApplication({ logger: false });
        await app.init();
    });
    afterAll(async () => {
        await app.close();
    });
    it('answers a JSON null when nothing has been reported', async () => {
        getPresence.mockResolvedValue(null);
        const res = await (0, supertest_1.default)(app.getHttpServer()).get(url);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^application\/json/);
        expect(res.text).toBe('null');
    });
    it('answers the presence with observedAt as an ISO timestamp', async () => {
        getPresence.mockResolvedValue({ chatId: '628123@c.us', participants: [], observedAt: 1_786_000_000_000 });
        const res = await (0, supertest_1.default)(app.getHttpServer()).get(url);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            chatId: '628123@c.us',
            participants: [],
            observedAt: new Date(1_786_000_000_000).toISOString(),
        });
    });
});
