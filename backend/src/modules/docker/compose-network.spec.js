"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
// js-yaml has no bundled types here; require + cast (matches the repo's plugin-loader pattern).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('js-yaml');
/**
 * Regression lock: the Docker socket proxy must live on a dedicated
 * internal network that untrusted peers cannot reach.
 */
describe('docker-compose network segmentation', () => {
    const compose = yaml.load((0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../../../docker-compose.yml'), 'utf8'));
    it('declares an internal-only network for the docker socket proxy', () => {
        expect(compose.networks['internal-docker'].internal).toBe(true);
    });
    it('puts docker-proxy ONLY on the internal network (not the shared app network)', () => {
        expect(compose.services['docker-proxy'].networks).toEqual(['internal-docker']);
    });
    it('lets openwa-api reach the proxy via the internal network', () => {
        expect(compose.services['openwa-api'].networks).toContain('internal-docker');
    });
    // Nothing in the image reads a compose file, and a short-syntax bind whose source is missing (the
    // stack started with `-f other.yml`) makes Docker create an empty host directory in its place.
    it('mounts only the data volume into openwa-api', () => {
        expect(compose.services['openwa-api'].volumes).toEqual(['openwa-data:/app/data']);
    });
});
