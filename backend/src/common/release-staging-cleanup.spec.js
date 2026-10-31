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
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const yaml = __importStar(require("js-yaml"));
/**
 * GHCR deletes by version, and after a successful promote the release tags share the staging tag's
 * version. The cleanup job decides from a read of the package-versions API, which is eventually
 * consistent: a read that does not list the new release tags yet shows the staging tag alone, and
 * deleting that version unpublishes X.Y.Z, X.Y and latest together. A promote that failed partway
 * may already have attached release tags too, and the same read cannot be trusted there. So the
 * delete step runs only when promote never ran, whatever the read says.
 */
describe('release staging-tag cleanup', () => {
    const workflow = yaml.load((0, node_fs_1.readFileSync)((0, node_path_1.join)(__dirname, '..', '..', '.github', 'workflows', 'release.yml'), 'utf8'));
    const job = workflow.jobs?.['cleanup-staging'];
    it('still runs on the failure path, after promote', () => {
        expect(job?.if).toBe('always()');
        expect(job?.needs).toContain('promote');
    });
    it('skips every delete once promote ran at all', () => {
        const deleting = (job?.steps ?? []).filter(step => /-X DELETE/.test(step.run ?? ''));
        // Vacuity guard: a renamed job or a reworded command would leave nothing to check.
        expect(deleting.length).toBeGreaterThan(0);
        for (const step of deleting)
            expect(step.if).toContain("needs.promote.result == 'skipped'");
    });
    // "Re-run failed jobs" runs boot-smoke and image-scan again against the staging tag. A gate that failed
    // on a transient fault (the vulnerability database download, a QEMU timeout) could never pass on a
    // re-run once cleanup had deleted the image it pulls, and only a rebuild of everything recovered it.
    it('keeps the staging image a re-run of a failed gate pulls', () => {
        const deleting = (job?.steps ?? []).filter(step => /-X DELETE/.test(step.run ?? ''));
        expect(deleting.length).toBeGreaterThan(0);
        for (const step of deleting)
            expect(step.if).toContain("needs.docker.result != 'success'");
    });
    // Both conditions have to hold at once: an `||` between them, or a negation around them, deletes the
    // staging image on every failed gate or after a promote that ran, each of which the two checks above
    // would still pass as substrings.
    it('deletes only when promote was skipped and the build itself did not succeed', () => {
        const deleting = (job?.steps ?? []).filter(step => /-X DELETE/.test(step.run ?? ''));
        expect(deleting.length).toBeGreaterThan(0);
        for (const step of deleting) {
            expect((step.if ?? '')
                .split('&&')
                .map(term => term.trim())
                .sort()).toEqual(["needs.docker.result != 'success'", "needs.promote.result == 'skipped'"].sort());
        }
    });
});
