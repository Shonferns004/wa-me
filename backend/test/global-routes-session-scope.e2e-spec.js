"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("./../src/app.module");
const app_validation_1 = require("./../src/config/app-validation");
const request_context_middleware_1 = require("./../src/common/middleware/request-context.middleware");
const auth_service_1 = require("./../src/modules/auth/auth.service");
const api_key_entity_1 = require("./../src/modules/auth/entities/api-key.entity");
const session_entity_1 = require("./../src/modules/session/entities/session.entity");
const audit_log_entity_1 = require("./../src/modules/audit/entities/audit-log.entity");
/**
 * Cross-session aggregates, environment-derived settings, and session creation all act outside any
 * single session, so the guard's route-param fence cannot scope them. A key restricted to specific
 * sessions must not read deployment-wide activity, read server configuration, or create sessions
 * outside its own allowlist.
 */
describe('Global read and create routes reject session-scoped keys (e2e)', () => {
    let app;
    let scopedAdminKey; // ADMIN, allowedSessions: [sessA]
    let scopedAdminKeyId;
    let scopedOperatorKey; // OPERATOR, allowedSessions: [sessA]
    let adminKey; // ADMIN, unrestricted
    let scopedSessionId; // the session the scoped keys are confined to
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        // Installed by configureApp in production; audit rows take their key from this context.
        app.use(request_context_middleware_1.requestContextMiddleware);
        await app.init();
        const sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        const a = await sessionRepo.save(sessionRepo.create({ name: `e2e-global-scope-${Date.now()}` }));
        scopedSessionId = a.id;
        const authService = app.get(auth_service_1.AuthService);
        const scoped = await authService.createApiKey({
            name: 'e2e-global-scoped',
            role: api_key_entity_1.ApiKeyRole.ADMIN,
            allowedSessions: [a.id],
        });
        scopedAdminKey = scoped.rawKey;
        scopedAdminKeyId = scoped.apiKey.id;
        scopedOperatorKey = (await authService.createApiKey({ name: 'e2e-global-op', role: api_key_entity_1.ApiKeyRole.OPERATOR, allowedSessions: [a.id] })).rawKey;
        adminKey = (await authService.createApiKey({ name: 'e2e-global-admin', role: api_key_entity_1.ApiKeyRole.ADMIN })).rawKey;
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    it('rejects a scoped ADMIN on GET /api/stats/overview', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/stats/overview').set('X-API-Key', scopedAdminKey).expect(403);
    });
    it('rejects a scoped ADMIN on GET /api/stats/messages', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/stats/messages').set('X-API-Key', scopedAdminKey).expect(403);
    });
    it('rejects a scoped ADMIN on GET /api/settings', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/settings').set('X-API-Key', scopedAdminKey).expect(403);
    });
    it('rejects a scoped ADMIN on POST /api/sessions', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/api/sessions')
            .set('X-API-Key', scopedAdminKey)
            .send({ name: `e2e-escape-admin-${Date.now()}` })
            .expect(403);
    });
    it('rejects a scoped OPERATOR on POST /api/sessions (cannot create outside its allowlist)', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/api/sessions')
            .set('X-API-Key', scopedOperatorKey)
            .send({ name: `e2e-escape-operator-${Date.now()}` })
            .expect(403);
    });
    it('lets an unrestricted key reach the global stats overview', async () => {
        // Control: the fence rejects scoped keys on this route but must not hinder an unrestricted one.
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/stats/overview').set('X-API-Key', adminKey);
        expect(res.status).toBe(200);
    });
    it('lets a session-scoped key reach per-session stats for its own session', async () => {
        // The per-session route carries no fence — its :sessionId route param is the scope. Pin that the
        // global-route fencing above does not over-reach onto it.
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/stats/sessions/${scopedSessionId}`)
            .set('X-API-Key', scopedAdminKey);
        expect(res.status).toBe(200);
    });
    it('counts only its own sessions for a scoped key on GET /api/sessions/stats/overview', async () => {
        // The route names no :sessionId, so the guard cannot scope it: the key's allowlist handed to the
        // service is the only thing keeping the gateway-wide totals from a scoped key. A session outside the
        // allowlist makes the two answers differ; the control proves it is really counted.
        const sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        await sessionRepo.save(sessionRepo.create({ name: `e2e-global-scope-stats-${Date.now()}` }));
        const overview = (key) => (0, supertest_1.default)(app.getHttpServer())
            .get('/api/sessions/stats/overview')
            .set('X-API-Key', key)
            .expect(200)
            .then(res => res.body);
        expect(await overview(scopedOperatorKey)).toMatchObject({ total: 1, byStatus: { created: 1 } });
        expect((await overview(adminKey)).total).toBeGreaterThanOrEqual(2);
    });
    it('denies a session-scoped key per-session stats for a session outside its scope', async () => {
        // The param-scope check refuses a live key, so it answers 403 like the fence above, and the audit
        // row names the key that was refused.
        const sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        const other = await sessionRepo.save(sessionRepo.create({ name: `e2e-global-scope-other-${Date.now()}` }));
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/stats/sessions/${other.id}`)
            .set('X-API-Key', scopedAdminKey)
            .expect(403);
        expect(res.body.message).toBe('API key not authorized for this session');
        const auditRepo = app.get((0, typeorm_1.getRepositoryToken)(audit_log_entity_1.AuditLog, 'main'));
        const path = `/api/stats/sessions/${other.id}`;
        let row = null;
        for (let i = 0; i < 50 && !row; i++) {
            row = await auditRepo.findOne({ where: { action: audit_log_entity_1.AuditAction.API_KEY_AUTH_FAILED, path } });
            if (!row)
                await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(row?.apiKeyId).toBe(scopedAdminKeyId);
    });
    it('leaves an unrestricted ADMIN able to create a session', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/api/sessions')
            .set('X-API-Key', adminKey)
            .send({ name: `e2e-global-ok-${Date.now()}` })
            .expect(201);
    });
});
