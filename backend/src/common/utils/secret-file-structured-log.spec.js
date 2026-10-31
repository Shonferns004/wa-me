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
const secret_file_1 = require("./secret-file");
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return { ...actual, chmodSync: jest.fn(actual.chmodSync) };
});
/**
 * A chmod failure while writing a secret file is reported in the configured log format: in production
 * that is JSON, so a log pipeline can parse and filter it like every other line.
 */
describe('writeSecretFile chmod failure report', () => {
    const envBackup = { ...process.env };
    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-secretfile-'));
        process.env.NODE_ENV = 'production';
        delete process.env.LOG_FORMAT;
    });
    afterEach(() => {
        process.env = { ...envBackup };
        jest.restoreAllMocks();
        jest.mocked(fs.chmodSync).mockImplementation(jest.requireActual('fs').chmodSync);
        fs.rmSync(dir, { recursive: true, force: true });
    });
    it('writes the warning as a JSON log line in production', () => {
        const file = path.join(dir, '.env.generated');
        fs.writeFileSync(file, 'old');
        jest.mocked(fs.chmodSync).mockImplementation(() => {
            throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        });
        const lines = [];
        for (const channel of ['log', 'warn', 'error']) {
            jest.spyOn(console, channel).mockImplementation((...args) => void lines.push(args.join(' ')));
        }
        (0, secret_file_1.writeSecretFile)(file, 'new');
        expect(fs.readFileSync(file, 'utf8')).toBe('new');
        expect(lines.length).toBeGreaterThan(0);
        const entries = lines.map(line => JSON.parse(line));
        expect(entries.map(entry => entry.level)).toEqual(['warn', 'warn']);
        expect(entries[0].message).toContain('pre-write chmod 0o600 failed');
        expect(entries[1].message).toContain('post-write chmod 0o600 failed');
    });
});
