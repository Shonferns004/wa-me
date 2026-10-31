"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
/**
 * main.ts boots on import, so its banner and advisories cannot be exercised by a unit test; lock the
 * source instead, the way load-env.spec.ts locks its import order. A raw console line bypasses
 * LOG_LEVEL and, in production, lands as plain text in an otherwise JSON log stream.
 */
describe('bootstrap logging', () => {
    it.each(['main.js', 'configure-app.js'])('%s writes through the structured logger, not console', file => {
        const source = (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, file), 'utf8');
        expect(source).not.toMatch(/\bconsole\.\w+\(/);
    });
});
describe('API_KEY_PEPPER advisory', () => {
    // A pepper set on an install with keys locks every key out, the admin key included, so the advisory
    // must not tell the operator to enable it and then re-issue keys through the API.
    it('names the lockout and the recovery instead of a re-issue', () => {
        const source = (0, fs_1.readFileSync)((0, path_1.resolve)(__dirname, 'main.js'), 'utf8');
        expect(source).not.toMatch(/re-issue keys|re-hashes keys/);
        expect(source).toContain('before the first boot');
        expect(source).toContain('until the previous pepper is restored');
    });
});
