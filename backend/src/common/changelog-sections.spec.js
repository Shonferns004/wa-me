"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * A branch written while `[Unreleased]` had no `### Fixed` section adds one. By the time it merges,
 * another branch has usually added that section already — and git merges the two without a conflict,
 * leaving the release with two `### Fixed` blocks separated by whatever came between them.
 *
 * Nothing caught it: Prettier is happy, and the only other CHANGELOG check asserts a version heading
 * exists. It reaches further than the file, because `release.yml` cuts release notes by slicing
 * between `## [` markers, so the duplicate ships verbatim into the published GitHub Release.
 */
describe('CHANGELOG release sections', () => {
    const changelog = (0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '..', '..', 'CHANGELOG.md'), 'utf8');
    /** Split into `## [version]` blocks, each mapped to the `### Section` headings it contains. */
    const releases = () => {
        const blocks = new Map();
        let current = null;
        for (const line of changelog.split('\n')) {
            const release = line.match(/^## \[([^\]]+)\]/);
            if (release) {
                current = release[1];
                blocks.set(current, []);
                continue;
            }
            const section = line.match(/^### (.+)$/);
            if (section && current)
                blocks.get(current)?.push(section[1]);
        }
        return blocks;
    };
    it('gives every release at most one heading of each kind', () => {
        const blocks = releases();
        // Guard the parser: a changelog that suddenly scanned to nothing would pass vacuously.
        expect(blocks.size).toBeGreaterThan(10);
        const duplicated = [...blocks.entries()].flatMap(([version, sections]) => sections
            .filter((section, index) => sections.indexOf(section) !== index)
            .map(section => `${version} -> ${section}`));
        expect(duplicated).toEqual([]);
    });
});
