"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const bootstrap_key_file_1 = require("./bootstrap-key-file");
const logger = { log: jest.fn(), warn: jest.fn() };
describe('bootstrap key file', () => {
    let dir;
    const original = process.env.BOOTSTRAP_KEY_FILE;
    beforeEach(() => {
        dir = (0, fs_1.mkdtempSync)((0, path_1.join)((0, os_1.tmpdir)(), 'owa-bootkey-'));
        process.env.BOOTSTRAP_KEY_FILE = (0, path_1.join)(dir, '.api-key');
        logger.log.mockClear();
        logger.warn.mockClear();
    });
    afterEach(() => {
        if (original === undefined)
            delete process.env.BOOTSTRAP_KEY_FILE;
        else
            process.env.BOOTSTRAP_KEY_FILE = original;
        (0, fs_1.rmSync)(dir, { recursive: true, force: true });
    });
    describe('bootstrapKeyFilePath', () => {
        it('honours BOOTSTRAP_KEY_FILE', () => {
            expect((0, bootstrap_key_file_1.bootstrapKeyFilePath)()).toBe((0, path_1.join)(dir, '.api-key'));
        });
        it('falls back to data/.api-key under the working directory', () => {
            delete process.env.BOOTSTRAP_KEY_FILE;
            expect((0, bootstrap_key_file_1.bootstrapKeyFilePath)()).toBe((0, path_1.join)(process.cwd(), 'data', '.api-key'));
        });
        it('re-reads the env on every call, so a redirect set after import still takes effect', () => {
            // This is the whole point: it used to be a module const evaluated at import from process.cwd(),
            // so an e2e setup that redirects it could not — and an e2e boot rewrote the developer's file.
            const moved = (0, path_1.join)(dir, 'moved.key');
            process.env.BOOTSTRAP_KEY_FILE = moved;
            expect((0, bootstrap_key_file_1.bootstrapKeyFilePath)()).toBe(moved);
        });
    });
    describe('readBootstrapKey', () => {
        it('returns null when the file is absent', () => {
            expect((0, bootstrap_key_file_1.readBootstrapKey)(logger)).toBeNull();
        });
        it('returns null for an empty or whitespace-only file rather than a blank key', () => {
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.api-key'), '   \n');
            expect((0, bootstrap_key_file_1.readBootstrapKey)(logger)).toBeNull();
        });
        it('returns the trimmed key', () => {
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.api-key'), '  owa_k1_abc \n');
            expect((0, bootstrap_key_file_1.readBootstrapKey)(logger)).toBe('owa_k1_abc');
        });
    });
    describe('writeBootstrapKey', () => {
        it('writes to the resolved path', () => {
            (0, bootstrap_key_file_1.writeBootstrapKey)('owa_k1_written');
            expect((0, fs_1.readFileSync)((0, path_1.join)(dir, '.api-key'), 'utf-8')).toContain('owa_k1_written');
        });
    });
    describe('removeBootstrapKey', () => {
        it('removes the file and says why', () => {
            (0, fs_1.writeFileSync)((0, path_1.join)(dir, '.api-key'), 'owa_k1_abc');
            (0, bootstrap_key_file_1.removeBootstrapKey)('its key was revoked or deleted', logger);
            expect((0, fs_1.existsSync)((0, path_1.join)(dir, '.api-key'))).toBe(false);
            expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('revoked or deleted'));
        });
        it('treats an already-absent file as success, not a failure to report', () => {
            (0, bootstrap_key_file_1.removeBootstrapKey)('gone anyway', logger);
            expect(logger.warn).not.toHaveBeenCalled();
        });
    });
});
