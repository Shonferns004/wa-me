"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
/**
 * An `overrides` entry for a package nothing in the tree depends on constrains nothing, yet reads as
 * an active security pin, and the docs cite these entries as the pins in force. Every package an
 * override names must be one the lockfile actually installs.
 */
describe('package.json overrides', () => {
    const read = (file) => JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '..', '..', file), 'utf8'));
    const pkg = read('package.json');
    const lock = read('package-lock.json');
    /** Every package an override names, at any depth, without its `@<range>` selector. */
    const named = (overrides) => Object.entries(overrides).flatMap(([key, value]) => [
        ...(key === '.' ? [] : [key.replace(/(?!^)@.*$/, '')]),
        ...(typeof value === 'string' ? [] : named(value)),
    ]);
    it('names only packages the lockfile installs', () => {
        const installed = new Set(Object.keys(lock.packages).map(path => path.replace(/^.*node_modules\//, '')));
        const names = [...new Set(named(pkg.overrides ?? {}))];
        // Vacuity guard: an unparsed overrides block would pass the check below.
        expect(names.length).toBeGreaterThan(5);
        expect(names.filter(name => !installed.has(name))).toEqual([]);
    });
});
