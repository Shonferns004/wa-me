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
const auth_service_1 = require("./../src/modules/auth/auth.service");
const api_key_entity_1 = require("./../src/modules/auth/entities/api-key.entity");
const session_entity_1 = require("./../src/modules/session/entities/session.entity");
const automation_rule_entity_1 = require("./../src/modules/automation/entities/automation-rule.entity");
/**
 * REST-surface coverage for autoreply rules: CRUD with the global ValidationPipe, role
 * enforcement, and the cross-session ownership fence. Evaluation itself (matching, cooldown,
 * loop-safety) is unit-covered in automation-rules.service.spec.ts — no engine runs here.
 */
describe('Automation rules (e2e)', () => {
    let app;
    let sessionRepo;
    let apiKey;
    let viewerKey;
    let sessionSeq = 0;
    const nextSession = async () => {
        const session = await sessionRepo.save(sessionRepo.create({ name: `e2e-automation-${Date.now()}-${sessionSeq++}` }));
        return session.id;
    };
    const createRule = async (session, overrides = {}) => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/sessions/${session}/automation-rules`)
            .set('X-API-Key', apiKey)
            .send({ name: 'greet', replyText: 'welcome!', ...overrides })
            .expect(201);
        return res.body;
    };
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        const authService = app.get(auth_service_1.AuthService);
        apiKey = (await authService.createApiKey({ name: 'e2e-automation-admin', role: api_key_entity_1.ApiKeyRole.ADMIN })).rawKey;
        viewerKey = (await authService.createApiKey({ name: 'e2e-automation-viewer', role: api_key_entity_1.ApiKeyRole.VIEWER })).rawKey;
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    it('creates a rule with defaults and reads it back', async () => {
        const session = await nextSession();
        const rule = await createRule(session);
        expect(rule.enabled).toBe(true);
        expect(rule.cooldownSeconds).toBe(60);
        expect(rule.conditions).toBeNull();
        expect(rule.replyText).toBe('welcome!');
        const fetched = await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/sessions/${session}/automation-rules/${rule.id}`)
            .set('X-API-Key', apiKey)
            .expect(200);
        expect(fetched.body.id).toBe(rule.id);
    });
    it('lists rules in evaluation order and updates in place', async () => {
        const session = await nextSession();
        const first = await createRule(session, { name: 'first' });
        await createRule(session, { name: 'second' });
        // createdAt has 1-second precision on SQLite; same-second rules tie and fall back to the id
        // tiebreak. Pin distinct timestamps so the asserted order is the chronological one.
        await app
            .get((0, typeorm_1.getRepositoryToken)(automation_rule_entity_1.AutomationRule, 'data'))
            .update(first.id, { createdAt: new Date('2026-01-01T00:00:00Z') });
        const list = await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/sessions/${session}/automation-rules`)
            .set('X-API-Key', apiKey)
            .expect(200);
        expect(list.body.map(r => r.name)).toEqual(['first', 'second']);
        const updated = await (0, supertest_1.default)(app.getHttpServer())
            .put(`/api/sessions/${session}/automation-rules/${first.id}`)
            .set('X-API-Key', apiKey)
            .send({ enabled: false, cooldownSeconds: 0 })
            .expect(200);
        const updatedBody = updated.body;
        expect(updatedBody.enabled).toBe(false);
        expect(updatedBody.cooldownSeconds).toBe(0);
    });
    it('deletes a rule (204) and answers 404 afterwards', async () => {
        const session = await nextSession();
        const rule = await createRule(session);
        await (0, supertest_1.default)(app.getHttpServer())
            .delete(`/api/sessions/${session}/automation-rules/${rule.id}`)
            .set('X-API-Key', apiKey)
            .expect(204);
        await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/sessions/${session}/automation-rules/${rule.id}`)
            .set('X-API-Key', apiKey)
            .expect(404);
    });
    it('fences rules to their owning session (cross-session read/update/delete answer 404)', async () => {
        const sessionA = await nextSession();
        const sessionB = await nextSession();
        const rule = await createRule(sessionA);
        const base = `/api/sessions/${sessionB}/automation-rules/${rule.id}`;
        await (0, supertest_1.default)(app.getHttpServer()).get(base).set('X-API-Key', apiKey).expect(404);
        await (0, supertest_1.default)(app.getHttpServer()).put(base).set('X-API-Key', apiKey).send({ name: 'x' }).expect(404);
        await (0, supertest_1.default)(app.getHttpServer()).delete(base).set('X-API-Key', apiKey).expect(404);
    });
    it('requires an API key (401) and the OPERATOR role (403 for a viewer)', async () => {
        const session = await nextSession();
        await (0, supertest_1.default)(app.getHttpServer()).get(`/api/sessions/${session}/automation-rules`).expect(401);
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/sessions/${session}/automation-rules`)
            .set('X-API-Key', viewerKey)
            .send({ name: 'x', replyText: 'y' })
            .expect(403);
    });
    it('rejects invalid rules: missing reply, unknown condition field, out-of-range cooldown', async () => {
        const session = await nextSession();
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/sessions/${session}/automation-rules`)
            .set('X-API-Key', apiKey)
            .send({ name: 'x' })
            .expect(400);
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/sessions/${session}/automation-rules`)
            .set('X-API-Key', apiKey)
            .send({
            name: 'x',
            replyText: 'y',
            conditions: { conditions: [{ field: 'no-such-field', operator: 'is', value: ['1'] }] },
        })
            .expect(400);
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/sessions/${session}/automation-rules`)
            .set('X-API-Key', apiKey)
            .send({ name: 'x', replyText: 'y', cooldownSeconds: 999_999 })
            .expect(400);
    });
});
