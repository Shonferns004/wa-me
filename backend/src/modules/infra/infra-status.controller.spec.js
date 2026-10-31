"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        writeFileSync: jest.fn(),
        // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
        // so the secret-hygiene path never touches the real filesystem.
        chmodSync: jest.fn(),
        existsSync: jest.fn().mockReturnValue(false),
        readFileSync: jest.fn().mockReturnValue(''),
        createReadStream: jest.fn(() => jest.requireActual('stream').Readable.from([])),
    };
});
const infra_status_controller_1 = require("./infra-status.controller");
const infra_config_controller_1 = require("./infra-config.controller");
const env_precedence_1 = require("../../config/env-precedence");
const redis_connection_1 = require("../queue/redis-connection");
const fs = __importStar(require("fs"));
const builtin_mode_cases_1 = require("../../../test/fixtures/builtin-mode-cases");
describe('InfraStatusController.getStatus DB health (active SELECT 1 probe, not just isInitialized)', () => {
    const build = (query) => {
        // engine.type=baileys skips the wa-web-version registry fetch (no network in unit tests).
        const config = { get: (k, def) => (k === 'engine.type' ? 'baileys' : def) };
        const ds = { isInitialized: true, query };
        const cache = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
        return new infra_status_controller_1.InfraStatusController(config, ds, ds, { create: jest.fn() }, { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() }, cache, { refreshS3Availability: jest.fn() }, undefined);
    };
    it('reports connected:true when SELECT 1 succeeds', async () => {
        const status = await build(jest.fn().mockResolvedValue([{ '1': 1 }])).getStatus();
        expect(status.database.connected).toBe(true);
    });
    it('reports connected:false when the DB is initialized but SELECT 1 fails (backend died post-init)', async () => {
        const status = await build(jest.fn().mockRejectedValue(new Error('ECONNRESET'))).getStatus();
        expect(status.database.connected).toBe(false);
    });
});
describe('InfraStatusController.getStatus queue job counts', () => {
    function buildStatusController(opts) {
        const configService = {
            // engine.type=baileys skips the wa-web-version registry fetch (no network in unit tests).
            get: (key, def) => key === 'queue.enabled' ? opts.queueEnabled : key === 'engine.type' ? 'baileys' : def,
        };
        const dataSource = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
        const engineFactory = { create: jest.fn() };
        const dockerService = { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() };
        const cacheService = { isAvailable: jest.fn().mockResolvedValue(false), refreshS3Availability: jest.fn() };
        const storageService = { refreshS3Availability: jest.fn() };
        return new infra_status_controller_1.InfraStatusController(configService, dataSource, dataSource, engineFactory, dockerService, cacheService, storageService, (opts.queue && { waitUntilReady: jest.fn().mockResolvedValue(undefined), ...opts.queue }));
    }
    it('reports live webhook job counts when the queue is enabled (pending = wait+active+delayed)', async () => {
        const getJobCounts = jest.fn().mockResolvedValue({ wait: 2, active: 1, delayed: 3, completed: 10, failed: 1 });
        const controller = buildStatusController({ queueEnabled: true, queue: { getJobCounts } });
        const status = await controller.getStatus();
        expect(getJobCounts).toHaveBeenCalledWith('wait', 'active', 'delayed', 'completed', 'failed');
        expect(status.queue).toEqual({ enabled: true, webhooks: { pending: 6, completed: 10, failed: 1 } });
    });
    // Until the first connect BullMQ holds a queue call for as long as Redis stays unreachable.
    it('reports zeros once the connect timeout passes when Redis has never connected', async () => {
        const getJobCounts = jest.fn();
        const waitUntilReady = jest.fn(() => new Promise(() => { }));
        const controller = buildStatusController({ queueEnabled: true, queue: { getJobCounts, waitUntilReady } });
        let status;
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
        try {
            void controller.getStatus().then(s => (status = s));
            await jest.advanceTimersByTimeAsync((0, redis_connection_1.producerConnectWaitMs)());
        }
        finally {
            jest.useRealTimers();
        }
        expect(getJobCounts).not.toHaveBeenCalled();
        expect(status?.queue).toEqual({ enabled: true, webhooks: { pending: 0, completed: 0, failed: 0 } });
    });
    it('reports zeros (and does not touch the queue) when the queue is disabled', async () => {
        const getJobCounts = jest.fn();
        const controller = buildStatusController({ queueEnabled: false, queue: { getJobCounts } });
        const status = await controller.getStatus();
        expect(getJobCounts).not.toHaveBeenCalled();
        expect(status.queue).toEqual({ enabled: false, webhooks: { pending: 0, completed: 0, failed: 0 } });
    });
});
describe('InfraStatusController.getStatus engine (reads the real engine.puppeteer.* keys)', () => {
    // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
    const savedWebVer = process.env.WWEBJS_WEB_VERSION;
    beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
    afterAll(() => {
        if (savedWebVer === undefined)
            delete process.env.WWEBJS_WEB_VERSION;
        else
            process.env.WWEBJS_WEB_VERSION = savedWebVer;
    });
    it('reports the saved headless/browserArgs instead of stale defaults from non-existent flat keys', async () => {
        const map = {
            'engine.type': 'whatsapp-web.js',
            'engine.puppeteer.headless': false,
            'engine.puppeteer.args': ['--foo', '--bar'],
            'engine.sessionDataPath': './sess',
        };
        const config = { get: (key, def) => (key in map ? map[key] : def) };
        const cache = { isAvailable: () => Promise.resolve(false) };
        const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
        const controller = new infra_status_controller_1.InfraStatusController(config, ds, ds, {}, // engineFactory
        { isDockerAvailable: () => false }, // dockerService — no Docker in unit tests
        cache, { refreshS3Availability: () => Promise.resolve(false) });
        const status = await controller.getStatus();
        expect(status.engine.headless).toBe(false);
        expect(status.engine.browserArgs).toBe('--foo --bar');
        expect(status.engine.sessionDataPath).toBe('./sess');
    });
    it('reports the default Chromium flags when no args are configured', async () => {
        const config = { get: (key, def) => (key === 'engine.type' ? 'whatsapp-web.js' : def) };
        const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
        const controller = new infra_status_controller_1.InfraStatusController(config, ds, ds, {}, { isDockerAvailable: () => false }, { isAvailable: () => Promise.resolve(false) }, { refreshS3Availability: () => Promise.resolve(false) });
        const status = await controller.getStatus();
        expect(status.engine.browserArgs).toBe('--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu');
    });
});
describe('InfraStatusController.getStatus storage (reads the real storage.localPath key)', () => {
    // Pin the WA-Web version so getStatus does not fire the wa-version registry fetch (no network in tests).
    const savedWebVer = process.env.WWEBJS_WEB_VERSION;
    beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
    afterAll(() => {
        if (savedWebVer === undefined)
            delete process.env.WWEBJS_WEB_VERSION;
        else
            process.env.WWEBJS_WEB_VERSION = savedWebVer;
    });
    const buildController = (map) => {
        const config = { get: (key, def) => (key in map ? map[key] : def) };
        const cache = { isAvailable: () => Promise.resolve(false) };
        const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
        return new infra_status_controller_1.InfraStatusController(config, ds, ds, {}, // engineFactory
        { isDockerAvailable: () => false }, // dockerService — no Docker in unit tests
        cache, { refreshS3Availability: () => Promise.resolve(false) });
    };
    it('reports the configured storage.localPath, not the ./uploads fallback', async () => {
        // The bug: status read the non-existent `storage.path` key, so it always reported the
        // `./uploads` fallback instead of the real path StorageService uses (`storage.localPath`).
        const status = await buildController({
            'storage.type': 'local',
            'storage.localPath': '/srv/openwa/media',
        }).getStatus();
        expect(status.storage.path).toBe('/srv/openwa/media');
    });
    it('falls back to ./data/media (matching StorageService) when storage.localPath is unset', async () => {
        const status = await buildController({ 'storage.type': 'local' }).getStatus();
        expect(status.storage.path).toBe('./data/media');
    });
    it('reports the bucket in S3 mode so the active backend is visible', async () => {
        const status = await buildController({ 'storage.type': 's3', 'storage.s3.bucket': 'my-openwa-bucket' }).getStatus();
        expect(status.storage.type).toBe('s3');
        expect(status.storage.bucket).toBe('my-openwa-bucket');
    });
    it('omits bucket in local mode (no fabricated field)', async () => {
        const status = await buildController({ 'storage.type': 'local' }).getStatus();
        expect(status.storage.bucket).toBeUndefined();
    });
    // The endpoint this process dials, which tells a bundled MinIO that is stopped apart from an external store.
    it('reports the endpoint in S3 mode, and only there', async () => {
        const endpoint = 'http://minio:9000';
        const s3 = await buildController({ 'storage.type': 's3', 'storage.s3.endpoint': endpoint }).getStatus();
        const local = await buildController({ 'storage.type': 'local', 'storage.s3.endpoint': endpoint }).getStatus();
        const aws = await buildController({ 'storage.type': 's3' }).getStatus();
        expect([s3.storage.endpoint, local.storage.endpoint, aws.storage.endpoint]).toEqual([
            endpoint,
            undefined,
            undefined,
        ]);
    });
});
// #1082: the Infrastructure page used to INFER an environment pin from "running != saved", which also
// describes a save that has not been restarted yet. getStatus now reports the real thing.
describe('InfraStatusController.getStatus envPinned', () => {
    const savedWebVer = process.env.WWEBJS_WEB_VERSION;
    beforeAll(() => (process.env.WWEBJS_WEB_VERSION = 'off'));
    afterAll(() => {
        if (savedWebVer === undefined)
            delete process.env.WWEBJS_WEB_VERSION;
        else
            process.env.WWEBJS_WEB_VERSION = savedWebVer;
    });
    const buildController = () => {
        const config = { get: (_key, def) => def };
        const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
        return new infra_status_controller_1.InfraStatusController(config, ds, ds, {}, { isDockerAvailable: () => false }, { isAvailable: () => Promise.resolve(false) }, { refreshS3Availability: () => Promise.resolve(false) });
    };
    it('reports only the editable selection keys a shadowing layer supplies', async () => {
        // Snapshot as load-env does: ENGINE_TYPE comes from the host/.env, REDIS_ENABLED from the file.
        (0, env_precedence_1.recordPinnedEnvKeys)({ ENGINE_TYPE: 'whatsapp-web.js', PATH: '/usr/bin' });
        const status = await buildController().getStatus();
        expect(status.envPinned).toEqual(['ENGINE_TYPE']);
        // PATH is shadowing too but has no control on the page — naming it would be noise.
        expect(status.envPinned).not.toContain('PATH');
    });
    it('reports the storage path and engine launch options the Quick Start stack pins', async () => {
        // docker-compose.dev.yml forwards these four with non-empty defaults, so a dashboard edit reverts.
        (0, env_precedence_1.recordPinnedEnvKeys)({
            SESSION_DATA_PATH: '/app/data/sessions',
            PUPPETEER_HEADLESS: 'true',
            PUPPETEER_ARGS: '--no-sandbox',
            STORAGE_LOCAL_PATH: '/app/data/media',
            PATH: '/usr/bin',
        });
        const status = await buildController().getStatus();
        expect(status.envPinned).toEqual([
            'STORAGE_LOCAL_PATH',
            'PUPPETEER_HEADLESS',
            'SESSION_DATA_PATH',
            'PUPPETEER_ARGS',
        ]);
    });
    // A pinned host decides the Use Built-in mode of its service whatever the page saves.
    it('reports the three datastore hosts when a shadowing layer supplies them', async () => {
        (0, env_precedence_1.recordPinnedEnvKeys)({
            DATABASE_HOST: 'db.example',
            REDIS_HOST: 'cache.example',
            S3_ENDPOINT: 'https://s3.example',
        });
        expect((await buildController().getStatus()).envPinned).toEqual(['DATABASE_HOST', 'REDIS_HOST', 'S3_ENDPOINT']);
    });
    it('reports a Redis TLS pin beside the built-in selection', async () => {
        (0, env_precedence_1.recordPinnedEnvKeys)({ REDIS_TLS: 'true' });
        expect((await buildController().getStatus()).envPinned).toEqual(['REDIS_TLS']);
    });
    it('reports an empty list when nothing above data/.env.generated supplies a selection key', async () => {
        (0, env_precedence_1.recordPinnedEnvKeys)({});
        expect((await buildController().getStatus()).envPinned).toEqual([]);
    });
    // A pinned key the page writes outranks the saved value at every boot, so the page must hear of each one: an
    // unreported pin under an edited field reads as a change the next boot makes (a bucket or database switch).
    it('reports every key a save from the page writes, and no other', async () => {
        (0, env_precedence_1.recordPinnedEnvKeys)({});
        const engines = { getAvailableEngines: () => [{ id: 'whatsapp-web.js' }, { id: 'baileys' }] };
        const saver = new infra_config_controller_1.InfraConfigController(engines, {}, {});
        const payloads = [
            {
                database: {
                    type: 'postgres',
                    builtIn: false,
                    host: 'db.example',
                    port: '5433',
                    username: 'app',
                    password: 'secret',
                    database: 'appdb',
                    schema: 'tenant',
                    poolSize: 20,
                    sslEnabled: true,
                    sslRejectUnauthorized: false,
                },
                redis: { enabled: true, builtIn: false, host: 'cache.example', port: '6380', password: 'secret' },
                queue: { enabled: true },
                storage: {
                    type: 's3',
                    builtIn: false,
                    s3Bucket: 'media',
                    s3Region: 'eu-west-1',
                    s3AccessKey: 'key',
                    s3SecretKey: 'secret',
                    s3Endpoint: 'https://s3.example',
                },
                engine: { type: 'baileys', headless: false, sessionDataPath: './data/s', browserArgs: '--no-sandbox' },
            },
            {
                database: { type: 'postgres', builtIn: true },
                redis: { enabled: true, builtIn: true },
                storage: { type: 's3', builtIn: true },
            },
            { database: { type: 'sqlite' }, redis: { enabled: false }, storage: { type: 'local', localPath: './data/m' } },
        ];
        const written = new Set();
        for (const payload of payloads) {
            const ctx = { updates: {}, staleKeys: new Set(), profiles: [] };
            saver.applyConfigSections(payload, {}, ctx);
            [...Object.keys(ctx.updates), ...ctx.staleKeys].forEach(key => written.add(key));
        }
        // Removing legacy aliases changes the canonical credential fields, which are the ones the form writes.
        written.delete('S3_ACCESS_KEY');
        written.delete('S3_SECRET_KEY');
        // Every compose forward is pinned beside them, so a reported key no save writes would show up too.
        (0, env_precedence_1.recordPinnedEnvKeys)(Object.fromEntries([...env_precedence_1.BLANK_SHADOWED_ENV_KEYS, ...written].map(key => [key, 'x'])));
        const reported = (await buildController().getStatus()).envPinned;
        expect([...reported].sort()).toEqual([...written].sort());
    });
});
// With Docker unreachable the status falls back to the saved flag, the environment's first. A host name proves
// nothing without a container to see (an external server may be called postgres), so a pinned bundled host must not
// read as built-in there: it would replace the stored external credentials with the bundled defaults on a save. Nor
// does a flag beside a host that does not reach the bundled container: the process dials that host.
describe('InfraStatusController.getStatus built-in fallback reads the flag only when Docker is unreachable', () => {
    // The hosts the process runs with, as configuration.ts reads them at boot.
    const build = (hosts = {}) => {
        const key = {
            'dataDatabase.host': hosts.database,
            'redis.host': hosts.redis,
            'storage.s3.endpoint': hosts.storage,
        };
        const config = { get: (k, def) => (k === 'engine.type' ? 'baileys' : (key[k] ?? def)) };
        const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
        return new infra_status_controller_1.InfraStatusController(config, ds, ds, { create: jest.fn() }, { isDockerAvailable: () => false, getRunningBuiltinServices: jest.fn() }, { isAvailable: jest.fn().mockResolvedValue(false) }, { refreshS3Availability: jest.fn() }, undefined);
    };
    const otherState = (state) => (state === 'stored-true' ? 'stored-false' : 'stored-true');
    const otherPin = (pin) => (pin === 'external' ? 'bundled' : 'external');
    let pinnedKeys = [];
    afterEach(() => {
        for (const key of pinnedKeys)
            delete process.env[key];
        pinnedKeys = [];
        (0, env_precedence_1.recordPinnedEnvKeys)({});
        fs.existsSync.mockReturnValue(false);
        fs.readFileSync.mockReturnValue('');
    });
    for (const service of builtin_mode_cases_1.SERVICE_NAMES) {
        for (const state of builtin_mode_cases_1.FILE_STATES) {
            for (const pin of builtin_mode_cases_1.PIN_STATES) {
                it(`${service}: a ${state} file with ${pin === 'none' ? 'no host pin' : `the host pinned ${pin}`}`, async () => {
                    const lines = [];
                    const pins = {};
                    const hosts = {};
                    for (const name of builtin_mode_cases_1.SERVICE_NAMES) {
                        const own = name === service;
                        lines.push(...(0, builtin_mode_cases_1.fileLines)(name, own ? state : otherState(state)));
                        const host = (0, builtin_mode_cases_1.pinnedHost)(name, own ? pin : otherPin(pin));
                        if (host !== undefined)
                            pins[builtin_mode_cases_1.SERVICES[name].host] = host;
                        hosts[name] = host ?? (0, builtin_mode_cases_1.fileHost)(name, own ? state : otherState(state));
                    }
                    (0, env_precedence_1.recordPinnedEnvKeys)(pins);
                    for (const [key, value] of Object.entries(pins))
                        process.env[key] = value;
                    pinnedKeys = Object.keys(pins);
                    fs.existsSync.mockReturnValue(true);
                    fs.readFileSync.mockReturnValue(`${lines.join('\n')}\n`);
                    const status = await build(hosts).getStatus();
                    expect(status[service].builtIn).toBe(builtin_mode_cases_1.FALLBACK_BUILT_IN[state][pin]);
                });
            }
        }
    }
    it('a flag pinned by the environment wins over the file, and a pinned host still proves nothing', async () => {
        const pins = {
            POSTGRES_BUILTIN: 'true',
            REDIS_BUILTIN: 'false',
            DATABASE_HOST: 'postgres',
            REDIS_HOST: 'redis',
            S3_ENDPOINT: 'http://minio:9000',
        };
        (0, env_precedence_1.recordPinnedEnvKeys)(pins);
        Object.assign(process.env, pins);
        pinnedKeys = Object.keys(pins);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('POSTGRES_BUILTIN=false\nREDIS_BUILTIN=true\nMINIO_BUILTIN=false\n');
        const status = await build({ database: 'postgres', redis: 'redis', storage: 'http://minio:9000' }).getStatus();
        expect([status.database.builtIn, status.redis.builtIn, status.storage.builtIn]).toEqual([true, false, false]);
    });
    // The page switched the three services to external servers beside flags the environment pins true, and the restart
    // applied it: the flags still start the containers at boot, but the process dials the external hosts.
    it('a flag pinned true beside a host that does not reach the bundled container reads as no built-in', async () => {
        const pins = { POSTGRES_BUILTIN: 'true', REDIS_BUILTIN: 'true', MINIO_BUILTIN: 'true' };
        (0, env_precedence_1.recordPinnedEnvKeys)(pins);
        Object.assign(process.env, pins);
        pinnedKeys = Object.keys(pins);
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('DATABASE_TYPE=postgres\nPOSTGRES_BUILTIN=false\nDATABASE_HOST=db.ext.example\nREDIS_ENABLED=true\n' +
            'REDIS_BUILTIN=false\nREDIS_HOST=cache.ext.example\nSTORAGE_TYPE=s3\nMINIO_BUILTIN=false\n' +
            'S3_ENDPOINT=https://s3.ext.example\n');
        const status = await build({
            database: 'db.ext.example',
            redis: 'cache.ext.example',
            storage: 'https://s3.ext.example',
        }).getStatus();
        expect([status.database.builtIn, status.redis.builtIn, status.storage.builtIn]).toEqual([false, false, false]);
    });
});
// `running` reports a bundled container OpenWA created that is up, apart from whether the service uses it: the page
// stops one whose host the environment pins elsewhere. One Docker Compose created belongs to the deployment, and one
// beside a configuration that never chose the built-in service belongs to no setup of this instance (a second
// instance on the same daemon sees the first one's containers under the same names).
describe('InfraStatusController.getStatus running bundled containers', () => {
    const FLAGS_TRUE = 'POSTGRES_BUILTIN=true\nREDIS_BUILTIN=true\nMINIO_BUILTIN=true\n';
    const withFile = (contents) => {
        fs.existsSync.mockReturnValue(contents !== null);
        fs.readFileSync.mockReturnValue(contents ?? '');
    };
    beforeEach(() => withFile(FLAGS_TRUE));
    afterEach(() => {
        withFile(null);
        (0, env_precedence_1.recordPinnedEnvKeys)({});
        for (const flag of ['POSTGRES_BUILTIN', 'REDIS_BUILTIN', 'MINIO_BUILTIN'])
            delete process.env[flag];
    });
    const build = (containers) => {
        const values = {
            'engine.type': 'baileys',
            'dataDatabase.type': 'postgres',
            'dataDatabase.host': 'db.ext.example',
            'redis.host': 'redis',
            'storage.type': 's3',
            'storage.s3.endpoint': 'https://s3.ext.example',
        };
        const config = { get: (k, def) => values[k] ?? def };
        const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
        return new infra_status_controller_1.InfraStatusController(config, ds, ds, { create: jest.fn() }, {
            isDockerAvailable: () => containers !== null,
            getRunningBuiltinServices: jest.fn().mockResolvedValue(containers),
        }, { isAvailable: jest.fn().mockResolvedValue(false) }, { refreshS3Availability: jest.fn().mockResolvedValue(true) }, undefined);
    };
    const savedRedisHost = process.env.REDIS_HOST;
    beforeEach(() => delete process.env.REDIS_HOST);
    afterAll(() => {
        if (savedRedisHost !== undefined)
            process.env.REDIS_HOST = savedRedisHost;
    });
    it('reports a container OpenWA created as running whether or not the service uses it', async () => {
        const status = await build({ database: 'openwa', cache: 'compose', storage: 'openwa' }).getStatus();
        expect([status.database.builtIn, status.database.running]).toEqual([false, true]);
        expect([status.redis.builtIn, status.redis.running]).toEqual([true, false]);
        expect([status.storage.builtIn, status.storage.running]).toEqual([false, true]);
    });
    it('reports none of the three running when Docker Compose created them', async () => {
        const status = await build({ database: 'compose', cache: 'compose', storage: 'compose' }).getStatus();
        expect([status.database.running, status.redis.running, status.storage.running]).toEqual([false, false, false]);
        expect([status.database.builtIn, status.redis.builtIn, status.storage.builtIn]).toEqual([false, true, false]);
    });
    it.each([
        ['a first-boot file', 'POSTGRES_BUILTIN=false\nREDIS_BUILTIN=false\nMINIO_BUILTIN=false\n'],
        ['no saved file', null],
    ])('reports none of the three running beside %s that never chose them', async (_label, contents) => {
        withFile(contents);
        const status = await build({ database: 'openwa', cache: 'openwa', storage: 'openwa' }).getStatus();
        expect([status.database.running, status.redis.running, status.storage.running]).toEqual([false, false, false]);
    });
    it('reads the flag the environment pins over the saved one', async () => {
        withFile('POSTGRES_BUILTIN=false\nREDIS_BUILTIN=true\nMINIO_BUILTIN=false\n');
        process.env.POSTGRES_BUILTIN = 'true';
        process.env.REDIS_BUILTIN = 'false';
        (0, env_precedence_1.recordPinnedEnvKeys)({ POSTGRES_BUILTIN: 'true', REDIS_BUILTIN: 'false' });
        const status = await build({ database: 'openwa', cache: 'openwa', storage: 'openwa' }).getStatus();
        expect([status.database.running, status.redis.running, status.storage.running]).toEqual([true, false, false]);
    });
    it('reports nothing running when no bundled container is up', async () => {
        const status = await build({ database: false, cache: false, storage: false }).getStatus();
        expect([status.database.running, status.redis.running, status.storage.running]).toEqual([false, false, false]);
    });
    // A running bundled container backs the service when its host reaches the container in any spelling.
    describe.each([
        ['database', 'dataDatabase.host', 'database'],
        ['redis', 'redis.host', 'cache'],
        ['storage', 'storage.s3.endpoint', 'storage'],
    ])('%s built-in under another spelling of its host', (service, configKey, container) => {
        const statusFor = async (host) => {
            const values = {
                'dataDatabase.type': 'postgres',
                'storage.type': 's3',
                'storage.s3.endpoint': 'https://s3.ext.example',
                [configKey]: host,
            };
            const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
            const running = { database: false, cache: false, storage: false, [container]: 'compose' };
            return new infra_status_controller_1.InfraStatusController({ get: (k, def) => values[k] ?? def }, ds, ds, { create: jest.fn() }, { isDockerAvailable: () => true, getRunningBuiltinServices: jest.fn().mockResolvedValue(running) }, { isAvailable: jest.fn().mockResolvedValue(false) }, { refreshS3Availability: jest.fn().mockResolvedValue(true) }, undefined).getStatus();
        };
        it.each([
            ...builtin_mode_cases_1.HOST_SPELLINGS[service].reach.map(host => [host, true]),
            ...builtin_mode_cases_1.HOST_SPELLINGS[service].elsewhere.filter(Boolean).map(host => [host, false]),
        ])('%j reads built-in: %s', async (host, builtIn) => {
            expect((await statusFor(host))[service].builtIn).toBe(builtIn);
        });
    });
    // Nothing can be seen or stopped then, so a reader cannot take the absence of a container for a fact.
    it('leaves running out when Docker is unreachable', async () => {
        const status = await build(null).getStatus();
        expect(['running' in status.database, 'running' in status.redis, 'running' in status.storage]).toEqual([
            false,
            false,
            false,
        ]);
    });
});
describe('InfraStatusController unavailable Docker inventory', () => {
    let previousHost;
    beforeEach(() => {
        previousHost = process.env.REDIS_HOST;
        process.env.REDIS_HOST = 'redis';
        (0, env_precedence_1.recordPinnedEnvKeys)({});
        fs.existsSync.mockReturnValue(true);
        fs.readFileSync.mockReturnValue('REDIS_BUILTIN=true\n');
    });
    afterEach(() => {
        if (previousHost === undefined)
            delete process.env.REDIS_HOST;
        else
            process.env.REDIS_HOST = previousHost;
        (0, env_precedence_1.recordPinnedEnvKeys)({});
        fs.existsSync.mockReturnValue(false);
        fs.readFileSync.mockReturnValue('');
    });
    it('distinguishes an unavailable inventory from an observed empty list and later recovery', async () => {
        const running = { database: false, cache: 'openwa', storage: false };
        const inventory = jest
            .fn()
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({
            database: false,
            cache: false,
            storage: false,
        })
            .mockResolvedValueOnce(running);
        const config = {
            get: (key, fallback) => key === 'redis.host' ? 'redis' : key === 'engine.type' ? 'baileys' : fallback,
        };
        const database = { isInitialized: true, query: jest.fn().mockResolvedValue([]) };
        const controller = new infra_status_controller_1.InfraStatusController(config, database, database, {}, { isDockerAvailable: () => true, getRunningBuiltinServices: inventory }, { isAvailable: jest.fn().mockResolvedValue(false) }, {});
        const unavailable = await controller.getStatus();
        const empty = await controller.getStatus();
        const recovered = await controller.getStatus();
        expect(unavailable.redis.builtIn).toBe(true);
        expect(unavailable.redis).not.toHaveProperty('running');
        expect(empty.redis.builtIn).toBe(false);
        expect(empty.redis.running).toBe(false);
        expect(recovered.redis.builtIn).toBe(true);
        expect(recovered.redis.running).toBe(true);
    });
});
