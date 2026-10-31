"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("./../src/app.module");
const configure_app_1 = require("./../src/configure-app");
const app_validation_1 = require("./../src/config/app-validation");
const auth_service_1 = require("./../src/modules/auth/auth.service");
const api_key_entity_1 = require("./../src/modules/auth/entities/api-key.entity");
const session_entity_1 = require("./../src/modules/session/entities/session.entity");
const engine_registry_service_1 = require("./../src/engine/engine-registry.service");
/**
 * A send that carries an Idempotency-Key is fingerprinted by an interceptor that walks the whole body, and
 * that runs BEFORE the validation pipe, so a guard inside the pipe cannot protect it: the stack overflowed in
 * the interceptor and the request answered 500. The nesting bound therefore sits right after the body parsers
 * in configureApp. This runs the real application behind it, with a fake engine registered for one session.
 */
describe('Request body nesting bound over the real application (e2e)', () => {
    let app;
    let sessionId;
    let operatorKey;
    const prevSimulateTyping = process.env.SIMULATE_TYPING;
    const result = { id: 'wamid.e2e-nesting', timestamp: 1_706_868_000 };
    const engine = { sendTextMessage: jest.fn().mockResolvedValue(result) };
    const sendText = (body, idempotencyKey) => {
        const req = (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/sessions/${sessionId}/messages/send-text`)
            .set('X-API-Key', operatorKey)
            .type('json');
        return (idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req).send(body);
    };
    const deepMentions = `{"chatId":"628123@c.us","text":"hi","mentions":${'['.repeat(5000)}${']'.repeat(5000)}}`;
    beforeAll(async () => {
        process.env.SIMULATE_TYPING = 'false';
        const moduleFixture = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        // `bodyParser: false` matches main.ts: configureApp installs the only parsers.
        app = moduleFixture.createNestApplication({ bodyParser: false });
        (0, configure_app_1.configureApp)(app);
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        const sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        sessionId = (await sessionRepo.save(sessionRepo.create({ name: `e2e-nesting-${Date.now()}` }))).id;
        app.get(engine_registry_service_1.EngineRegistry).set(sessionId, engine);
        operatorKey = (await app.get(auth_service_1.AuthService).createApiKey({ name: 'e2e-nesting', role: api_key_entity_1.ApiKeyRole.OPERATOR })).rawKey;
    });
    afterAll(async () => {
        process.env.SIMULATE_TYPING = prevSimulateTyping;
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    beforeEach(() => jest.clearAllMocks());
    it('sends normally with an Idempotency-Key, so the interceptor path under test is live', async () => {
        await sendText('{"chatId":"628123@c.us","text":"hello"}', 'nesting-control-1').expect(201);
        expect(engine.sendTextMessage).toHaveBeenCalledTimes(1);
    });
    it.each([
        ['with an Idempotency-Key', 'nesting-deep-1'],
        ['without one', undefined],
    ])('refuses a body nested thousands of levels deep with 400, %s', async (_label, key) => {
        const res = await sendText(deepMentions, key);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
        expect(engine.sendTextMessage).not.toHaveBeenCalled();
    });
});
