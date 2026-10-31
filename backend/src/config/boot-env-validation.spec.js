"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
/**
 * Boots the real entry point with an invalid environment on the built-in PostgreSQL path, the one
 * that does Docker I/O before NestFactory.create. The config must be rejected once, before any of
 * that runs, instead of starting the container and then failing inside the module graph.
 */
describe('main.ts validates the environment before any boot side effect', () => {
    const REPO = (0, node_path_1.join)(__dirname, '..', '..');
    let cwd;
    beforeAll(() => {
        cwd = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'openwa-boot-env-'));
    });
    afterAll(() => (0, node_fs_1.rmSync)(cwd, { recursive: true, force: true }));
    it('exits 1 with one fatal line and never reaches DockerService', () => {
        const result = (0, node_child_process_1.spawnSync)(process.execPath, [(0, node_path_1.join)(REPO, 'src', 'main.js')], {
            cwd,
            encoding: 'utf8',
            timeout: 60_000,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                LOG_LEVEL: 'bogus',
                DATABASE_TYPE: 'postgres',
                POSTGRES_BUILTIN: 'true',
                DATABASE_HOST: 'db',
                DATABASE_USERNAME: 'u',
                DATABASE_PASSWORD: 'p',
                DOCKER_HOST: 'tcp://127.0.0.1:1',
            },
        });
        const output = `${result.stdout}${result.stderr}`;
        expect(result.status).toBe(1);
        expect(output).toContain('Fatal error during bootstrap');
        expect(output).toContain('LOG_LEVEL must be one of');
        expect(output).not.toContain('Unhandled promise rejection');
        expect(output).not.toContain('DockerService');
        expect(output.match(/LOG_LEVEL must be one of/g)).toHaveLength(1);
    }, 90_000);
});
/**
 * The production secret guard only checks what main.ts hands it, and every field of SecretCheckEnv is optional, so a
 * field that is declared but not passed, or read from the wrong variable, leaves its check dead without any error:
 * the guard simply never sees the value. TypeScript cannot tell, so the call is read as source.
 */
describe('main.ts hands the production secret guard every value it checks', () => {
    const read = (file) => (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '..', file), 'utf8');
    // The fields whose variable is not the field name in upper snake case.
    const VARIABLES = {
        postgresBuiltIn: 'POSTGRES_BUILTIN',
        minioBuiltIn: 'MINIO_BUILTIN',
        s3AccessKey: 'S3_ACCESS_KEY_ID',
        s3SecretKey: 'S3_SECRET_ACCESS_KEY',
    };
    const variableOf = (field) => VARIABLES[field] ?? field.replace(/([a-z\d])([A-Z])/g, '$1_$2').toUpperCase();
    const declared = [
        ...(/export interface SecretCheckEnv \{([\s\S]*?)\n\}/.exec(read('config/bootstrap-security.js'))?.[1] ?? '').matchAll(/^ {2}(\w+)\?:/gm),
    ].map(match => match[1]);
    const passed = /assertNoDefaultSecretsInProduction\(\{([\s\S]*?)\n {2}\}\);/.exec(read('main.js'))?.[1] ?? '';
    it('finds the fields the guard declares and the call that fills them', () => {
        expect(declared).toEqual(expect.arrayContaining(['nodeEnv', 'databasePassword', 'apiMasterKey', 'redisPassword']));
        expect(passed).toContain('nodeEnv: process.env.NODE_ENV');
    });
    // A field is passed when its line is the field's variable, alone or in a `||` chain of variables. A mention in a
    // comment, or in a condition or a constant, does not count: the guard would receive something else.
    const withoutComments = (source) => source.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '').replace(/[ \t]+$/gm, '');
    const isWired = (call, field) => new RegExp(`^ {4}${field}: (?:process\\.env\\.\\w+ \\|\\| )*process\\.env\\.${variableOf(field)}(?: \\|\\| process\\.env\\.\\w+)*,$`, 'm').test(withoutComments(call));
    it('passes every declared field, each read from its own environment variable', () => {
        const unwired = declared.filter(field => !isWired(passed, field));
        expect(unwired).toEqual([]);
    });
    describe('what counts as passing a field', () => {
        const call = (line) => `\n    nodeEnv: process.env.NODE_ENV,\n${line}\n    redisPassword: process.env.REDIS_PASSWORD,\n`;
        it.each([
            ['from its variable', '    metricsToken: process.env.METRICS_TOKEN,'],
            ['from its variable with a comment after it', '    metricsToken: process.env.METRICS_TOKEN, // the scrape token'],
            [
                'from its variable after a comment line',
                '    // the scrape token\n    metricsToken: process.env.METRICS_TOKEN,',
            ],
            [
                'from a legacy variable and then its own',
                '    metricsToken: process.env.OLD_TOKEN || process.env.METRICS_TOKEN,',
            ],
            [
                'from its own variable and then a legacy one',
                '    metricsToken: process.env.METRICS_TOKEN || process.env.OLD_TOKEN,',
            ],
        ])('accepts a field passed %s', (_name, line) => {
            expect(isWired(call(line), 'metricsToken')).toBe(true);
        });
        it.each([
            ['a constant with the variable in a line comment', '    metricsToken: undefined, // process.env.METRICS_TOKEN'],
            [
                'a constant with the variable in a block comment',
                '    metricsToken: undefined /* was process.env.METRICS_TOKEN */,',
            ],
            [
                'a condition that only mentions the variable',
                '    metricsToken: ready ? process.env.METRICS_TOKEN : undefined,',
            ],
            [
                'a condition whose last branch is the variable',
                '    metricsToken: ready ? undefined : process.env.METRICS_TOKEN,',
            ],
            ['another variable whose name starts with it', '    metricsToken: process.env.METRICS_TOKEN_FILE,'],
            ['a variable of another field', '    metricsToken: process.env.REDIS_PASSWORD,'],
            ['a call that no longer has the field', '    // metricsToken: process.env.METRICS_TOKEN,'],
        ])('rejects a field passed as %s', (_name, line) => {
            expect(isWired(call(line), 'metricsToken')).toBe(false);
        });
    });
});
