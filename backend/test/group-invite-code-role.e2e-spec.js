"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("../src/app.module");
const app_validation_1 = require("../src/config/app-validation");
const auth_service_1 = require("../src/modules/auth/auth.service");
const api_key_entity_1 = require("../src/modules/auth/entities/api-key.entity");
const session_entity_1 = require("../src/modules/session/entities/session.entity");
const engine_registry_service_1 = require("../src/engine/engine-registry.service");
/**
 * A group invite code is a transferable join capability, not read data: whoever holds the link
 * joins the group on WhatsApp with no OpenWA credential at all, and that membership survives
 * revoking the key that fetched the code. These tests pin the invite-code GET at the OPERATOR
 * role through the real HTTP stack, mirroring the QR endpoint: the reads whose payload is a
 * credential for a system outside OpenWA's authority are not VIEWER surface.
 *
 * The engine is a stub registered in the live EngineRegistry (the message-send e2e harness), so
 * the 403 asserts the guard refusal itself while the 200s prove the pass-through path: a
 * session-scoped VIEWER key is the least-credential holder that can otherwise reach the route.
 */
describe('Group invite-code role gate (e2e)', () => {
    let app;
    let sessionId;
    let scopedViewerKey;
    let operatorKey;
    let adminKey;
    const groupId = '120363021234567890@g.us';
    const engine = {
        getGroupInviteCode: jest.fn().mockResolvedValue('AbCdEf123456'),
    };
    const inviteCodeGet = (key) => (0, supertest_1.default)(app.getHttpServer()).get(`/api/sessions/${sessionId}/groups/${groupId}/invite-code`).set('X-API-Key', key);
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        const sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-invite-${Date.now()}` }))).id;
        app.get(engine_registry_service_1.EngineRegistry).set(sessionId, engine);
        const authService = app.get(auth_service_1.AuthService);
        scopedViewerKey = (await authService.createApiKey({
            name: 'e2e-invite-viewer',
            role: api_key_entity_1.ApiKeyRole.VIEWER,
            allowedSessions: [sessionId],
        })).rawKey;
        operatorKey = (await authService.createApiKey({ name: 'e2e-invite-operator', role: api_key_entity_1.ApiKeyRole.OPERATOR })).rawKey;
        adminKey = (await authService.createApiKey({ name: 'e2e-invite-admin', role: api_key_entity_1.ApiKeyRole.ADMIN })).rawKey;
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore TypeORM multi-datasource teardown quirk */
        }
    });
    beforeEach(() => jest.clearAllMocks());
    it('refuses a session-scoped VIEWER key (403) without reaching the engine', async () => {
        const res = await inviteCodeGet(scopedViewerKey).expect(403);
        expect(res.body.message).toContain('Required: operator');
        expect(engine.getGroupInviteCode).not.toHaveBeenCalled();
    });
    it('serves an OPERATOR key the code + link', async () => {
        const res = await inviteCodeGet(operatorKey).expect(200);
        expect(res.body).toEqual({
            inviteCode: 'AbCdEf123456',
            inviteLink: 'https://chat.whatsapp.com/AbCdEf123456',
        });
        expect(engine.getGroupInviteCode).toHaveBeenCalledWith(groupId);
    });
    it('serves an ADMIN key the code + link', async () => {
        await inviteCodeGet(adminKey).expect(200);
    });
});
