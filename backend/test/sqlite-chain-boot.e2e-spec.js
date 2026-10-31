"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// Boots the production SQLite schema path from scratch: BOTH connections run their full migration
// chains (migrationsRun) against empty temp files, exactly as a fresh bare-metal/container deploy
// would, then asserts the app reaches readiness and the chain-built schema answers real queries.
// The rest of the e2e lane boots with synchronize=true (setup-e2e.ts), so this path - the one
// production takes on a default deploy - was never exercised end to end.
process.env.NODE_ENV = 'test';
process.env.DATABASE_TYPE = 'sqlite';
process.env.QUEUE_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
process.env.RATE_LIMIT_SHORT_LIMIT = '100000';
process.env.RATE_LIMIT_MEDIUM_LIMIT = '100000';
process.env.RATE_LIMIT_LONG_LIMIT = '100000';
process.env.DATABASE_SYNCHRONIZE = 'false';
// The main connection already runs its chain when the env is absent; 'false' is set explicitly so a
// value leaking in from the shell cannot boot main through synchronize. BOTH chains must run.
process.env.MAIN_DATABASE_SYNCHRONIZE = 'false';
// Fresh throwaway files per run; the chain must CREATE everything that exists in them.
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const dataDb = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-chain-${process.pid}.sqlite`);
const mainDb = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-chain-main-${process.pid}.sqlite`);
const keyFile = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-chain-key-${process.pid}`);
for (const f of [dataDb, mainDb, keyFile])
    (0, fs_1.rmSync)(f, { force: true });
process.env.DATABASE_NAME = dataDb;
process.env.MAIN_DATABASE_NAME = mainDb;
process.env.BOOTSTRAP_KEY_FILE = keyFile;
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const app_module_1 = require("../src/app.module");
const app_validation_1 = require("../src/config/app-validation");
describe('production SQLite schema path: full migration chain from scratch (e2e)', () => {
    let app;
    beforeAll(async () => {
        const moduleRef = await testing_1.Test.createTestingModule({ imports: [app_module_1.AppModule] }).compile();
        app = moduleRef.createNestApplication();
        (0, app_validation_1.applyGlobalValidation)(app);
        await app.init();
    });
    afterAll(async () => {
        try {
            await app.close();
        }
        finally {
            for (const f of [dataDb, mainDb, keyFile])
                (0, fs_1.rmSync)(f, { force: true });
        }
    });
    it('boots to readiness against chain-built schema (both connections, no synchronize)', async () => {
        const res = await (0, supertest_1.default)(app.getHttpServer()).get('/api/health/ready').expect(200);
        expect(res.body.status).toBe('ok');
    });
    it('the chain-built main schema answers auth queries (first-boot key written and usable)', async () => {
        // The bootstrap key file is written on first boot; reading it back proves the main connection's
        // migrations created api_keys and the boot path could persist.
        expect((0, fs_1.existsSync)(keyFile)).toBe(true);
        const key = (0, fs_1.readFileSync)(keyFile, 'utf8').trim();
        expect(key).toMatch(/^owa_k1_/);
        const auth = await (0, supertest_1.default)(app.getHttpServer()).get('/api/sessions').set('X-API-Key', key).expect(200);
        expect(Array.isArray(auth.body)).toBe(true);
    });
    it('the chain-built data schema accepts writes (a session row round-trips)', async () => {
        const key = (0, fs_1.readFileSync)(keyFile, 'utf8').trim();
        const created = await (0, supertest_1.default)(app.getHttpServer())
            .post('/api/sessions')
            .set('X-API-Key', key)
            .send({ name: 'chain-boot-probe' })
            .expect(201);
        expect(created.body.name).toBe('chain-boot-probe');
        const list = await (0, supertest_1.default)(app.getHttpServer()).get('/api/sessions').set('X-API-Key', key).expect(200);
        expect((list.body ?? []).some(s => s.name === 'chain-boot-probe')).toBe(true);
    });
});
