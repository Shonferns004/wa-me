"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Seed the well-known dev-admin-key BEFORE AppModule is imported (mirrors mcp-auth.e2e-spec.js's
// pattern of setting the enabling env var ahead of the import).
process.env.ALLOW_DEV_API_KEY = 'true';
process.env.BASE_URL = 'https://api.example.com';
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("../src/app.module");
const app_validation_1 = require("../src/config/app-validation");
const plugin_loader_service_1 = require("../src/core/plugins/plugin-loader.service");
const auth_service_1 = require("../src/modules/auth/auth.service");
const audit_log_entity_1 = require("../src/modules/audit/entities/audit-log.entity");
const api_key_entity_1 = require("../src/modules/auth/entities/api-key.entity");
const integration_delivery_failure_entity_1 = require("../src/modules/integration/entities/integration-delivery-failure.entity");
const infra_data_service_1 = require("../src/modules/infra/infra-data.service");
const scope_binding_service_1 = require("../src/modules/integration/scope-binding.service");
// A stub ingress-capable plugin so the capability check passes without a real plugin on disk. The
// configSchema carries a NESTED secret field so the masking tests can prove a `secret:true` config
// value is redacted at depth — including on the one-shot create/regenerate reveal responses.
const INGRESS_PLUGIN = {
    manifest: {
        id: 'chatwoot',
        ingress: [{ route: 'chatwoot' }],
        permissions: ['webhook:ingress', 'conversation:send'],
        configSchema: {
            type: 'object',
            properties: {
                baseUrl: { type: 'string' },
                credentials: {
                    type: 'object',
                    properties: {
                        apiToken: { type: 'string', secret: true },
                        region: { type: 'string' },
                    },
                },
            },
        },
    },
};
const NON_INGRESS_PLUGIN = { manifest: { id: 'plain', permissions: [] } };
describe('IntegrationInstanceController (e2e)', () => {
    let app;
    const key = 'dev-admin-key';
    const base = '/api/integration/plugins';
    // Hoisted so the redrive-provenance test can clear it before the POST and assert exactly which
    // delivery was dispatched inline (the e2e runs with QUEUE_ENABLED unset, so redrive dispatches
    // inline through this mock rather than enqueuing to BullMQ).
    const dispatchWebhookForInstance = jest.fn();
    beforeAll(async () => {
        const moduleRef = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] })
            .overrideProvider(plugin_loader_service_1.PluginLoaderService)
            .useValue({
            getPlugin: (id) => id === 'chatwoot' ? INGRESS_PLUGIN : id === 'plain' ? NON_INGRESS_PLUGIN : undefined,
            dispatchWebhookForInstance,
            // EngineFactory.onModuleInit registers the built-in whatsapp-web.js/baileys engine plugins
            // and auto-enables the configured one through these at boot; no-ops keep app boot working
            // without a real plugin registry (enablePlugin failing is caught+logged, not fatal, but a
            // no-op keeps the test log free of that expected-but-noisy error).
            registerBuiltInPlugin: jest.fn(),
            enablePlugin: jest.fn().mockResolvedValue(undefined),
            onModuleInit: jest.fn(),
            onModuleDestroy: jest.fn(),
        })
            .compile();
        app = moduleRef.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    // InfraDataService re-syncs plugin bindings after an import through a non-strict lookup of
    // ScopeBindingService, which lives in another module. Proven against the real module graph.
    it('lets InfraDataService resolve the app ScopeBindingService for the post-import resync', () => {
        const infraModuleRef = Reflect.get(app.get(infra_data_service_1.InfraDataService), 'moduleRef');
        expect(infraModuleRef?.get(scope_binding_service_1.ScopeBindingService, { strict: false })).toBe(app.get(scope_binding_service_1.ScopeBindingService));
    });
    it('requires an API key (401 without one)', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).get(`${base}/chatwoot/instances`).expect(401);
    });
    it('mints an instance and returns the secret + ingress URLs exactly once, then masks on read', async () => {
        const mint = await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/chatwoot/instances`)
            .set('X-API-Key', key)
            .send({ instanceId: 'acct1', sessionScope: 'sess-1' })
            .expect(201);
        const minted = mint.body;
        expect(minted.secret).toMatch(/^[0-9a-f]{64}$/);
        expect(minted.ingressUrls).toEqual([
            { route: 'chatwoot', url: 'https://api.example.com/api/ingress/chatwoot/acct1/chatwoot' },
        ]);
        const list = await (0, supertest_1.default)(app.getHttpServer()).get(`${base}/chatwoot/instances`).set('X-API-Key', key).expect(200);
        expect(list.body[0].secret).toBe('***');
        const one = await (0, supertest_1.default)(app.getHttpServer())
            .get(`${base}/chatwoot/instances/acct1`)
            .set('X-API-Key', key)
            .expect(200);
        expect(one.body.secret).toBe('***');
    });
    it('rejects minting on a non-ingress plugin (400) and a duplicate (409)', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/plain/instances`)
            .set('X-API-Key', key)
            .send({ instanceId: 'x' })
            .expect(400);
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/chatwoot/instances`)
            .set('X-API-Key', key)
            .send({ instanceId: 'acct1' })
            .expect(409);
    });
    it('rejects minting on an unknown plugin (404)', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/nonexistent/instances`)
            .set('X-API-Key', key)
            .send({ instanceId: 'x' })
            .expect(404);
    });
    it('rejects an invalid instanceId charset (400)', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/chatwoot/instances`)
            .set('X-API-Key', key)
            .send({ instanceId: 'bad:id' })
            .expect(400);
    });
    it('regenerates the secret and returns it once, then masks again on the next read', async () => {
        const regen = await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/chatwoot/instances/acct1/regenerate-secret`)
            .set('X-API-Key', key)
            .expect(200);
        expect(regen.body.secret).toMatch(/^[0-9a-f]{64}$/);
        const one = await (0, supertest_1.default)(app.getHttpServer())
            .get(`${base}/chatwoot/instances/acct1`)
            .set('X-API-Key', key)
            .expect(200);
        expect(one.body.secret).toBe('***');
    });
    it('reveals ONLY the ingress secret + verifyToken on create — nested secret config stays masked', async () => {
        const create = await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/chatwoot/instances`)
            .set('X-API-Key', key)
            .send({
            instanceId: 'nested1',
            verifyToken: 'vt-plain-123',
            config: {
                baseUrl: 'https://chatwoot.example',
                credentials: { apiToken: 'tok-e2e-live', region: 'us' },
            },
        })
            .expect(201);
        const body = create.body;
        // The two documented "revealed once" fields are plaintext...
        expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
        expect(body.verifyToken).toBe('vt-plain-123');
        // ...while a secret-flagged config field is masked even on this reveal response, at any depth.
        expect(body.config?.baseUrl).toBe('https://chatwoot.example');
        expect(body.config?.credentials?.apiToken).toBe('***');
        expect(body.config?.credentials?.region).toBe('us');
        expect(JSON.stringify(body)).not.toContain('tok-e2e-live');
        const one = await (0, supertest_1.default)(app.getHttpServer())
            .get(`${base}/chatwoot/instances/nested1`)
            .set('X-API-Key', key)
            .expect(200);
        const read = one.body;
        expect(read.secret).toBe('***');
        expect(read.verifyToken).toBe('***');
        expect(read.config?.credentials?.apiToken).toBe('***');
        expect(read.config?.baseUrl).toBe('https://chatwoot.example');
    });
    it('keeps nested secret config masked on the regenerate-secret reveal', async () => {
        const regen = await (0, supertest_1.default)(app.getHttpServer())
            .post(`${base}/chatwoot/instances/nested1/regenerate-secret`)
            .set('X-API-Key', key)
            .expect(200);
        const body = regen.body;
        expect(body.secret).toMatch(/^[0-9a-f]{64}$/);
        expect(body.verifyToken).toBe('vt-plain-123');
        expect(body.config?.credentials?.apiToken).toBe('***');
        expect(JSON.stringify(body)).not.toContain('tok-e2e-live');
    });
    it('patches enabled + sessionScope and returns a masked view', async () => {
        const patched = await (0, supertest_1.default)(app.getHttpServer())
            .patch(`${base}/chatwoot/instances/acct1`)
            .set('X-API-Key', key)
            .send({ enabled: false, sessionScope: 'sess-2' })
            .expect(200);
        const body = patched.body;
        expect(body.enabled).toBe(false);
        expect(body.sessionScope).toBe('sess-2');
        expect(body.secret).toBe('***');
    });
    it('404s GET/PATCH/DELETE for a missing instanceId on an ingress-capable plugin', async () => {
        await (0, supertest_1.default)(app.getHttpServer())
            .get(`${base}/chatwoot/instances/does-not-exist`)
            .set('X-API-Key', key)
            .expect(404);
        await (0, supertest_1.default)(app.getHttpServer())
            .patch(`${base}/chatwoot/instances/does-not-exist`)
            .set('X-API-Key', key)
            .send({ enabled: false })
            .expect(404);
        await (0, supertest_1.default)(app.getHttpServer())
            .delete(`${base}/chatwoot/instances/does-not-exist`)
            .set('X-API-Key', key)
            .expect(404);
    });
    it('deletes the instance (204) and audits it', async () => {
        await (0, supertest_1.default)(app.getHttpServer()).delete(`${base}/chatwoot/instances/acct1`).set('X-API-Key', key).expect(204);
        await (0, supertest_1.default)(app.getHttpServer()).get(`${base}/chatwoot/instances/acct1`).set('X-API-Key', key).expect(404);
        // The audit write is fire-and-forget, so poll briefly for the row.
        const auditRepo = app.get((0, typeorm_1.getRepositoryToken)(audit_log_entity_1.AuditLog, 'main'));
        let row;
        for (let i = 0; i < 50 && !row; i++) {
            const rows = await auditRepo.find({ where: { action: audit_log_entity_1.AuditAction.INTEGRATION_INSTANCE_DELETED } });
            row = rows.find(r => r.metadata?.pluginId === 'chatwoot' && r.metadata?.instanceId === 'acct1');
            if (!row)
                await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(row?.metadata).toEqual({ pluginId: 'chatwoot', instanceId: 'acct1' });
    });
    /**
     * sessionScope travels in the request body / persisted row, which the ApiKeyGuard's route-param
     * fence never sees — so the controllers themselves confine a session-scoped ADMIN key to
     * instances bound inside its allowedSessions. Out-of-scope instances must look exactly like
     * missing ones (404), and an all-sessions (omitted) scope must be uncreatable/unreachable.
     */
    describe('session-scoped API key fence', () => {
        let scopedKey; // ADMIN, allowedSessions: ['sess-1']
        beforeAll(async () => {
            const authService = app.get(auth_service_1.AuthService);
            scopedKey = (await authService.createApiKey({ name: 'e2e-scoped-int', role: api_key_entity_1.ApiKeyRole.ADMIN, allowedSessions: ['sess-1'] })).rawKey;
            // Fixtures created with the unrestricted key: one instance inside the fence, one outside, one global.
            const mk = (instanceId, body) => (0, supertest_1.default)(app.getHttpServer())
                .post(`${base}/chatwoot/instances`)
                .set('X-API-Key', key)
                .send({ instanceId, ...body });
            await mk('own1', { sessionScope: 'sess-1' }).expect(201);
            await mk('other1', { sessionScope: 'sess-2' }).expect(201);
            await mk('global1', {}).expect(201);
        });
        it('allows creating an instance bound to its own session', async () => {
            await (0, supertest_1.default)(app.getHttpServer())
                .post(`${base}/chatwoot/instances`)
                .set('X-API-Key', scopedKey)
                .send({ instanceId: 'own2', sessionScope: 'sess-1' })
                .expect(201);
        });
        it('rejects create with a sessionScope outside the fence — or omitted (all sessions)', async () => {
            await (0, supertest_1.default)(app.getHttpServer())
                .post(`${base}/chatwoot/instances`)
                .set('X-API-Key', scopedKey)
                .send({ instanceId: 'x1', sessionScope: 'sess-2' })
                .expect(403);
            await (0, supertest_1.default)(app.getHttpServer())
                .post(`${base}/chatwoot/instances`)
                .set('X-API-Key', scopedKey)
                .send({ instanceId: 'x2' })
                .expect(403);
        });
        it('lists only instances bound inside the fence', async () => {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .get(`${base}/chatwoot/instances`)
                .set('X-API-Key', scopedKey)
                .expect(200);
            const ids = res.body.map(i => i.instanceId);
            expect(ids).toContain('own1');
            expect(ids).toContain('own2');
            expect(ids).not.toContain('other1');
            expect(ids).not.toContain('global1');
        });
        it('answers 404 on getOne/regenerate/delete for instances outside the fence', async () => {
            await (0, supertest_1.default)(app.getHttpServer())
                .get(`${base}/chatwoot/instances/other1`)
                .set('X-API-Key', scopedKey)
                .expect(404);
            await (0, supertest_1.default)(app.getHttpServer())
                .get(`${base}/chatwoot/instances/global1`)
                .set('X-API-Key', scopedKey)
                .expect(404);
            await (0, supertest_1.default)(app.getHttpServer())
                .post(`${base}/chatwoot/instances/other1/regenerate-secret`)
                .set('X-API-Key', scopedKey)
                .expect(404);
            await (0, supertest_1.default)(app.getHttpServer())
                .delete(`${base}/chatwoot/instances/other1`)
                .set('X-API-Key', scopedKey)
                .expect(404);
        });
        it('answers 404 when patching an out-of-scope instance, 403 when moving an in-scope one out', async () => {
            await (0, supertest_1.default)(app.getHttpServer())
                .patch(`${base}/chatwoot/instances/other1`)
                .set('X-API-Key', scopedKey)
                .send({ enabled: false })
                .expect(404);
            await (0, supertest_1.default)(app.getHttpServer())
                .patch(`${base}/chatwoot/instances/own1`)
                .set('X-API-Key', scopedKey)
                .send({ sessionScope: 'sess-2' })
                .expect(403);
            // …while an in-scope patch that leaves sessionScope alone still works.
            await (0, supertest_1.default)(app.getHttpServer())
                .patch(`${base}/chatwoot/instances/own1`)
                .set('X-API-Key', scopedKey)
                .send({ enabled: false })
                .expect(200);
        });
        it('answers 404 when redriving an out-of-scope instance, but redrives its own', async () => {
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/integration/instances/chatwoot/other1/redrive')
                .set('X-API-Key', scopedKey)
                .expect(404);
            // own1 was disabled above; dispatch refuses a disabled instance, so the redrive is refused too.
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/integration/instances/chatwoot/own1/redrive')
                .set('X-API-Key', scopedKey)
                .expect(409);
            await (0, supertest_1.default)(app.getHttpServer())
                .patch(`${base}/chatwoot/instances/own1`)
                .set('X-API-Key', scopedKey)
                .send({ enabled: true })
                .expect(200);
            await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/integration/instances/chatwoot/own1/redrive')
                .set('X-API-Key', scopedKey)
                .expect(201);
        });
    });
    /**
     * redrive session-provenance regression: the controller authorizes a scoped key against the
     * instance's CURRENT sessionScope, but the DLQ also retains rows written under PRIOR bindings.
     * After a rebind sess-old -> sess-current, a key scoped to sess-current would otherwise replay
     * the historical sess-old row. The redrive must filter the DLQ by the authorized current binding
     * (provenance), not just by {pluginId, instanceId}.
     */
    describe('redrive session provenance (rebind replay fence)', () => {
        let scopedCurrentKey; // ADMIN, allowedSessions: ['sess-current']
        let failures;
        let oldRowId;
        let currentRowId;
        beforeAll(async () => {
            const authService = app.get(auth_service_1.AuthService);
            scopedCurrentKey = (await authService.createApiKey({
                name: 'e2e-redrive-sess-current',
                role: api_key_entity_1.ApiKeyRole.ADMIN,
                allowedSessions: ['sess-current'],
            })).rawKey;
            failures = app.get((0, typeorm_1.getRepositoryToken)(integration_delivery_failure_entity_1.IntegrationDeliveryFailure, 'data'));
            // 1. Create the instance bound to sess-old with the unrestricted key.
            await (0, supertest_1.default)(app.getHttpServer())
                .post(`${base}/chatwoot/instances`)
                .set('X-API-Key', key)
                .send({ instanceId: 'rebound-redrive', sessionScope: 'sess-old' })
                .expect(201);
            // 2. Seed a non-redriven inbound DLQ row carrying the OLD binding's sessionId (the historical
            //    payload that must NOT be replayable by a sess-current key after the rebind).
            const oldRow = await failures.save(failures.create({
                direction: 'inbound',
                pluginId: 'chatwoot',
                instanceId: 'rebound-redrive',
                sessionId: 'sess-old',
                deliveryId: 'dlv-old',
                attempts: 1,
                lastError: 'inline dispatch failed',
                payload: {
                    route: 'chatwoot',
                    method: 'POST',
                    ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
                },
                redriven: false,
            }));
            oldRowId = oldRow.id;
            // 3. Rebind the instance to sess-current (the new authorized binding).
            await (0, supertest_1.default)(app.getHttpServer())
                .patch(`${base}/chatwoot/instances/rebound-redrive`)
                .set('X-API-Key', key)
                .send({ sessionScope: 'sess-current' })
                .expect(200);
            // 4. Seed a second non-redriven inbound DLQ row carrying the CURRENT binding's sessionId —
            //    this is the only row a sess-current key should be able to replay.
            const currentRow = await failures.save(failures.create({
                direction: 'inbound',
                pluginId: 'chatwoot',
                instanceId: 'rebound-redrive',
                sessionId: 'sess-current',
                deliveryId: 'dlv-current',
                attempts: 0,
                lastError: 'inline dispatch failed',
                payload: {
                    route: 'chatwoot',
                    method: 'POST',
                    ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' },
                },
                redriven: false,
            }));
            currentRowId = currentRow.id;
        });
        it('redrives only the current-binding DLQ row, never the historical sess-old one', async () => {
            // 5. POST redrive as a key scoped to sess-current (the instance's current binding).
            dispatchWebhookForInstance.mockClear();
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/integration/instances/chatwoot/rebound-redrive/redrive')
                .set('X-API-Key', scopedCurrentKey)
                // 6. Exactly one row (the sess-current one) is redriven; the sess-old row neither consumes
                //    the batch nor leaks through `remaining`.
                .expect(201)
                .then(r => r.body);
            expect(res).toEqual({ redriven: 1, remaining: 0, batchSize: 100 });
            // 7. Only the current delivery was dispatched inline; the historical sess-old row was not.
            expect(dispatchWebhookForInstance).toHaveBeenCalledTimes(1);
            expect(dispatchWebhookForInstance).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'dlv-current' }));
            expect(dispatchWebhookForInstance).not.toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'dlv-old' }));
            // Re-read both rows: the current one is retired, the sess-old one stays redrivable (unchanged).
            const [currentAfter, oldAfter] = await Promise.all([
                failures.findOneByOrFail({ id: currentRowId }),
                failures.findOneByOrFail({ id: oldRowId }),
            ]);
            expect(currentAfter.redriven).toBe(true);
            expect(oldAfter.redriven).toBe(false);
        });
    });
});
