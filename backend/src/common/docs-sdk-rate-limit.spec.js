"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * The global rate limiter has an hourly tier (`RATE_LIMIT_LONG_TTL`, one hour by default), so its
 * 429 can last up to an hour. Every SDK README states that; one that promises the 429 clears
 * within seconds sends its readers into a retry loop against an hour-long window.
 */
describe('SDK READMEs: global rate limiter 429 duration', () => {
    const repoRoot = (0, node_path_1.join)(__dirname, '..', '..');
    const readmes = ['javascript', 'python', 'php', 'go', 'java'].map(sdk => `sdk/${sdk}/README.md`);
    it.each(readmes)('%s names the hourly tier and no seconds-only promise', path => {
        const text = (0, node_fs_1.readFileSync)((0, node_path_1.join)(repoRoot, path), 'utf8').replace(/\s+/g, ' ');
        expect(text).toContain('up to an hour for the hourly tier by default');
        expect(text).not.toMatch(/clears within seconds/);
    });
});
