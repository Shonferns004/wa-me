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
const env_validation_1 = require("./env.validation");
/**
 * LOG_FORMAT is read after trim and lower-casing, and anything other than json or pretty falls back to
 * the NODE_ENV default. A value the logger cannot use is named at boot together with the format that
 * is written instead; the boot itself goes on, since the gateway still logs.
 */
describe('LOG_FORMAT the logger cannot use', () => {
    let envBackup;
    const tempDirs = [];
    let written;
    const bootWith = (dotenv) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-logformat-'));
        tempDirs.push(dir);
        fs.writeFileSync(path.join(dir, '.env'), dotenv);
        fs.mkdirSync(path.join(dir, 'data'));
        fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');
        jest.spyOn(process, 'cwd').mockReturnValue(dir);
        jest.resetModules();
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('./load-env');
    };
    const warnings = () => written.filter(line => line.includes('LOG_FORMAT='));
    beforeEach(() => {
        envBackup = { ...process.env };
        for (const key of ['NODE_ENV', 'LOG_LEVEL', 'LOG_FORMAT', 'NO_COLOR', 'FORCE_COLOR'])
            delete process.env[key];
        process.env.NO_COLOR = '1';
        written = [];
        for (const method of ['log', 'warn', 'error']) {
            jest.spyOn(console, method).mockImplementation((...args) => {
                written.push(args.map(String).join(' '));
            });
        }
    });
    afterEach(() => {
        for (const key of Object.keys(process.env)) {
            if (!(key in envBackup))
                delete process.env[key];
        }
        Object.assign(process.env, envBackup);
        jest.restoreAllMocks();
        for (const dir of tempDirs.splice(0))
            fs.rmSync(dir, { recursive: true, force: true });
    });
    it('names a misspelt value and the JSON written instead in production', () => {
        bootWith('NODE_ENV=production\nLOG_FORMAT=jsn\n');
        expect(warnings()).toHaveLength(1);
        const entry = JSON.parse(warnings()[0]);
        expect(entry.level).toBe('warn');
        expect(entry.message).toBe('LOG_FORMAT="jsn" is not json or pretty; writing json, the NODE_ENV default');
    });
    it('names an unknown value and the pretty text written instead outside production', () => {
        bootWith('LOG_FORMAT=text\n');
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toContain('WARN');
        expect(warnings()[0]).toContain('LOG_FORMAT="text" is not json or pretty; writing pretty, the NODE_ENV default');
    });
    it.each(['json', 'PRETTY', ' pretty ', ''])('stays silent for LOG_FORMAT=%j, which the logger honours', value => {
        bootWith(`LOG_FORMAT=${value}\n`);
        expect(warnings()).toEqual([]);
    });
    it('reports rather than refuses: boot validation accepts the value', () => {
        expect(() => (0, env_validation_1.validateEnv)({ LOG_FORMAT: 'jsn' })).not.toThrow();
    });
});
