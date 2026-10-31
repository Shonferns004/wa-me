"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// IngressService reads these per delivery; set them before AppModule is imported anyway, since the
// ingress guard sizes its own tier from INGRESS_INSTANCE_TTL once at boot.
process.env.INGRESS_INSTANCE_LIMIT = '3';
process.env.INGRESS_INSTANCE_TTL = '60000';
const node_crypto_1 = require("node:crypto");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const testing_1 = require("@nestjs/testing");
const typeorm_1 = require("@nestjs/typeorm");
const supertest_1 = __importDefault(require("supertest"));
const express_1 = require("express");
const app_module_1 = require("./../src/app.module");
const app_validation_1 = require("./../src/config/app-validation");
const plugin_loader_service_1 = require("./../src/core/plugins/plugin-loader.service");
const plugin_instance_entity_1 = require("./../src/modules/integration/entities/plugin-instance.entity");
/**
 * Deterministic proof that the per-instance limit is enforced, that two different instances get
 * independent buckets (a noisy tenant doesn't starve its neighbor), and that only verified deliveries
 * are counted. Uses its own low INGRESS_INSTANCE_LIMIT (3) set before AppModule boots, rather than the
 * shared e2e app in integration-fabric.e2e-spec.ts, so hammering past the limit is fast and doesn't
 * perturb the golden 202/401 coverage there (which relies on the default limit of 120 never being hit).
 */
describe('Ingress per-instance fairness throttle (e2e)', () => {
    let app;
    let instanceRepo;
    const secret = (0, node_crypto_1.randomBytes)(32).toString('hex');
    const raw = (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '../src/modules/integration/__fixtures__/chatwoot-message_created.json'), 'utf8');
    const sig = 'sha256=' + (0, node_crypto_1.createHmac)('sha256', secret).update(raw).digest('hex');
    const ingressManifestRoute = {
        route: 'chatwoot',
        mode: 'async',
        verify: 'core',
        maxBodyBytes: 262144,
        signature: {
            scheme: 'hmac-sha256',
            header: 'X-Chatwoot-Signature',
            contentTemplate: '{rawBody}',
            encoding: 'hex',
            prefix: 'sha256=',
        },
        dedupHeader: 'x-chatwoot-delivery',
    };
    beforeAll(async () => {
        const moduleFixture = await testing_1.Test.createTestingModule({
            imports: [app_module_1.AppModule],
        }).compile();
        app = moduleFixture.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        app.use((0, express_1.json)({
            verify: (req, _res, buf) => {
                req.rawBody = buf;
            },
        }));
        app.use((0, express_1.urlencoded)({
            extended: true,
            verify: (req, _res, buf) => {
                req.rawBody = buf;
            },
        }));
        await app.init();
        instanceRepo = app.get((0, typeorm_1.getRepositoryToken)(plugin_instance_entity_1.PluginInstance, 'data'));
        const loader = app.get(plugin_loader_service_1.PluginLoaderService);
        const realGetPlugin = loader.getPlugin.bind(loader);
        jest.spyOn(loader, 'getPlugin').mockImplementation((pluginId) => {
            if (pluginId === 'chatwoot') {
                return { manifest: { ingress: [ingressManifestRoute] } };
            }
            return realGetPlugin(pluginId);
        });
        jest.spyOn(loader, 'dispatchWebhookForInstance').mockResolvedValue(undefined);
        for (const instanceId of ['acct1', 'acct2', 'acct3']) {
            await instanceRepo.save(instanceRepo.create({
                id: `chatwoot:${instanceId}`,
                pluginId: 'chatwoot',
                instanceId,
                secret,
                enabled: true,
                sessionScope: 'sess-1',
                verifyToken: null,
                config: null,
            }));
        }
    });
    afterAll(async () => {
        try {
            await app?.close();
        }
        catch {
            /* ignore teardown-only multi-datasource quirk */
        }
    });
    const send = (instanceId, deliveryId) => (0, supertest_1.default)(app.getHttpServer())
        .post(`/api/ingress/chatwoot/${instanceId}/chatwoot`)
        .set('X-Chatwoot-Signature', sig)
        .set('X-Chatwoot-Delivery', deliveryId)
        .set('Content-Type', 'application/json')
        .send(raw);
    it('429s the Nth+1 request within the TTL, and does not starve a different instance', async () => {
        // INGRESS_INSTANCE_LIMIT=3: the first 3 requests on acct1 succeed, the 4th is shed at the edge.
        for (let i = 0; i < 3; i++) {
            const res = await send('acct1', `acct1-${i}`);
            expect(res.status).toBe(202);
        }
        const blocked = await send('acct1', 'acct1-overflow');
        expect(blocked.status).toBe(429);
        // IngressService answers the 429 itself, through the controller's @Res(): confirm the headers and
        // the throttler's JSON body both reach the wire, not just the status code.
        expect(blocked.headers['retry-after-instance']).toBeDefined();
        // The suffixed name says WHICH bucket shed it; the plain one is the only spelling a client reads.
        expect(blocked.headers['retry-after']).toBe(blocked.headers['retry-after-instance']);
        expect(blocked.body).toMatchObject({ statusCode: 429 });
        // A different (pluginId, instanceId) shares the provider's egress IP but gets an independent
        // bucket — it must NOT be affected by acct1 having just been throttled.
        const other = await send('acct2', 'acct2-0');
        expect(other.status).toBe(202);
    });
    it('does not count unsigned requests against the instance limit', async () => {
        // More unsigned requests than INGRESS_INSTANCE_LIMIT: each is rejected on its signature, never shed.
        for (let i = 0; i < 5; i++) {
            const res = await (0, supertest_1.default)(app.getHttpServer())
                .post('/api/ingress/chatwoot/acct3/chatwoot')
                .set('X-Chatwoot-Delivery', `acct3-unsigned-${i}`)
                .set('Content-Type', 'application/json')
                .send(raw);
            expect(res.status).toBe(401);
        }
        const signed = await send('acct3', 'acct3-0');
        expect(signed.status).toBe(202);
        expect(signed.headers['x-ratelimit-remaining-instance']).toBe('2');
    });
});
