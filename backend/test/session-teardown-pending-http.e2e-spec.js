"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("./../src/app.module");
const app_validation_1 = require("./../src/config/app-validation");
const auth_service_1 = require("./../src/modules/auth/auth.service");
const api_key_entity_1 = require("./../src/modules/auth/entities/api-key.entity");
const session_service_1 = require("./../src/modules/session/session.service");
/**
 * Task 5 follow-up (Minor M2): the existing logout-teardown-race.spec.ts asserts the thrown object's
 * `.getResponse()` at the SERVICE layer, but NOTHING asserted the `code: 'SESSION_NAME_TEARDOWN_PENDING'`
 * field survives Nest's default exception-filter serialization and reaches the JSON body a real REST
 * caller sees. That serialization relies on Nest's standard handling of an object-response HttpException,
 * which is correct-but-unverified for THIS code path.
 *
 * Driven through the real HTTP stack (AppModule + applyGlobalValidation, the exact production bootstrap)
 * with NO custom exception filter registered, so the object-response ConflictException that
 * `SessionEngineLifecycle.awaitPendingTeardown()` throws is serialized by Nest's default filter — proving the
 * stable `code` field reaches the response body unchanged. The service is overridden to throw the exact
 * ConflictException shape the source constructs, so this exercises the real Nest serialization path
 * (controller + DI + filter) rather than re-running the 10s bounded-wait (which needs fake timers and
 * would fight supertest's socket handling in an e2e boot).
 */
describe('Session name-scoped teardown fence: 409 code survives HTTP serialization (e2e)', () => {
    let app;
    let adminKey;
    let sessionId;
    beforeAll(async () => {
        // The exact object-response ConflictException the service throws on a name-scoped teardown still
        // pending past its 10s fail-closed bound — constructed once and returned by both overridden handlers
        // so this asserts the same shape that production code emits, not a hand-rolled approximation.
        const teardownPending = new common_1.ConflictException({
            statusCode: common_1.HttpStatus.CONFLICT,
            message: `A credential teardown for session 'teardown-pending' is still in flight. Wait for it to ` +
                'settle and retry.',
            error: 'Conflict',
            code: 'SESSION_NAME_TEARDOWN_PENDING',
        });
        const moduleRef = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] })
            .overrideProvider(session_service_1.SessionService)
            .useValue({
            // Both start() and delete() call awaitPendingTeardown(session.name) before any lifecycle mutation;
            // a still-pending teardown makes the first fence throw this ConflictException.
            start: jest.fn().mockRejectedValue(teardownPending),
            delete: jest.fn().mockRejectedValue(teardownPending),
            // findOne() is called by the controller before start()/delete(); return a minimal session so the
            // route reaches the service method under test (delete() also calls findOne() itself).
            findOne: jest.fn().mockResolvedValue({
                id: 'sess-teardown-pending',
                name: 'teardown-pending',
            }),
        })
            .compile();
        app = moduleRef.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        const authService = app.get(auth_service_1.AuthService);
        adminKey = (await authService.createApiKey({ name: 'e2e-teardown-admin', role: api_key_entity_1.ApiKeyRole.ADMIN })).rawKey;
        // A ParseUUIDPipe-valid session id for the route param; the overridden findOne() ignores it but the
        // pipe still validates the shape before the handler runs.
        sessionId = '00000000-0000-4000-8000-000000000000';
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    it('DELETE /api/sessions/:sessionId serializes the teardown-pending 409 with the code field in the body', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).delete(`/api/sessions/${sessionId}`).set('X-API-Key', adminKey);
        expect(res.status).toBe(409);
        // The load-bearing assertion: the stable machine-readable code Nest's default filter copies from the
        // object-response ConflictException survives into the REST caller's JSON body.
        expect(res.body).toMatchObject({
            statusCode: 409,
            error: 'Conflict',
            code: 'SESSION_NAME_TEARDOWN_PENDING',
        });
        // Message is a nested object on Nest's serialized body; assert it without an unsafe `any` access.
        expect(res.body.message).toEqual(expect.stringContaining('still in flight'));
    });
    it('POST /api/sessions/:sessionId/start serializes the teardown-pending 409 with the code field in the body', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).post(`/api/sessions/${sessionId}/start`).set('X-API-Key', adminKey);
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({
            statusCode: 409,
            error: 'Conflict',
            code: 'SESSION_NAME_TEARDOWN_PENDING',
        });
    });
});
