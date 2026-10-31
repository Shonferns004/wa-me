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
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const fs = __importStar(require("fs"));
const secret_file_1 = require("./secret-file");
// A named import of chmodSync cannot be spied on after the fact, so route it through a mock that
// defaults to the real call.
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return { ...actual, chmodSync: jest.fn(actual.chmodSync) };
});
describe('writeSecretFile', () => {
    let dir;
    beforeEach(() => {
        dir = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'owa-secret-'));
    });
    afterEach(() => {
        (0, fs_1.rmSync)(dir, { recursive: true, force: true });
    });
    const mode = (p) => (0, fs_1.statSync)(p).mode & 0o777;
    const expectOwnerOnly = (p) => {
        expect((0, fs_1.existsSync)(p)).toBe(true);
        if (process.platform !== 'win32') {
            expect(mode(p) & 0o077).toBe(0);
        }
    };
    it('writes a new secret file owner-only (no group/other access)', () => {
        const p = (0, path_1.join)(dir, 'secret');
        (0, secret_file_1.writeSecretFile)(p, 'topsecret');
        expectOwnerOnly(p);
        expect((0, fs_1.readFileSync)(p, 'utf8')).toBe('topsecret');
    });
    it('tightens an already-existing world-readable file (writeFileSync mode only applies on create)', () => {
        const p = (0, path_1.join)(dir, 'legacy');
        (0, fs_1.writeFileSync)(p, 'old', { mode: 0o644 });
        if (process.platform !== 'win32') {
            expect(mode(p) & 0o077).not.toBe(0); // precondition: loose
        }
        (0, secret_file_1.writeSecretFile)(p, 'new');
        expectOwnerOnly(p);
        expect((0, fs_1.readFileSync)(p, 'utf8')).toBe('new');
    });
    it('does not warn when the file simply does not exist yet (create-mode covers it)', () => {
        const p = (0, path_1.join)(dir, 'fresh');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        (0, secret_file_1.writeSecretFile)(p, 'secret');
        expect(warnSpy).not.toHaveBeenCalled();
        expect((0, fs_1.readFileSync)(p, 'utf8')).toBe('secret');
        warnSpy.mockRestore();
    });
    it('warns to the console when a chmod fails for any other reason (does not stay silently world-readable)', () => {
        const p = (0, path_1.join)(dir, 'nochmod');
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.mocked(fs.chmodSync).mockImplementation(() => {
            throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        });
        // The write still succeeds (create-mode), and both failures are surfaced instead of swallowed.
        (0, secret_file_1.writeSecretFile)(p, 'secret');
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pre-write chmod 0o600 failed'));
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('post-write chmod 0o600 failed'));
        expect((0, fs_1.readFileSync)(p, 'utf8')).toBe('secret');
        jest.mocked(fs.chmodSync).mockImplementation(jest.requireActual('fs').chmodSync);
        warnSpy.mockRestore();
    });
});
