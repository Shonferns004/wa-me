"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * The Quick Rollback script in docs/14 copies the host `.env` and `docker-compose.yml` back from its
 * backup directory. An archive from `scripts/backup.sh` carries neither, so the TIP that sends such an
 * archive to the restore runbook must not promise the same files as that script.
 */
describe('docs/14 rollback TIP', () => {
    const root = (0, node_path_1.join)(__dirname, '..', '..');
    const read = (path) => (0, node_fs_1.readFileSync)((0, node_path_1.join)(root, path), 'utf8');
    it('does not claim the archive restores the host .env or compose file', () => {
        const staged = [...read('scripts/backup.sh').matchAll(/"\$STAGE\/([^"]+)"/g)].map(match => match[1]);
        expect(staged).toContain('main.sqlite');
        expect(staged).not.toContain('.env');
        expect(staged).not.toContain('docker-compose.yml');
        const guide = read('docs/14-migration-guide.md');
        const start = guide.indexOf('> For an archive produced by `scripts/backup.sh`');
        expect(start).toBeGreaterThan(-1);
        const tip = guide.slice(start, guide.indexOf('\n\n', start)).replace(/\n> /g, ' ');
        expect(tip).not.toMatch(/same files/);
        expect(tip).toMatch(/not the host `\.env` or compose file/);
    });
});
