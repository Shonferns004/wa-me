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
const fs = __importStar(require("fs"));
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        writeFileSync: jest.fn(),
        renameSync: jest.fn(),
        chmodSync: jest.fn(),
        existsSync: jest.fn().mockReturnValue(false),
        readFileSync: jest.fn().mockReturnValue(''),
    };
});
jest.mock('../../config/storage-root', () => {
    const actual = jest.requireActual('../../config/storage-root');
    return { ...actual, resolveStorageRoot: jest.fn((options) => options.configured ?? '') };
});
const infra_config_controller_1 = require("./infra-config.controller");
const infra_status_controller_1 = require("./infra-status.controller");
const docker_1 = require("../docker");
const env_precedence_1 = require("../../config/env-precedence");
const builtin_mode_cases_1 = require("../../../test/fixtures/builtin-mode-cases");
// Every decision that asks whether a host is the bundled container, for every spelling of the shared table, with the
// host pinned or in the saved file, beside each state of the stored flag. The expected answer comes from the table
// (reach or elsewhere), not from the rule under test, so a decision that reads a spelling differently fails here.
const PROFILE = { database: 'postgres', redis: 'redis', storage: 'minio' };
const CONTAINER = {
    database: 'database',
    redis: 'cache',
    storage: 'storage',
};
const STATUS_HOST = {
    database: 'dataDatabase.host',
    redis: 'redis.host',
    storage: 'storage.s3.endpoint',
};
// Strong credentials pinned for every case, so the production guard never decides a save here.
const SECRETS = {
    DATABASE_PASSWORD: 'PinnedPw456!',
    S3_ACCESS_KEY_ID: 'PinnedKey123456',
    S3_SECRET_ACCESS_KEY: 'PinnedSecret1234567',
};
const STORED_SECRETS = 'DATABASE_PASSWORD=StoredPw789!\nS3_ACCESS_KEY_ID=StoredKey12345\nS3_SECRET_ACCESS_KEY=StoredSecret1234567890\n';
// What an external database or bucket was saved with, beside the host of the case.
const STORED_VALUES = 'DATABASE_USERNAME=app\nDATABASE_NAME=appdb\nPOSTGRES_SCHEMA=tenant\nS3_BUCKET=media\nS3_REGION=eu-west-1\n';
// A storage endpoint that is not an absolute http(s) URL is refused by the save, so a save never reaches the
// decisions below with one; the blank spelling is no endpoint at all.
const isSavableHost = (service, host) => service !== 'storage' || host.trim() === '' || /^https?:\/\//i.test(host.trim());
const cases = builtin_mode_cases_1.SERVICE_NAMES.flatMap(service => [
    ...builtin_mode_cases_1.HOST_SPELLINGS[service].reach.map(host => ({ host, reach: true })),
    ...builtin_mode_cases_1.HOST_SPELLINGS[service].elsewhere.map(host => ({ host, reach: false })),
]
    .filter(({ host }) => isSavableHost(service, host))
    .flatMap(({ host, reach }) => ['pinned', 'file'].flatMap(position => ['true', 'false', 'absent'].map(flag => ({ service, host, reach, position, flag })))));
const label = (c) => `${c.service} ${JSON.stringify(c.host)} ${c.position}, flag ${c.flag}`;
let pinnedKeys = [];
let fileText = '';
let environment;
beforeEach(() => {
    environment = { ...process.env };
    for (const key of Object.keys(process.env)) {
        if (/^(DATABASE_|POSTGRES_|REDIS_|STORAGE_|S3_|MINIO_|QUEUE_|CACHE_|ENGINE_TYPE$)/.test(key))
            delete process.env[key];
    }
});
function arrange(c, stored = '') {
    const spec = builtin_mode_cases_1.SERVICES[c.service];
    // A pinned host must outrank the file's, so the file holds a host of the other kind.
    const fileHost = c.position === 'file' ? c.host : c.reach ? spec.externalHost : spec.bundledHost;
    // Unrelated stored database fields still belong to a complete PostgreSQL connection.
    const lines = [
        'DATABASE_TYPE=postgres',
        'DATABASE_HOST=db.external.example',
        'DATABASE_USERNAME=openwa',
        `${spec.selection}=${spec.selected}`,
        `${spec.host}=${fileHost}`,
    ];
    if (c.flag !== 'absent')
        lines.push(`${spec.flag}=${c.flag}`);
    fileText = `${lines.join('\n')}\n${STORED_SECRETS}${stored}`;
    const pins = { ...SECRETS, ...(c.position === 'pinned' ? { [spec.host]: c.host } : {}) };
    Object.assign(process.env, pins);
    pinnedKeys = Object.keys(pins);
    // Credentials are OS-supplied; the case's host pin is a project .env assignment, including a real blank.
    (0, env_precedence_1.recordOsEnvKeys)(SECRETS);
    (0, env_precedence_1.recordPinnedEnvKeys)(pins);
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue(fileText);
    fs.writeFileSync.mockClear();
}
afterEach(() => {
    for (const key of pinnedKeys)
        delete process.env[key];
    pinnedKeys = [];
    for (const key of Object.keys(process.env)) {
        if (!(key in environment))
            delete process.env[key];
    }
    Object.assign(process.env, environment);
    (0, env_precedence_1.recordOsEnvKeys)(process.env);
    (0, env_precedence_1.recordPinnedEnvKeys)({});
    fs.existsSync.mockReturnValue(false);
    fs.readFileSync.mockReturnValue('');
});
const controller = (docker = {}) => new infra_config_controller_1.InfraConfigController({}, docker, { shutdown: jest.fn() });
function saved(payload) {
    controller().saveConfig(payload);
    const text = fs.writeFileSync.mock.calls[0][1];
    return jest.requireActual('dotenv').parse(text);
}
async function restart(body) {
    const stopManagedService = jest.fn().mockResolvedValue(true);
    const result = await controller({
        isDockerAvailable: () => true,
        stopManagedService,
        orchestrateProfiles: jest.fn().mockResolvedValue({}),
    }).requestRestart(body);
    return { result, stopped: stopManagedService.mock.calls.length > 0 };
}
async function status(c, creator) {
    const values = {
        'dataDatabase.type': 'postgres',
        'storage.type': 's3',
        [STATUS_HOST[c.service]]: c.host,
    };
    const running = { database: false, cache: false, storage: false, [CONTAINER[c.service]]: creator };
    const ds = { isInitialized: true, query: jest.fn().mockResolvedValue([{ '1': 1 }]) };
    const savedRedisHost = process.env.REDIS_HOST;
    if (c.service === 'redis')
        process.env.REDIS_HOST = c.host;
    try {
        return await new infra_status_controller_1.InfraStatusController({ get: (k, def) => values[k] ?? def }, ds, ds, { create: jest.fn() }, { isDockerAvailable: () => true, getRunningBuiltinServices: jest.fn().mockResolvedValue(running) }, { isAvailable: jest.fn().mockResolvedValue(false) }, { refreshS3Availability: jest.fn().mockResolvedValue(true) }, undefined).getStatus();
    }
    finally {
        if (savedRedisHost === undefined)
            delete process.env.REDIS_HOST;
        else
            process.env.REDIS_HOST = savedRedisHost;
    }
}
describe.each(cases.map(c => [label(c), c]))('%s', (_label, c) => {
    const profile = PROFILE[c.service];
    const spec = builtin_mode_cases_1.SERVICES[c.service];
    // The host the next boot dials reaches the container exactly when this case's host does: a pinned one outranks a
    // file host of the other kind, and a file host is read as is.
    const reached = c.reach;
    const blankProjectDatabaseHost = c.service === 'database' && c.position === 'pinned' && c.host.trim() === '';
    it('may start the container unless a pin names another server', async () => {
        arrange(c);
        expect((0, docker_1.hostPinnedElsewhere)(profile)).toBe(c.position === 'pinned' && !c.reach);
        const { result } = await restart({ profiles: [profile] });
        expect(result.profiles).toEqual(c.position === 'pinned' && !c.reach ? [] : [profile]);
    });
    it('may stop the container only when the next boot does not reach it', async () => {
        arrange(c);
        const { result, stopped } = await restart({ profilesToRemove: [profile] });
        expect(stopped).toBe(!reached);
        expect(result.profilesToRemove).toEqual(reached ? [] : [profile]);
    });
    it('reads the built-in mode from the host', () => {
        arrange(c);
        const mode = controller().getConfig()[c.service];
        // A flag of true beside a file host elsewhere is a saved choice of that host: the flag only starts the container.
        const expected = c.position === 'pinned'
            ? { builtIn: c.reach, builtInSet: false }
            : c.flag !== 'true' && c.reach
                ? { builtIn: true, builtInSet: false }
                : { builtIn: c.reach, builtInSet: c.flag !== 'absent' };
        expect({ builtIn: mode.builtIn, builtInSet: mode.builtInSet }).toEqual(expected);
    });
    it("reports a running container as backing the service by the host, and as this instance's by the flag", async () => {
        arrange(c);
        const compose = await status(c, 'compose');
        expect(compose[c.service].builtIn).toBe(c.reach);
        expect(compose[c.service].running).toBe(false);
        const openwa = await status(c, 'openwa');
        expect(openwa[c.service].running).toBe(c.flag === 'true');
    });
    if (c.service !== 'redis') {
        it('keeps the stored credentials of a built-in save only when the bundled container already uses them', () => {
            arrange(c);
            const payload = c.service === 'database'
                ? { database: { type: 'postgres', builtIn: true } }
                : { storage: { type: 's3', builtIn: true } };
            if (blankProjectDatabaseHost) {
                expect(() => saved(payload)).toThrow(/DATABASE_HOST is required/);
                expect(fs.writeFileSync).not.toHaveBeenCalled();
                return;
            }
            const env = saved(payload);
            const keep = c.position === 'pinned' || reached;
            if (c.service === 'database')
                expect(env.DATABASE_PASSWORD).toBe(keep ? 'StoredPw789!' : 'openwa');
            else
                expect([env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY]).toEqual(keep ? ['StoredKey12345', 'StoredSecret1234567890'] : ['minioadmin', 'minioadmin']);
        });
    }
    if (c.service !== 'redis') {
        it('keeps the stored user, database and schema, or bucket and region, of a built-in save only when the bundled container already serves them', () => {
            arrange(c, STORED_VALUES);
            const payload = c.service === 'database'
                ? { database: { type: 'postgres', builtIn: true } }
                : { storage: { type: 's3', builtIn: true } };
            if (blankProjectDatabaseHost) {
                expect(() => saved(payload)).toThrow(/DATABASE_HOST is required/);
                expect(fs.writeFileSync).not.toHaveBeenCalled();
                return;
            }
            const env = saved(payload);
            if (c.service === 'database')
                expect([env.DATABASE_USERNAME, env.DATABASE_NAME, env.POSTGRES_SCHEMA]).toEqual(reached ? ['app', 'appdb', 'tenant'] : ['openwa', 'openwa', 'public']);
            else
                expect([env.S3_BUCKET, env.S3_REGION]).toEqual(reached ? ['media', 'eu-west-1'] : ['openwa', 'us-east-1']);
        });
    }
    it('keeps the stored mode of a section sent without its flag, and a stored built-in host with it', () => {
        arrange(c);
        const section = c.service === 'database'
            ? { database: { type: 'postgres', host: c.host, port: '5432' } }
            : c.service === 'redis'
                ? { redis: { enabled: true, host: c.host, port: '6379' }, queue: { enabled: false } }
                : { storage: { type: 's3', s3Endpoint: c.host, s3Region: 'us-east-1' } };
        if (blankProjectDatabaseHost) {
            expect(() => saved(section)).toThrow(/DATABASE_HOST is required/);
            expect(fs.writeFileSync).not.toHaveBeenCalled();
            return;
        }
        const env = saved(section);
        expect(env[spec.flag]).toBe(c.flag === 'absent' ? undefined : c.flag);
        const sentHost = c.service === 'storage' ? c.host || undefined : c.host.trim() || 'localhost';
        const storedBundled = c.position === 'pinned' ? !c.reach : c.reach;
        expect(env[spec.host]).toBe(storedBundled ? spec.bundledHost : sentHost);
    });
});
it.each(['', ' \t ', '\r'])('lets a blank OS database host %j use the valid generated host', blank => {
    arrange({ service: 'database', host: blank, reach: false, position: 'pinned', flag: 'false' });
    const hostEnvironment = { ...SECRETS, DATABASE_HOST: blank };
    (0, env_precedence_1.clearBlankEnv)(hostEnvironment, env_precedence_1.BLANK_SHADOWED_ENV_KEYS);
    delete process.env.DATABASE_HOST;
    Object.assign(process.env, hostEnvironment);
    (0, env_precedence_1.recordOsEnvKeys)(hostEnvironment);
    (0, env_precedence_1.recordPinnedEnvKeys)(hostEnvironment);
    expect((0, env_precedence_1.isEnvPinned)('DATABASE_HOST')).toBe(false);
    const env = saved({ queue: { enabled: false } });
    expect(env.DATABASE_HOST).toBe('postgres');
    expect(env.QUEUE_ENABLED).toBe('false');
});
