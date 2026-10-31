"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("./../src/app.module");
const app_validation_1 = require("./../src/config/app-validation");
const auth_service_1 = require("./../src/modules/auth/auth.service");
const api_key_entity_1 = require("./../src/modules/auth/entities/api-key.entity");
const request_metrics_1 = require("./../src/common/metrics/request-metrics");
/**
 * Smoke e2e: the previous test asserted a non-existent Hello-World route and failed to
 * even compile. This boots the real app (SQLite, no queue) and checks the
 * public health route, the auth boundary, and unknown-route handling.
 */
describe('App smoke (e2e)', () => {
    let app;
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        // Mirror the bits of main.ts that affect routing/validation.
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
    });
    afterAll(async () => {
        // app.close() can throw a "could not find DataSource" during TypeORM's shutdown hook because
        // both connections are NAMED ('main'/'data') with no default DataSource — a teardown-only
        // artifact, not an app bug (the smoke assertions above already validated a healthy boot).
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    it('GET /api/health is public and returns ok', () => {
        return (0, supertest_1.default)(app.getHttpServer())
            .get('/api/health')
            .expect(200)
            .expect(res => {
            const body = res.body;
            if (body.status !== 'ok')
                throw new Error(`unexpected health body: ${JSON.stringify(res.body)}`);
        });
    });
    it('GET /api/health withholds the version without credentials, discloses it to a valid key', async () => {
        const authService = app.get(auth_service_1.AuthService);
        const { rawKey } = await authService.createApiKey({ name: 'e2e-health', role: api_key_entity_1.ApiKeyRole.VIEWER });
        await (0, supertest_1.default)(app.getHttpServer())
            .get('/api/health')
            .expect(200)
            .expect(res => {
            if ('version' in res.body)
                throw new Error('version disclosed without credentials');
        });
        await (0, supertest_1.default)(app.getHttpServer())
            .get('/api/health')
            .set('X-API-Key', rawKey)
            .expect(200)
            .expect(res => {
            const body = res.body;
            if (typeof body.version !== 'string' || !body.version) {
                throw new Error('version missing for an authenticated caller');
            }
        });
    });
    it('GET /api/sessions without an API key is rejected (401)', () => {
        return (0, supertest_1.default)(app.getHttpServer()).get('/api/sessions').expect(401);
    });
    // A driver refuses an OFFSET of 2^63 or more, so a window that far out answered 500 instead of an
    // empty page. Through the real controllers, query parsing and services, on the database the app booted.
    it('GET the session and message lists answer an empty page for an offset past the largest safe integer', async () => {
        const { rawKey } = await app.get(auth_service_1.AuthService).createApiKey({ name: 'e2e-offset', role: api_key_entity_1.ApiKeyRole.VIEWER });
        const offset = '99999999999999999999';
        const sessions = await (0, supertest_1.default)(app.getHttpServer()).get(`/api/sessions?offset=${offset}`).set('X-API-Key', rawKey);
        expect(sessions.status).toBe(200);
        expect(sessions.body).toEqual([]);
        const messages = await (0, supertest_1.default)(app.getHttpServer())
            .get(`/api/sessions/0a941dac-a965-45e7-b318-74ae8be134f0/messages?offset=${offset}`)
            .set('X-API-Key', rawKey);
        expect(messages.status).toBe(200);
        expect(messages.body).toMatchObject({ messages: [], total: 0 });
    });
    it('GET an unknown route returns 404', () => {
        return (0, supertest_1.default)(app.getHttpServer()).get('/api/this-route-does-not-exist').expect(404);
    });
    it('GET /api/metrics is disabled (404) when METRICS_TOKEN is unset', () => {
        // Secure default: no scrape token configured → the endpoint must not exist.
        return (0, supertest_1.default)(app.getHttpServer()).get('/api/metrics').expect(404);
    });
    it('POST /mcp returns 404 when MCP_ENABLED is unset', () => {
        // MCP is off by default; the route must not be mounted, not fall through to the SPA.
        return (0, supertest_1.default)(app.getHttpServer()).post('/mcp').send({ jsonrpc: '2.0', method: 'tools/list', id: 1 }).expect(404);
    });
});
/**
 * RED-metrics honesty e2e: requests rejected by the global guards (API-key 401/403) never reach
 * the RequestMetricsInterceptor, so the boundary middleware must count them — with the real
 * status and the matched route pattern — while requests that pass the guards are still counted
 * exactly once (by the interceptor). Runs against the live app boot so the wiring (Nest
 * middleware order, Express req.route, exception-filter status) is the production one.
 */
describe('App RED metrics (e2e)', () => {
    let app;
    let adminKey;
    let viewerKey;
    const lines = () => (0, request_metrics_1.renderHttpRequestMetrics)();
    const counter = (method, route, status) => {
        const prefix = `http_requests_total{method="${method}",route="${route}",status="${status}"} `;
        const line = lines().find(l => l.startsWith(prefix));
        return line ? Number(line.slice(prefix.length)) : 0;
    };
    const totalRequests = () => lines()
        .filter(l => l.startsWith('http_requests_total{'))
        .reduce((sum, l) => sum + Number(l.split('} ')[1]), 0);
    const totalDurationObservations = () => lines()
        .filter(l => l.startsWith('http_request_duration_seconds_count{'))
        .reduce((sum, l) => sum + Number(l.split('} ')[1]), 0);
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        const authService = app.get(auth_service_1.AuthService);
        adminKey = (await authService.createApiKey({ name: 'e2e-red-admin', role: api_key_entity_1.ApiKeyRole.ADMIN })).rawKey;
        viewerKey = (await authService.createApiKey({ name: 'e2e-red-viewer', role: api_key_entity_1.ApiKeyRole.VIEWER })).rawKey;
        // The store is process-wide; count only this suite's requests from here on.
        (0, request_metrics_1.resetHttpRequestMetrics)();
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    it('records a guard-rejected request (401, no API key) with its real status and route', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/sessions').expect(401);
        expect(counter('GET', '/api/sessions', '401')).toBe(1);
        expect(totalRequests()).toBe(1);
    });
    it('counts a request that passes the guards exactly once (no middleware/interceptor double-count)', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/sessions').set('X-API-Key', adminKey).expect(200);
        expect(counter('GET', '/api/sessions', '200')).toBe(1);
        expect(counter('GET', '/api/sessions', '401')).toBe(1); // unchanged by the 200
        expect(totalRequests()).toBe(2);
    });
    it('records a role-denied request (403, viewer key on an admin route)', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/auth/api-keys').set('X-API-Key', viewerKey).expect(403);
        expect(counter('GET', '/api/auth/api-keys', '403')).toBe(1);
        expect(totalRequests()).toBe(3);
    });
    it('still skips /api/health entirely', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/health').expect(200);
        expect(lines().some(l => l.includes('/api/health'))).toBe(false);
        expect(totalRequests()).toBe(3);
    });
    it('collapses unmatched routes (404) into the constant (unmatched) label', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get('/api/no-such-route').expect(404);
        expect(counter('GET', '(unmatched)', '404')).toBe(1);
        expect(totalRequests()).toBe(4);
    });
    it('keeps the request counter and duration histogram consistent (same observation count)', () => {
        expect(totalRequests()).toBe(4);
        expect(totalDurationObservations()).toBe(4);
    });
});
