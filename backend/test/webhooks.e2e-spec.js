"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const http_1 = __importDefault(require("http"));
const crypto_1 = __importDefault(require("crypto"));
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("./../src/app.module");
const app_validation_1 = require("./../src/config/app-validation");
const auth_service_1 = require("./../src/modules/auth/auth.service");
const api_key_entity_1 = require("./../src/modules/auth/entities/api-key.entity");
const session_entity_1 = require("./../src/modules/session/entities/session.entity");
const webhook_service_1 = require("./../src/modules/webhook/webhook.service");
const hooks_1 = require("./../src/core/hooks");
/**
 * End-to-end coverage for the webhooks module across the seam the unit specs can't reach: the REST
 * surface (CRUD + auth + validation, with the global ValidationPipe), persistence, and real
 * HMAC-signed HTTP delivery to a live local receiver. Dispatch is the one thing the WhatsApp socket
 * would normally trigger, so we call WebhookService.dispatch() directly - that boundary isn't
 * webhook logic.
 *
 * SSRF protection is ON by default and would reject the 127.0.0.1 receiver at both registration and
 * delivery, so the suite runs with WEBHOOK_SSRF_PROTECT=false (one test flips it back on locally).
 */
describe('Webhooks (e2e)', () => {
    let app;
    let webhookService;
    let sessionRepo;
    let apiKey;
    let viewerKey;
    let received;
    let receiver;
    let receiverUrl;
    const prevSsrf = process.env.WEBHOOK_SSRF_PROTECT;
    const prevMaxPerSession = process.env.WEBHOOK_MAX_PER_SESSION;
    const prevMediaInlineMax = process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES;
    // Webhooks carry a CASCADE foreign key to a session row, and dispatch looks them up by sessionId.
    // Persisting one real session per test both satisfies the FK and isolates each case (and prior
    // runs) from the others, since dispatch and the session-scoped routes only see that session's id.
    let sessionSeq = 0;
    const nextSession = async () => {
        const session = await sessionRepo.save(sessionRepo.create({ name: `e2e-webhooks-${Date.now()}-${sessionSeq++}` }));
        return session.id;
    };
    const waitFor = async (predicate, timeoutMs = 1000) => {
        const start = Date.now();
        while (!predicate()) {
            if (Date.now() - start > timeoutMs)
                throw new Error('timed out waiting for condition');
            await new Promise(r => setTimeout(r, 10));
        }
    };
    // Create a webhook via the REST API (exercises CreateWebhookDto + filter validation) and return the
    // response DTO. Defaults to the receiver URL + a subscribe-all event so dispatch tests can refine
    // behaviour purely through filters/overrides.
    const createWebhook = async (session, overrides = {}) => {
        const res = await (0, supertest_1.default)(app.getHttpServer())
            .post(`/api/sessions/${session}/webhooks`)
            .set('X-API-Key', apiKey)
            .send({ url: receiverUrl, events: ['*'], ...overrides })
            .expect(201);
        return res.body;
    };
    beforeAll(async () => {
        process.env.WEBHOOK_SSRF_PROTECT = 'false';
        // Small bounds so the payload-bounds cases below exercise them without bulky setups. Read once
        // at module load, so they must be set before AppModule compiles.
        process.env.WEBHOOK_MAX_PER_SESSION = '3';
        process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES = '1024';
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
        webhookService = app.get(webhook_service_1.WebhookService);
        sessionRepo = app.get((0, typeorm_1.getRepositoryToken)(session_entity_1.Session, 'data'));
        // Mint real keys so the suite doesn't depend on seed/DB state; ADMIN covers the OPERATOR routes.
        const authService = app.get(auth_service_1.AuthService);
        apiKey = (await authService.createApiKey({ name: 'e2e-admin', role: api_key_entity_1.ApiKeyRole.ADMIN })).rawKey;
        viewerKey = (await authService.createApiKey({ name: 'e2e-viewer', role: api_key_entity_1.ApiKeyRole.VIEWER })).rawKey;
        received = [];
        receiver = http_1.default.createServer((req, res) => {
            let raw = '';
            req.on('data', chunk => (raw += chunk));
            req.on('end', () => {
                received.push({ headers: req.headers, raw, body: JSON.parse(raw || '{}') });
                res.writeHead(200).end();
            });
        });
        await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
        receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
    });
    afterAll(async () => {
        await new Promise(resolve => receiver.close(() => resolve()));
        if (prevSsrf === undefined)
            delete process.env.WEBHOOK_SSRF_PROTECT;
        else
            process.env.WEBHOOK_SSRF_PROTECT = prevSsrf;
        if (prevMaxPerSession === undefined)
            delete process.env.WEBHOOK_MAX_PER_SESSION;
        else
            process.env.WEBHOOK_MAX_PER_SESSION = prevMaxPerSession;
        if (prevMediaInlineMax === undefined)
            delete process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES;
        else
            process.env.WEBHOOK_MEDIA_INLINE_MAX_BYTES = prevMediaInlineMax;
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    beforeEach(() => {
        received = [];
    });
    // ── CRUD over the REST surface ────────────────────────────────────
    describe('CRUD over REST', () => {
        it('creates a webhook and never leaks the secret or headers in the response', async () => {
            const session = await nextSession();
            const dto = await createWebhook(session, {
                secret: 'top-secret-0123456789',
                headers: { 'X-Custom': 'v' },
                filters: { conditions: [{ field: 'sender', operator: 'is', value: ['a@c.us'] }] },
            });
            expect(dto.id).toBeDefined();
            expect(dto.sessionId).toBe(session);
            expect(dto.active).toBe(true);
            // Write-only fields must never appear in a webhook-route response (nor in the infra
            // export, which omits them from webhook rows — covered in infra-data.controller.spec.ts).
            expect(dto.secret).toBeUndefined();
            expect(dto.headers).toBeUndefined();
        });
        it('returns 404 when creating a webhook for a session that does not exist', async () => {
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/sessions/no-such-session/webhooks')
                .set('X-API-Key', apiKey)
                .send({ url: receiverUrl, events: ['*'] })
                .expect(404);
        });
        it('lists webhooks for a session', async () => {
            const session = await nextSession();
            const created = await createWebhook(session);
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .get(`/api/sessions/${session}/webhooks`)
                .set('X-API-Key', apiKey)
                .expect(200);
            const list = res.body;
            expect(list).toHaveLength(1);
            expect(list[0].id).toBe(created.id);
        });
        it('gets a webhook by id, and returns 404 for an unknown id', async () => {
            const session = await nextSession();
            const created = await createWebhook(session);
            await (0, supertest_1.default)(app.getHttpServer())
                .get(`/api/sessions/${session}/webhooks/${created.id}`)
                .set('X-API-Key', apiKey)
                .expect(200)
                .expect(res => {
                if (res.body.id !== created.id)
                    throw new Error('wrong webhook returned');
            });
            await (0, supertest_1.default)(app.getHttpServer())
                .get(`/api/sessions/${session}/webhooks/00000000-0000-0000-0000-000000000000`)
                .set('X-API-Key', apiKey)
                .expect(404);
        });
        it('updates fields and persists them', async () => {
            const session = await nextSession();
            const created = await createWebhook(session);
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .put(`/api/sessions/${session}/webhooks/${created.id}`)
                .set('X-API-Key', apiKey)
                .send({ events: ['message.received', 'session.status'], active: false })
                .expect(200);
            const updated = res.body;
            expect(updated.events).toEqual(['message.received', 'session.status']);
            expect(updated.active).toBe(false);
        });
        it('lists the webhook across all sessions via GET /api/webhooks', async () => {
            const session = await nextSession();
            const created = await createWebhook(session);
            const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/webhooks').set('X-API-Key', apiKey).expect(200);
            const ids = res.body.map(w => w.id);
            expect(ids).toContain(created.id);
        });
        it('deletes a webhook (204) and then it is gone (404)', async () => {
            const session = await nextSession();
            const created = await createWebhook(session);
            await (0, supertest_1.default)(app.getHttpServer())
                .delete(`/api/sessions/${session}/webhooks/${created.id}`)
                .set('X-API-Key', apiKey)
                .expect(204);
            await (0, supertest_1.default)(app.getHttpServer())
                .get(`/api/sessions/${session}/webhooks/${created.id}`)
                .set('X-API-Key', apiKey)
                .expect(404);
        });
    });
    // ── auth boundaries ───────────────────────────────────────────────
    describe('auth', () => {
        it('rejects a request with no API key (401)', async () => {
            const session = await nextSession();
            await (0, supertest_1.default)(app.getHttpServer()).get(`/api/sessions/${session}/webhooks`).expect(401);
        });
        it('forbids a viewer-role key from creating a webhook (403)', async () => {
            const session = await nextSession();
            await (0, supertest_1.default)(app.getHttpServer())
                .post(`/api/sessions/${session}/webhooks`)
                .set('X-API-Key', viewerKey)
                .send({ url: receiverUrl })
                .expect(403);
        });
    });
    // ── registration validation ───────────────────────────────────────
    describe('registration validation', () => {
        it('rejects a URL embedding credentials (userinfo) even with SSRF protection off', async () => {
            const session = await nextSession();
            // This suite runs with WEBHOOK_SSRF_PROTECT=false, so a 400 here proves the credential
            // rejection is not tied to the SSRF flag.
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post(`/api/sessions/${session}/webhooks`)
                .set('X-API-Key', apiKey)
                .send({ url: 'https://user:pass@example.com/hook' })
                .expect(400);
            expect(res.body.message).toMatch(/must not contain credentials/);
        });
        it('rejects an internal URL with 400 when SSRF protection is on', async () => {
            const session = await nextSession();
            // Self-contained: turn protection on and clear any ambient SSRF_ALLOWED_HOSTS (a dev .env may
            // allowlist 127.0.0.1) so the assertion holds regardless of the local environment.
            const prevAllow = process.env.SSRF_ALLOWED_HOSTS;
            process.env.WEBHOOK_SSRF_PROTECT = 'true';
            process.env.SSRF_ALLOWED_HOSTS = '';
            try {
                await (0, supertest_1.default)(app.getHttpServer())
                    .post(`/api/sessions/${session}/webhooks`)
                    .set('X-API-Key', apiKey)
                    .send({ url: 'http://169.254.169.254/hook' }) // link-local cloud metadata, a canonical SSRF target
                    .expect(400);
            }
            finally {
                process.env.WEBHOOK_SSRF_PROTECT = 'false';
                if (prevAllow === undefined)
                    delete process.env.SSRF_ALLOWED_HOSTS;
                else
                    process.env.SSRF_ALLOWED_HOSTS = prevAllow;
            }
        });
    });
    // ── dispatch over real HTTP ───────────────────────────────────────
    describe('dispatch over real HTTP', () => {
        it('delivers a correctly HMAC-signed POST when a filter matches', async () => {
            const session = await nextSession();
            const secret = 'sig-secret-0123456789';
            await createWebhook(session, {
                secret,
                filters: { conditions: [{ field: 'sender', operator: 'is', value: ['boss@c.us'] }] },
            });
            await webhookService.dispatch(session, 'message.received', { from: 'boss@c.us', body: 'hi' });
            await waitFor(() => received.length === 1);
            const { headers, raw, body } = received[0];
            expect(headers['x-openwa-event']).toBe('message.received');
            // Verify the signature over the exact bytes that were sent, not a re-serialization.
            const expected = `sha256=${crypto_1.default.createHmac('sha256', secret).update(raw).digest('hex')}`;
            expect(headers['x-openwa-signature']).toBe(expected);
            expect(body.data.from).toBe('boss@c.us');
        });
        it('does not deliver when the filter does not match', async () => {
            const session = await nextSession();
            await createWebhook(session, {
                filters: { conditions: [{ field: 'sender', operator: 'is', value: ['boss@c.us'] }] },
            });
            // dispatch() awaits every per-webhook delivery attempt end-to-end in this queue-off suite
            // (Promise.allSettled over the direct deliveries, each awaiting the receiver's response), and
            // the receiver records a hit BEFORE it answers — so a wrongly-attempted delivery would already
            // be in `received` here. A fixed sleep would only slow the assertion, not strengthen it.
            await webhookService.dispatch(session, 'message.received', { from: 'spammer@c.us', body: 'spam' });
            expect(received).toHaveLength(0);
        });
        it('passes a non-message event through a message-only filter', async () => {
            const session = await nextSession();
            await createWebhook(session, {
                filters: { conditions: [{ field: 'sender', operator: 'is', value: ['nobody@c.us'] }] },
            });
            await webhookService.dispatch(session, 'session.status', { status: 'connected' });
            await waitFor(() => received.length === 1);
            expect(received[0].headers['x-openwa-event']).toBe('session.status');
        });
        it('does not deliver to an inactive webhook', async () => {
            const session = await nextSession();
            const created = await createWebhook(session);
            await (0, supertest_1.default)(app.getHttpServer())
                .put(`/api/sessions/${session}/webhooks/${created.id}`)
                .set('X-API-Key', apiKey)
                .send({ active: false })
                .expect(200);
            // Same settled-dispatch reasoning as the filter-mismatch case above: the awaited dispatch()
            // resolves only after every attempted delivery completed, so no wait is needed before asserting.
            await webhookService.dispatch(session, 'message.received', { from: 'a@c.us' });
            expect(received).toHaveLength(0);
        });
        it('drops forged reserved headers but keeps custom ones on the wire', async () => {
            const session = await nextSession();
            await createWebhook(session, {
                headers: { 'X-OpenWA-Event': 'forged', 'Content-Type': 'text/plain', 'X-Custom': 'ok' },
            });
            await webhookService.dispatch(session, 'message.received', {});
            await waitFor(() => received.length === 1);
            const { headers } = received[0];
            expect(headers['x-openwa-event']).toBe('message.received'); // system value wins, not 'forged'
            expect(headers['content-type']).toBe('application/json');
            expect(headers['x-custom']).toBe('ok'); // legitimate custom header preserved
        });
        it('keeps server identity fields on the signed body when a webhook:before hook tampers with them', async () => {
            const session = await nextSession();
            const secret = 'sig-secret-0123456789';
            await createWebhook(session, { secret });
            const hookManager = app.get(hooks_1.HookManager);
            const hookId = hookManager.register('e2e-tamper', 'webhook:before', ctx => {
                const data = ctx.data;
                return Promise.resolve({
                    continue: true,
                    data: {
                        ...data,
                        payload: {
                            ...data.payload,
                            event: 'forged.event',
                            sessionId: 'other-session',
                            timestamp: '1999-01-01T00:00:00.000Z',
                        },
                    },
                });
            });
            try {
                await webhookService.dispatch(session, 'message.received', { from: 'boss@c.us' });
                await waitFor(() => received.length === 1);
                const { headers, raw, body } = received[0];
                // The tampered identity fields were re-asserted to the server's values, so the body still
                // matches the headers and the signature still verifies over the exact bytes received.
                expect(body.event).toBe('message.received');
                expect(body.sessionId).toBe(session);
                expect(body.timestamp).not.toBe('1999-01-01T00:00:00.000Z');
                expect(headers['x-openwa-event']).toBe('message.received');
                const expected = `sha256=${crypto_1.default.createHmac('sha256', secret).update(raw).digest('hex')}`;
                expect(headers['x-openwa-signature']).toBe(expected);
                expect(body.data.from).toBe('boss@c.us'); // data stays hook-controlled
            }
            finally {
                hookManager.unregister(hookId);
            }
        });
    });
    // ── payload bounds (per-session cap + inline-media shedding) ──────
    describe('payload bounds', () => {
        it('rejects the (cap+1)-th webhook with 400 while the grandfathered ones keep working', async () => {
            const session = await nextSession();
            // WEBHOOK_MAX_PER_SESSION=3 for this suite (set in beforeAll).
            for (let i = 0; i < 3; i++) {
                await createWebhook(session);
            }
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post(`/api/sessions/${session}/webhooks`)
                .set('X-API-Key', apiKey)
                .send({ url: receiverUrl, events: ['*'] })
                .expect(400);
            expect(res.body.message).toMatch(/Webhook limit reached/);
            // The webhooks registered before the cap are unaffected: every one of them still receives.
            await webhookService.dispatch(session, 'message.received', { from: 'a@c.us', body: 'hi' });
            await waitFor(() => received.length === 3);
        });
        it('delivers over-threshold media as an omitted marker, signed over the exact shed bytes', async () => {
            const session = await nextSession();
            const secret = 'media-secret-0123456789';
            await createWebhook(session, { secret });
            const base64 = Buffer.alloc(2048, 11).toString('base64'); // 2048 decoded bytes > 1024 inline cap
            await webhookService.dispatch(session, 'message.received', {
                from: 'a@c.us',
                media: { mimetype: 'image/jpeg', filename: 'big.jpg', data: base64 },
            });
            await waitFor(() => received.length === 1);
            const { headers, raw, body } = received[0];
            expect(body.data.media).toEqual({
                mimetype: 'image/jpeg',
                filename: 'big.jpg',
                omitted: true,
                sizeBytes: 2048,
            });
            // The signature verifies over the exact marker-form bytes the receiver got.
            const expected = `sha256=${crypto_1.default.createHmac('sha256', secret).update(raw).digest('hex')}`;
            expect(headers['x-openwa-signature']).toBe(expected);
        });
        it('keeps under-threshold media inline end-to-end', async () => {
            const session = await nextSession();
            await createWebhook(session);
            const base64 = Buffer.alloc(512, 4).toString('base64'); // 512 decoded bytes < 1024 inline cap
            await webhookService.dispatch(session, 'message.received', {
                from: 'a@c.us',
                media: { mimetype: 'image/jpeg', data: base64 },
            });
            await waitFor(() => received.length === 1);
            const media = received[0].body.data.media;
            expect(media.data).toBe(base64);
            expect(media.omitted).toBeUndefined();
        });
    });
    // ── the test endpoint ─────────────────────────────────────────────
    describe('test endpoint', () => {
        it('POST /:id/test delivers a test event to the receiver and reports success', async () => {
            const session = await nextSession();
            const created = await createWebhook(session);
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post(`/api/sessions/${session}/webhooks/${created.id}/test`)
                .set('X-API-Key', apiKey)
                .expect(200);
            expect(res.body.success).toBe(true);
            await waitFor(() => received.length === 1);
            expect(received[0].headers['x-openwa-event']).toBe('test');
        });
    });
});
