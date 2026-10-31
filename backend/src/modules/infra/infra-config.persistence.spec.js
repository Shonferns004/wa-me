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
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const common_1 = require("@nestjs/common");
const app_validation_1 = require("../../config/app-validation");
const env_precedence_1 = require("../../config/env-precedence");
const restart_dto_1 = require("./dto/restart.dto");
const save_config_dto_1 = require("./dto/save-config.dto");
const infra_config_controller_1 = require("./infra-config.controller");
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return { ...actual, writeFileSync: jest.fn(actual.writeFileSync), renameSync: jest.fn(actual.renameSync) };
});
const actualFs = jest.requireActual('fs');
const dotenv = jest.requireActual('dotenv');
const database = {
    DATABASE_TYPE: 'postgres',
    DATABASE_HOST: 'db.example.invalid',
    DATABASE_USERNAME: 'app',
    DATABASE_PASSWORD: 'DummyPassword123456',
};
const pinKeys = [
    'DATABASE_TYPE',
    'DATABASE_HOST',
    'DATABASE_SSL',
    'REDIS_HOST',
    'REDIS_TLS',
    'REDIS_USERNAME',
    'S3_ENDPOINT',
];
let directory;
let file;
let previous;
beforeEach(() => {
    directory = actualFs.mkdtempSync(path.join(os.tmpdir(), 'openwa-config-'));
    actualFs.mkdirSync(path.join(directory, 'data'));
    file = path.join(directory, 'data', '.env.generated');
    previous = pinKeys.map(key => [key, process.env[key]]);
    for (const key of pinKeys)
        delete process.env[key];
    (0, env_precedence_1.recordOsEnvKeys)({});
    (0, env_precedence_1.recordPinnedEnvKeys)({});
    jest.spyOn(process, 'cwd').mockReturnValue(directory);
    jest.mocked(fs.writeFileSync).mockImplementation(actualFs.writeFileSync);
    jest.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
    seed({});
});
afterEach(() => {
    for (const [key, value] of previous) {
        if (value === undefined)
            delete process.env[key];
        else
            process.env[key] = value;
    }
    (0, env_precedence_1.recordOsEnvKeys)(process.env);
    (0, env_precedence_1.recordPinnedEnvKeys)({});
    jest.restoreAllMocks();
    actualFs.rmSync(directory, { recursive: true, force: true });
});
function seed(values) {
    const config = { DATABASE_TYPE: 'sqlite', STORAGE_TYPE: 'local', ENGINE_TYPE: 'baileys', ...values };
    actualFs.writeFileSync(file, Object.entries(config)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n', { mode: 0o600 });
}
function build(available = true) {
    const stop = jest.fn().mockResolvedValue(true);
    const shutdown = jest.fn();
    return {
        stop,
        shutdown,
        controller: new infra_config_controller_1.InfraConfigController({ getAvailableEngines: () => [{ id: 'baileys' }, { id: 'whatsapp-web.js' }] }, { isDockerAvailable: () => available, stopManagedService: stop, orchestrateProfiles: jest.fn() }, { shutdown }),
    };
}
async function admitted(body, metatype) {
    return new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS).transform(body, { type: 'body', metatype });
}
async function save(body) {
    return build().controller.saveConfig(await admitted(body, save_config_dto_1.SaveConfigDto));
}
it.each([true, false])('preserves the SQLite file path with an explicit type %s', explicit => {
    seed({ DATABASE_NAME: './data/customer.sqlite' });
    const result = build().controller.saveConfig({
        database: explicit ? { type: 'sqlite' } : {},
        engine: { headless: false },
    });
    expect(result.saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_NAME).toBe('./data/customer.sqlite');
});
describe('a SQLite file path in DATABASE_NAME', () => {
    const stored = { DATABASE_NAME: './data/customer.sqlite' };
    const postgres = { database: { type: 'postgres', host: 'db.example.invalid', username: 'app' } };
    const passwordless = { ...postgres, database: { ...postgres.database, password: 'DummyPassword123456' } };
    it.each([
        ['sqlite', ''],
        ['postgres', 'appdb'],
    ])('is reported to the form as a name only under %s', (type, name) => {
        seed({ ...stored, DATABASE_TYPE: type, ...(type === 'postgres' ? { ...database, DATABASE_NAME: 'appdb' } : {}) });
        expect(build().controller.getConfig().database.database).toBe(name);
    });
    it('does not become the PostgreSQL database name on a direct switch', async () => {
        seed(stored);
        expect((await save(passwordless)).saved).toBe(true);
        expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('DATABASE_NAME');
    });
    it('does not become the PostgreSQL database name after a SQLite save', async () => {
        seed(stored);
        expect((await save({ database: { type: 'sqlite' } })).saved).toBe(true);
        expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_NAME).toBe('./data/customer.sqlite');
        expect((await save(passwordless)).saved).toBe(true);
        expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('DATABASE_NAME');
    });
});
it('drops the PostgreSQL database name when leaving PostgreSQL for SQLite', () => {
    seed({ DATABASE_TYPE: 'postgres', DATABASE_HOST: 'db.example.invalid', DATABASE_NAME: 'openwa' });
    const result = build().controller.saveConfig({ database: { type: 'sqlite' } });
    expect(result.saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('DATABASE_NAME');
});
it('preserves the old overlay after a bounded partial write failure and lets a retry succeed', async () => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    const before = actualFs.readFileSync(file);
    jest.mocked(fs.writeFileSync).mockImplementationOnce((target, data, options) => {
        actualFs.writeFileSync(target, (typeof data === 'string'
            ? Buffer.from(data)
            : Buffer.from(data.buffer, data.byteOffset, data.byteLength)).subarray(0, 64), options);
        throw Object.assign(new Error('bounded write failure'), { code: 'ENOSPC' });
    });
    expect((await save({ engine: { headless: false } })).saved).toBe(false);
    expect(actualFs.readFileSync(file)).toEqual(before);
    expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
    expect((await save({ engine: { headless: false } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
});
it('preserves the old overlay and removes staging after a replacement failure', async () => {
    const before = actualFs.readFileSync(file);
    jest.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw new Error('replacement denied');
    });
    expect((await save({ engine: { headless: false } })).saved).toBe(false);
    expect(actualFs.readFileSync(file)).toEqual(before);
    expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
});
it.each(['EBUSY', 'EXDEV', 'EACCES', 'EPERM', 'EROFS'])('writes in place when the replacement fails with %s', async (code) => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    jest.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('the file cannot be replaced'), { code });
    });
    expect((await save({ engine: { headless: false } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
    expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
});
it.each(['EACCES', 'EPERM', 'EROFS'])('writes in place when the staged file cannot be created (%s)', async (code) => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    jest.mocked(fs.writeFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error('the directory cannot be written'), { code });
    });
    expect((await save({ engine: { headless: false } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
    expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
});
it('fails the save when the in-place write fails too, leaving the old overlay', async () => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    const before = actualFs.readFileSync(file);
    jest
        .mocked(fs.writeFileSync)
        .mockImplementationOnce(() => {
        throw Object.assign(new Error('the directory cannot be written'), { code: 'EACCES' });
    })
        .mockImplementationOnce(() => {
        throw Object.assign(new Error('the file cannot be written'), { code: 'EIO' });
    });
    expect((await save({ engine: { headless: false } })).saved).toBe(false);
    expect(actualFs.readFileSync(file)).toEqual(before);
});
it('never writes in place after the staged copy ran out of space', async () => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    const before = actualFs.readFileSync(file);
    const writes = jest.mocked(fs.writeFileSync);
    writes.mockClear();
    writes.mockImplementationOnce(() => {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    expect((await save({ engine: { headless: false } })).saved).toBe(false);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(actualFs.readFileSync(file)).toEqual(before);
});
// A directory the app user cannot write that holds an overlay file it can: a real kernel refusal, not a mocked one.
(process.getuid?.() === 0 ? it.skip : it)('saves a writable overlay file inside a directory that cannot be written', async () => {
    seed({ ...database, PUPPETEER_HEADLESS: 'true' });
    actualFs.chmodSync(path.dirname(file), 0o555);
    try {
        expect((await save({ engine: { headless: false } })).saved).toBe(true);
        expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('false');
    }
    finally {
        actualFs.chmodSync(path.dirname(file), 0o755);
    }
});
describe('an overlay that is a symbolic link', () => {
    const managed = () => path.join(directory, 'managed', 'overlay.env');
    it('is written through to its target and stays a link', async () => {
        actualFs.mkdirSync(path.dirname(managed()));
        actualFs.renameSync(file, managed());
        actualFs.symlinkSync(managed(), file);
        expect((await save({ engine: { headless: false } })).saved).toBe(true);
        expect(actualFs.lstatSync(file).isSymbolicLink()).toBe(true);
        expect(dotenv.parse(actualFs.readFileSync(managed())).PUPPETEER_HEADLESS).toBe('false');
        expect(actualFs.readdirSync(path.dirname(file)).sort()).toEqual(['.env.generated']);
        expect(actualFs.readdirSync(path.dirname(managed()))).toEqual(['overlay.env']);
    });
    it('is created at its target when the link points nowhere', async () => {
        actualFs.unlinkSync(file);
        actualFs.symlinkSync(path.join(directory, 'data', 'created.env'), file);
        expect((await save({ engine: { headless: false } })).saved).toBe(true);
        expect(actualFs.lstatSync(file).isSymbolicLink()).toBe(true);
        expect(dotenv.parse(actualFs.readFileSync(path.join(directory, 'data', 'created.env'))).PUPPETEER_HEADLESS).toBe('false');
    });
});
it('creates and replaces the overlay owner-only', async () => {
    actualFs.unlinkSync(file);
    expect((await save({ engine: { headless: false } })).saved).toBe(true);
    expect((await save({ engine: { headless: true } })).saved).toBe(true);
    if (process.platform !== 'win32')
        expect(actualFs.statSync(file).mode & 0o777).toBe(0o600);
    expect(dotenv.parse(actualFs.readFileSync(file)).PUPPETEER_HEADLESS).toBe('true');
});
const invalidBootCases = [
    {
        name: 'missing PostgreSQL host and user',
        stored: {},
        pins: {},
        body: { database: { type: 'postgres', password: 'DummyPassword123456' } },
    },
    {
        name: 'a PostgreSQL bare name under a SQLite type pin',
        stored: {},
        pins: { DATABASE_TYPE: 'sqlite' },
        body: { database: { type: 'postgres', builtIn: true } },
    },
    { name: 'an exponent-form pool size', stored: database, pins: {}, body: { database: { poolSize: 1e21 } } },
    {
        name: 'a true TLS pin for bundled PostgreSQL',
        stored: { ...database, POSTGRES_BUILTIN: 'true', DATABASE_HOST: 'postgres' },
        pins: { DATABASE_SSL: 'true' },
        body: { database: { type: 'postgres', builtIn: true } },
    },
];
for (const example of invalidBootCases) {
    it(`refuses ${example.name} before persisting`, async () => {
        seed(example.stored);
        Object.assign(process.env, example.pins);
        (0, env_precedence_1.recordPinnedEnvKeys)(example.pins);
        const before = actualFs.readFileSync(file);
        const input = await admitted(example.body, save_config_dto_1.SaveConfigDto);
        expect(() => build().controller.saveConfig(input)).toThrow(common_1.BadRequestException);
        expect(actualFs.readFileSync(file)).toEqual(before);
        expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
    });
}
describe('the save refuses what the boot would refuse beside the built-in Redis and an S3 store', () => {
    const builtInRedis = { redis: { enabled: true, builtIn: true } };
    const pin = (key, value, origin) => {
        process.env[key] = value;
        (0, env_precedence_1.recordOsEnvKeys)(origin === 'host' ? { [key]: value } : {});
        (0, env_precedence_1.recordPinnedEnvKeys)({ [key]: value });
    };
    const refused = async (body, message) => {
        const before = actualFs.readFileSync(file);
        const input = await admitted(body, save_config_dto_1.SaveConfigDto);
        expect(() => build().controller.saveConfig(input)).toThrow(message);
        expect(actualFs.readFileSync(file)).toEqual(before);
        expect(actualFs.readdirSync(path.dirname(file))).toEqual(['.env.generated']);
    };
    it.each(['host', 'project file'])('refuses a true %s REDIS_TLS pin', async (origin) => {
        seed({ REDIS_ENABLED: 'true' });
        pin('REDIS_TLS', 'true', origin);
        await refused(builtInRedis, /REDIS_TLS=true cannot/);
    });
    it.each(['REDIS_ENABLED', 'QUEUE_ENABLED', 'CACHE_ENABLED'])('refuses a named REDIS_USERNAME pin for the %s consumer', async (consumer) => {
        seed({ REDIS_ENABLED: consumer === 'REDIS_ENABLED' ? 'true' : 'false', [consumer]: 'true' });
        pin('REDIS_USERNAME', 'worker', 'host');
        await refused({ redis: { enabled: consumer === 'REDIS_ENABLED', builtIn: true } }, /REDIS_USERNAME must be unset/);
    });
    it('refuses an S3 endpoint that is not an http(s) URL', async () => {
        await refused({
            storage: {
                type: 's3',
                s3Endpoint: 'minio:9000',
                s3AccessKey: 'AKIAREALKEY123456',
                s3SecretKey: 'RealSecretKey1234567890',
                s3Bucket: 'b',
            },
        }, /S3_ENDPOINT must be an absolute/);
    });
    it('still saves a switch back to local storage over a stored endpoint without a scheme', async () => {
        seed({ STORAGE_TYPE: 's3', S3_ENDPOINT: 'minio:9000' });
        expect((await save({ storage: { type: 'local' } })).saved).toBe(true);
        expect(dotenv.parse(actualFs.readFileSync(file))).not.toHaveProperty('S3_ENDPOINT');
    });
});
it('accepts a valid partial PostgreSQL change and preserves an absent pool value', async () => {
    seed({ ...database, DATABASE_POOL_SIZE: '17' });
    expect((await save({ database: { poolSize: null } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_POOL_SIZE).toBe('17');
    expect((await save({ database: { poolSize: 18 } })).saved).toBe(true);
    expect(dotenv.parse(actualFs.readFileSync(file)).DATABASE_POOL_SIZE).toBe('18');
});
const disabledServices = [
    {
        profile: 'postgres',
        stored: { ...database, POSTGRES_BUILTIN: 'true', DATABASE_HOST: 'postgres' },
        pins: { DATABASE_HOST: 'postgres' },
        body: { database: { type: 'sqlite' } },
    },
    {
        profile: 'minio',
        stored: {
            STORAGE_TYPE: 's3',
            MINIO_BUILTIN: 'true',
            S3_ENDPOINT: 'http://minio:9000',
            S3_ACCESS_KEY_ID: 'minioadmin',
            S3_SECRET_ACCESS_KEY: 'minioadmin',
        },
        pins: { S3_ENDPOINT: 'http://minio:9000' },
        body: { storage: { type: 'local' } },
    },
    {
        profile: 'redis',
        stored: {
            REDIS_ENABLED: 'true',
            REDIS_BUILTIN: 'true',
            REDIS_HOST: 'redis',
            QUEUE_ENABLED: 'false',
            CACHE_ENABLED: 'false',
        },
        pins: { REDIS_HOST: 'redis' },
        body: { redis: { enabled: false, builtIn: true } },
    },
];
for (const example of disabledServices) {
    it(`stops unused ${example.profile} despite its bundled host pin`, async () => {
        seed(example.stored);
        Object.assign(process.env, example.pins);
        (0, env_precedence_1.recordPinnedEnvKeys)(example.pins);
        expect((await save(example.body)).saved).toBe(true);
        const { controller, stop } = build();
        const input = await admitted({ profilesToRemove: [example.profile] }, restart_dto_1.RestartDto);
        expect((await controller.requestRestart(input)).profilesToRemove).toEqual([example.profile]);
        expect(stop).toHaveBeenCalledWith(example.profile);
    });
}
it.each(['QUEUE_ENABLED', 'CACHE_ENABLED'])('keeps Redis for its active %s consumer', async (consumer) => {
    seed({ REDIS_HOST: 'redis', REDIS_ENABLED: 'false', [consumer]: 'true' });
    process.env.REDIS_HOST = 'redis';
    (0, env_precedence_1.recordPinnedEnvKeys)({ REDIS_HOST: 'redis' });
    const { controller, stop } = build();
    expect((await controller.requestRestart({ profilesToRemove: ['redis'] })).profilesToRemove).toEqual([]);
    expect(stop).not.toHaveBeenCalled();
});
it('writes the same unused-profile stop to the signal-file fallback', async () => {
    process.env.DATABASE_HOST = 'OpenWA-POSTGRES.';
    (0, env_precedence_1.recordPinnedEnvKeys)({ DATABASE_HOST: process.env.DATABASE_HOST });
    const { controller, stop } = build(false);
    expect((await controller.requestRestart({ profilesToRemove: ['postgres'] })).profilesToRemove).toEqual(['postgres']);
    expect(JSON.parse(actualFs.readFileSync(path.join(directory, 'data', '.orchestration-request.json'), 'utf8')).profilesToRemove).toEqual(['postgres']);
    expect(stop).not.toHaveBeenCalled();
});
