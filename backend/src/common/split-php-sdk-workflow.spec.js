"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const js_yaml_1 = require("js-yaml");
/**
 * The job force-pushes the SDK tree to the mirror's main, which is what Packagist reads as dev-main.
 * A manual run on another ref, or a re-run of an older push after a newer SDK change was mirrored,
 * must not replace it.
 */
describe('split-php-sdk.yml', () => {
    const workflow = (0, js_yaml_1.load)((0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '..', '..', '.github', 'workflows', 'split-php-sdk.yml'), 'utf8'));
    it.each(['test', 'split'])('runs the %s job only on main', job => {
        expect(workflow.jobs[job].if).toBe("github.ref == 'refs/heads/main'");
    });
    it('pushes only after the checked-out SDK tree is compared with the one on main', () => {
        const run = workflow.jobs.split.steps?.find(step => step.name?.startsWith('Split and force-push'))?.run ?? '';
        const lines = run.split('\n').map(line => line.trim());
        const fetch = lines.findIndex(line => line.startsWith('git fetch') && line.endsWith('refs/heads/main'));
        const compare = lines.findIndex(line => line.includes('HEAD:sdk/php') && line.includes('FETCH_HEAD:sdk/php'));
        const push = lines.findIndex(line => line.includes('push --force'));
        expect(fetch).toBeGreaterThan(-1);
        expect(compare).toBeGreaterThan(fetch);
        expect(push).toBeGreaterThan(compare);
    });
});
