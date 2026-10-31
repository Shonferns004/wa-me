"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * The roadmap states the range of releases already shipped in four places (the timeline section, the
 * release summary row, the released subgraph and its node). Each reads `v0.<minor>.x` and is moved by
 * hand, in the release commit of a MINOR (docs/15 section 15.7). The range must reach the minor
 * `package.json` names, which is the last release cut.
 */
const root = (0, node_path_1.join)(__dirname, '..', '..');
const read = (...parts) => (0, node_fs_1.readFileSync)((0, node_path_1.join)(root, ...parts), 'utf8');
describe('the roadmap released range', () => {
    it('reaches the minor of the version package.json names', () => {
        const { version } = JSON.parse(read('package.json'));
        const currentMinor = Number(version.split('.')[1]);
        const ranges = [...read('docs/15-project-roadmap.md').matchAll(/(?:-v|through v)0\.(\d+)\.x/g)];
        // Vacuity guard: the four places must still parse.
        expect(ranges.length).toBeGreaterThanOrEqual(4);
        expect(ranges.filter(m => Number(m[1]) < currentMinor).map(m => m[0])).toEqual([]);
    });
});
