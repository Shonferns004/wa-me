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
// The fs namespace object is frozen, so chmodSync cannot be spyOn'd; wrap it in a mock that
// delegates to the real implementation unless a test overrides one call.
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return { ...actual, chmodSync: jest.fn(actual.chmodSync) };
});
const fs = __importStar(require("fs"));
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const sqlite_file_permissions_1 = require("./sqlite-file-permissions");
const modeOf = (path) => (0, fs_1.statSync)(path).mode & 0o777;
describe('tightenSqliteFilePermissions', () => {
    let dir;
    beforeEach(() => {
        dir = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'owa-sqlite-perm-'));
    });
    afterEach(() => {
        (0, fs_1.chmodSync)(dir, 0o755); // a 0o500 test dir must still be cleanable
        (0, fs_1.rmSync)(dir, { recursive: true, force: true });
    });
    it('tightens an existing database file and its WAL/journal sidecars to owner-only', () => {
        const db = (0, path_1.join)(dir, 'openwa.sqlite');
        (0, fs_1.writeFileSync)(db, '', { mode: 0o644 });
        (0, fs_1.writeFileSync)(`${db}-wal`, '', { mode: 0o644 });
        (0, fs_1.writeFileSync)(`${db}-shm`, '', { mode: 0o644 });
        (0, fs_1.writeFileSync)(`${db}-journal`, '', { mode: 0o644 });
        const tightened = (0, sqlite_file_permissions_1.tightenSqliteFilePermissions)([db], () => undefined);
        expect(tightened).toEqual([db, `${db}-wal`, `${db}-shm`, `${db}-journal`]);
        for (const path of tightened)
            expect(modeOf(path)).toBe(0o600);
    });
    it('skips files that do not exist without touching anything', () => {
        expect((0, sqlite_file_permissions_1.tightenSqliteFilePermissions)([(0, path_1.join)(dir, 'absent.sqlite')], () => undefined)).toEqual([]);
        expect((0, fs_1.existsSync)((0, path_1.join)(dir, 'absent.sqlite'))).toBe(false);
    });
    it('is best-effort: an untightenable file warns and does not throw', () => {
        const db = (0, path_1.join)(dir, 'main.sqlite');
        (0, fs_1.writeFileSync)(db, '', { mode: 0o644 });
        fs.chmodSync.mockImplementationOnce(() => {
            throw new Error('EPERM: operation not permitted');
        });
        const warnings = [];
        expect(() => (0, sqlite_file_permissions_1.tightenSqliteFilePermissions)([db], m => warnings.push(m))).not.toThrow();
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('main.sqlite');
        expect(warnings[0]).toContain('EPERM');
    });
});
describe('SqlitePermissionsBoot', () => {
    let dir;
    beforeEach(() => {
        dir = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'owa-sqlite-boot-'));
    });
    afterEach(() => {
        (0, fs_1.rmSync)(dir, { recursive: true, force: true });
    });
    const configReturning = (values) => ({ get: (key, defaultValue) => values[key] ?? defaultValue });
    it('tightens both bundled files when the data connection is SQLite', () => {
        const main = (0, path_1.join)(dir, 'main.sqlite');
        const data = (0, path_1.join)(dir, 'openwa.sqlite');
        (0, fs_1.writeFileSync)(main, '', { mode: 0o644 });
        (0, fs_1.writeFileSync)(data, '', { mode: 0o644 });
        const boot = new sqlite_file_permissions_1.SqlitePermissionsBoot(configReturning({ 'database.database': main, 'dataDatabase.type': 'sqlite', 'dataDatabase.database': data }));
        boot.onApplicationBootstrap();
        expect(modeOf(main)).toBe(0o600);
        expect(modeOf(data)).toBe(0o600);
    });
    it('skips the data file when the data connection is Postgres (no local file to tighten)', () => {
        const main = (0, path_1.join)(dir, 'main.sqlite');
        const data = (0, path_1.join)(dir, 'should-not-be-touched.sqlite');
        (0, fs_1.writeFileSync)(main, '', { mode: 0o644 });
        (0, fs_1.writeFileSync)(data, '', { mode: 0o644 });
        const boot = new sqlite_file_permissions_1.SqlitePermissionsBoot(configReturning({ 'database.database': main, 'dataDatabase.type': 'postgres', 'dataDatabase.database': data }));
        boot.onApplicationBootstrap();
        expect(modeOf(main)).toBe(0o600);
        expect(modeOf(data)).toBe(0o644);
    });
    it('falls back to the documented default paths when config supplies none', () => {
        const boot = new sqlite_file_permissions_1.SqlitePermissionsBoot(configReturning({}));
        // Must not throw even when neither default file exists (e.g. a fresh checkout before first boot).
        expect(() => boot.onApplicationBootstrap()).not.toThrow();
    });
});
