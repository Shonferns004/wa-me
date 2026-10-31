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
/**
 * The infrastructure routes carry no session dimension, so the ApiKeyGuard's route-param fence can
 * never bite on them: a session-restricted ADMIN key would otherwise export or replace the whole
 * deployment database, rewrite global engine configuration, or stop deployment services. They must
 * reject scoped keys outright, while leaving unrestricted ADMIN keys fully functional.
 */
describe('Infrastructure routes reject session-scoped keys (e2e)', () => {
    let app;
    let scopedKey; // ADMIN, allowedSessions: [sessA]
    let adminKey; // ADMIN, unrestricted
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        const sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        const sessA = await sessionRepo.save(sessionRepo.create({ name: `e2e-infra-scope-${Date.now()}` }));
        const authService = app.get(auth_service_1.AuthService);
        scopedKey = (await authService.createApiKey({ name: 'e2e-infra-scoped', role: api_key_entity_1.ApiKeyRole.ADMIN, allowedSessions: [sessA.id] })).rawKey;
        adminKey = (await authService.createApiKey({ name: 'e2e-infra-admin', role: api_key_entity_1.ApiKeyRole.ADMIN })).rawKey;
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    it('rejects a scoped ADMIN on GET /api/infra/export-data', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/infra/export-data').set('X-API-Key', scopedKey).expect(403);
    });
    it('rejects a scoped ADMIN on POST /api/infra/import-data', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .post('/api/infra/import-data')
            .set('X-API-Key', scopedKey)
            .send({ tables: {} })
            .expect(403);
    });
    it('rejects a scoped ADMIN on GET /api/infra/config', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/infra/config').set('X-API-Key', scopedKey).expect(403);
    });
    it('leaves the public health route reachable without a key', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/infra/health').expect(200);
    });
    it('leaves an unrestricted ADMIN able to read the export', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/infra/export-data').set('X-API-Key', adminKey).expect(200);
    });
});
