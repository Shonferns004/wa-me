"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const app_module_1 = require("../src/app.module");
const app_validation_1 = require("../src/config/app-validation");
const configure_app_1 = require("../src/configure-app");
const core_1 = require("@nestjs/core");
const serve_static_1 = require("@nestjs/serve-static");
const supertest_1 = __importDefault(require("supertest"));
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
/**
 * Two throwaway dashboard builds, evaluated before the module decorators (forRoot reads rootPath
 * eagerly). The second deliberately sits under a DOT-SEGMENT directory, which is not exotic:
 * `~/.openwa`, a CI checkout under `~/.cache`, and a `TMPDIR` inside a dotdir all produce it.
 * `ServeStaticModule`'s own SPA fallback silently 404s every client-side route on such a path
 * (it sends the index by absolute path, and Express's `send` refuses dot-segments), so the shape
 * has to be covered explicitly or a real deployment class goes untested.
 */
function makeBuild(root) {
    (0, fs_1.mkdirSync)((0, path_1.join)(root, 'assets'), { recursive: true });
    (0, fs_1.writeFileSync)((0, path_1.join)(root, 'index.html'), '<!doctype html><title>OpenWA Dashboard</title>');
    (0, fs_1.writeFileSync)((0, path_1.join)(root, 'assets', 'app.js'), 'console.log(1)');
    (0, fs_1.writeFileSync)((0, path_1.join)(root, '.env.secret'), 'TOKEN=nope');
    return root;
}
const hasDotSegment = (p) => p.split(path_1.sep).some(segment => segment.startsWith('.'));
const osTmp = (0, fs_1.realpathSync)((0, os_1.tmpdir)());
// The "plain" build must sit under a genuinely dot-free prefix. os.tmpdir() is NOT reliably
// dot-free, and using it blindly would make BOTH cases dotted - which is exactly how this gap
// stayed hidden. node_modules is gitignored, so nothing strays into the working tree.
const dotFreeBase = hasDotSegment(osTmp) ? (0, path_1.join)(__dirname, '..', 'node_modules') : osTmp;
const plainRoot = (0, fs_1.mkdtempSync)((0, path_1.join)(dotFreeBase, 'openwa-dash-plain-'));
const dottedRoot = (0, fs_1.mkdtempSync)((0, path_1.join)(osTmp, 'openwa-dash-'));
const plainDist = makeBuild((0, path_1.join)(plainRoot, 'dashboard', 'dist'));
const dottedDist = makeBuild((0, path_1.join)(dottedRoot, '.dotted', 'dashboard', 'dist'));
// The e2e globalTeardown sweeps only openwa-e2e-* entries in the temp dir, and the plain root can sit
// under node_modules, so this suite removes its own fixtures.
afterAll(() => {
    for (const root of [plainRoot, dottedRoot])
        (0, fs_1.rmSync)(root, { recursive: true, force: true });
});
let PingController = class PingController {
    ping() {
        return { ok: true };
    }
    echo(body) {
        return { body };
    }
    item(id) {
        return { id };
    }
};
__decorate([
    (0, common_1.Get)('ping'),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", void 0)
], PingController.prototype, "ping", null);
__decorate([
    (0, common_1.Post)('echo'),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", void 0)
], PingController.prototype, "echo", null);
__decorate([
    (0, common_1.Get)('items/:id'),
    __param(0, (0, common_1.Param)('id')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], PingController.prototype, "item", null);
PingController = __decorate([
    (0, common_1.Controller)()
], PingController);
// The options app.module.ts passes to the module, so a change there is what these tests exercise.
let PlainServeStaticModule = class PlainServeStaticModule {
};
PlainServeStaticModule = __decorate([
    (0, common_1.Module)({
        imports: [serve_static_1.ServeStaticModule.forRoot({ rootPath: plainDist, ...app_module_1.DASHBOARD_STATIC_OPTIONS })],
        controllers: [PingController],
    })
], PlainServeStaticModule);
let DottedServeStaticModule = class DottedServeStaticModule {
};
DottedServeStaticModule = __decorate([
    (0, common_1.Module)({
        imports: [serve_static_1.ServeStaticModule.forRoot({ rootPath: dottedDist, ...app_module_1.DASHBOARD_STATIC_OPTIONS })],
        controllers: [PingController],
    })
], DottedServeStaticModule);
describe('serve-static test fixtures', () => {
    it('really does cover BOTH install-path shapes', () => {
        // Without this, a dotted os.tmpdir() collapses the matrix onto one shape and the
        // dot-segment case silently stops being tested.
        expect(hasDotSegment(plainDist)).toBe(false);
        expect(hasDotSegment(dottedDist)).toBe(true);
    });
});
/**
 * Regression lock for single-port dashboard serving (app.module.ts + main.ts). Bootstraps the SAME
 * serve-static options AND the same document handler against a throwaway build: the SPA must be
 * served at `/` with client-side fallback, while Nest keeps ownership of `/api` so unknown API routes
 * return JSON 404s (not the SPA index.html) and a request the body parsers refuse keeps its own 413
 * or 400 instead of the module's `404 Cannot POST`.
 */
describe.each([
    ['a plain install path', PlainServeStaticModule, plainDist],
    ['an install path with a dot-segment', DottedServeStaticModule, dottedDist],
])('Dashboard serve-static (e2e) - %s', (_label, moduleClass, distDir) => {
    let app;
    const previousBodyLimit = process.env.BODY_SIZE_LIMIT;
    beforeAll(async () => {
        process.env.BODY_SIZE_LIMIT = '1kb';
        // The REAL production stack, pointed at this fixture build. It used to be a copy of the
        // document handler kept in this file, minus the nonce injection, so a divergence between the
        // copy and the original passed.
        app = await core_1.NestFactory.create(moduleClass, { bodyParser: false, logger: false });
        (0, configure_app_1.configureApp)(app, { dashboard: { distDir, enabled: true } });
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
    });
    afterAll(async () => {
        if (previousBodyLimit === undefined)
            delete process.env.BODY_SIZE_LIMIT;
        else
            process.env.BODY_SIZE_LIMIT = previousBodyLimit;
        await app?.close();
    });
    it('serves the dashboard index.html at /', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/html/);
        expect(res.text).toContain('OpenWA Dashboard');
    });
    it('serves index.html for client-side routes (SPA fallback)', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/sessions');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/html/);
    });
    it('serves index.html for a nested client-side route', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/sessions/abc/messages');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/html/);
    });
    it('never answers an /assets path with the SPA shell, even extensionless', async () => {
        // The handler excludes /assets/ explicitly. Every other case is already covered by the
        // extension check, so deleting the exclusion breaks nothing visible: an extensionless asset
        // path asking for HTML is the one request that tells the two apart, and without it the guard
        // is unprotected.
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/assets/app').set('Accept', 'text/html');
        expect(res.status).toBe(404);
    });
    it('serves built assets with their own content-type (not the SPA shell)', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/assets/app.js');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/javascript/);
        expect(res.text).not.toContain('OpenWA Dashboard');
    });
    it('404s a missing asset instead of handing back the SPA shell', async () => {
        // A mistyped <script src> must fail loudly. Answering 200 HTML makes the browser try to
        // parse the shell as JavaScript and report a syntax error, hiding the real cause.
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/assets/missing.js');
        expect(res.status).toBe(404);
        expect(res.text).not.toContain('OpenWA Dashboard');
    });
    it('404s a missing top-level file rather than serving the shell', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/favicon-missing.svg');
        expect(res.status).toBe(404);
    });
    it('never serves a dotfile out of the build directory', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/.env.secret');
        expect(res.status).toBe(404);
        expect(res.text).not.toContain('TOKEN=');
    });
    it('lets Nest handle /api routes (real controller, not the SPA)', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/ping');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
    it('lets Nest handle a mis-cased /api route, as routing matches it case-insensitively', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/API/ping');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
    it('returns a JSON 404 (not the SPA) for unknown /api routes', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/does-not-exist');
        expect(res.status).toBe(404);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.text).not.toContain('OpenWA Dashboard');
    });
    it('does not hand the SPA to a non-GET request', async () => {
        // A mistyped POST must fail loudly rather than receiving a 200 HTML shell.
        const res = await (0, supertest_1.default)(app.getHttpServer()).post('/sessions');
        expect(res.status).not.toBe(200);
    });
    describe('a request the body parsers refuse, under /api', () => {
        // The serve-static error handler used to rewrite each of these into `404 Cannot POST /api/echo`.
        // The oversized body stays under the in-flight budget the 1kb limit implies (4 KB), so the
        // parser answers and not the budget.
        const postJson = (body) => (0, supertest_1.default)(app.getHttpServer()).post('/api/echo').type('json').send(body);
        it('answers 413 for a body over BODY_SIZE_LIMIT', async () => {
            const res = await postJson(JSON.stringify({ text: 'x'.repeat(2048) }));
            expect(res.status).toBe(413);
        });
        it('answers 400 for malformed JSON', async () => {
            const res = await postJson('{"text":');
            expect(res.status).toBe(400);
        });
        it('answers 400 for a body nested past the bound', async () => {
            const res = await postJson(`${'['.repeat(150)}${']'.repeat(150)}`);
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ statusCode: 400, error: 'Bad Request' });
        });
        it('answers 400 for a path parameter that cannot be decoded', async () => {
            const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/items/%FF');
            expect(res.status).toBe(400);
        });
    });
});
