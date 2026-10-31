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
const load_cli_env_1 = require("./load-cli-env");
describe('loadCliEnv (migration CLI env precedence)', () => {
    let dir;
    const KEY = 'DATABASE_TYPE';
    let original;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-cli-env-'));
        fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
        original = process.env[KEY];
        delete process.env[KEY];
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        if (original === undefined)
            delete process.env[KEY];
        else
            process.env[KEY] = original;
    });
    it('reads data/.env.generated (the dashboard-written config) when the var is unset', () => {
        fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=postgres\n');
        (0, load_cli_env_1.loadCliEnv)(dir);
        // Without this load the CLI would default to sqlite and migrate the wrong database.
        expect(process.env[KEY]).toBe('postgres');
    });
    it('does not let .env.generated override an explicit process.env value (precedence holds)', () => {
        process.env[KEY] = 'postgres';
        fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');
        (0, load_cli_env_1.loadCliEnv)(dir);
        expect(process.env[KEY]).toBe('postgres');
    });
    it('lets .env win over data/.env.generated (the middle layer), matching main.ts ordering', () => {
        // Guards against a future edit that reorders the two loads or flips override — .env must win.
        fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_TYPE=postgres\n');
        fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');
        (0, load_cli_env_1.loadCliEnv)(dir);
        expect(process.env[KEY]).toBe('postgres');
    });
    // dotenv writes its "injected env" banner to stdout up to dotenv 17 and to stderr (console.error) from 18,
    // so every console channel is watched, not the one the installed version happens to use.
    it("loads both files without printing dotenv's banner", () => {
        delete process.env.DOTENV_QUIET;
        delete process.env.DOTENV_CONFIG_QUIET;
        fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_TYPE=postgres\n');
        fs.writeFileSync(path.join(dir, 'data', '.env.generated'), 'DATABASE_TYPE=sqlite\n');
        const lines = [];
        const spies = ['log', 'info', 'warn', 'error', 'debug'].map(channel => jest.spyOn(console, channel).mockImplementation((...args) => void lines.push(args.join(' '))));
        try {
            (0, load_cli_env_1.loadCliEnv)(dir);
            expect(lines).not.toContainEqual(expect.stringContaining('injected env'));
        }
        finally {
            for (const spy of spies)
                spy.mockRestore();
        }
    });
});
