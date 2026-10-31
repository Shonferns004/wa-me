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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const engine_patch_status_1 = require("./engine-patch-status");
/**
 * Guards the startup diagnostic for engine patches that never applied. The cost runs both ways, as
 * it does for `wwebjs-backport-check.js`: a missed detection restores the silence the guard exists
 * to break, and a false alarm on every boot sends operators after patches they do not need. The
 * "cannot tell" cases below are the second half of that, and they matter more here than in the
 * single-patcher guard, because this one walks a directory and requires whatever it finds.
 */
describe('unappliedPatches', () => {
    const tmpDirs = [];
    function tmp(prefix) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
        tmpDirs.push(dir);
        return dir;
    }
    /** A scripts/ directory holding stub patchers, each written as the module the guard requires. */
    function scriptsWith(modules) {
        const dir = tmp('openwa-patch-scripts-');
        for (const [name, body] of Object.entries(modules))
            fs.writeFileSync(path.join(dir, name), body);
        return dir;
    }
    const patcher = (applied) => `module.exports = { isApplied: () => ${String(applied)} };\n`;
    afterAll(() => {
        for (const dir of tmpDirs)
            fs.rmSync(dir, { recursive: true, force: true });
    });
    it('names only the patchers whose predicate answers false', () => {
        const scripts = scriptsWith({
            'patch-wwebjs-alpha.js': patcher(true),
            'patch-wwebjs-beta.js': patcher(false),
            'patch-wwebjs-gamma.js': patcher(false),
        });
        expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-beta', 'patch-wwebjs-gamma']);
    });
    it('reports nothing when every patcher is applied', () => {
        const scripts = scriptsWith({ 'patch-wwebjs-alpha.js': patcher(true) });
        expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', scripts, tmp('dep-'))).toEqual([]);
    });
    it('keeps each family to its own patchers', () => {
        const scripts = scriptsWith({
            'patch-wwebjs-alpha.js': patcher(false),
            'patch-baileys-alpha.js': patcher(false),
        });
        expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-alpha']);
        expect((0, engine_patch_status_1.unappliedPatches)('baileys', scripts, tmp('dep-'))).toEqual(['patch-baileys-alpha']);
    });
    it('passes the resolved dependency directory to the predicate', () => {
        const dep = tmp('dep-');
        const scripts = scriptsWith({
            'patch-wwebjs-alpha.js': 'module.exports = { isApplied: dir => dir !== process.env.OPENWA_EXPECTED_DEP };\n',
        });
        process.env.OPENWA_EXPECTED_DEP = dep;
        try {
            // The predicate answers false only when it was handed exactly the directory we passed in, so
            // a guard that called isApplied() with no argument would report nothing here.
            expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', scripts, dep)).toEqual(['patch-wwebjs-alpha']);
        }
        finally {
            delete process.env.OPENWA_EXPECTED_DEP;
        }
    });
    it('ignores specs, non-patchers and anything that is not a .js file', () => {
        const scripts = scriptsWith({
            'patch-wwebjs-alpha.spec.js': patcher(false),
            'patch-wwebjs-alpha.js': patcher(true),
            'check-audit.mjs': patcher(false),
            'wwebjs-201832.patch': 'not javascript at all',
        });
        expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', scripts, tmp('dep-'))).toEqual([]);
    });
    it('skips a patcher that exports no predicate rather than reporting it', () => {
        // This is patch-wwebjs-201832.js's situation: guarded elsewhere, so it opts out by omission.
        const scripts = scriptsWith({
            'patch-wwebjs-legacy.js': 'module.exports = { applyBackport: () => undefined };\n',
            'patch-wwebjs-alpha.js': patcher(false),
        });
        expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-alpha']);
    });
    it('skips a patcher that cannot be required instead of failing the boot', () => {
        const scripts = scriptsWith({
            'patch-wwebjs-broken.js': 'this is not valid javascript {{{\n',
            'patch-wwebjs-alpha.js': patcher(false),
        });
        expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', scripts, tmp('dep-'))).toEqual(['patch-wwebjs-alpha']);
    });
    it('stays quiet when there is no scripts directory to read', () => {
        expect((0, engine_patch_status_1.unappliedPatches)('wwebjs', path.join(tmp('openwa-empty-'), 'absent'), tmp('dep-'))).toEqual([]);
    });
    it('stays quiet when the dependency cannot be resolved', () => {
        const scripts = scriptsWith({ 'patch-wwebjs-alpha.js': patcher(false) });
        // Both engines are always installed here, so the only way to reach the unresolvable branch is
        // a family with no package behind it. That stands in for the real case: an install whose
        // engine library is absent or pruned is not an install we can judge, and the patcher stubs
        // above would otherwise be reported as missing.
        expect((0, engine_patch_status_1.unappliedPatches)('absent-engine', scripts)).toEqual([]);
    });
});
describe('the patchers this repository actually ships', () => {
    const scripts = path.join(__dirname, '..', '..', '..', 'scripts');
    const shipped = fs
        .readdirSync(scripts)
        .filter(f => f.startsWith('patch-') && f.endsWith('.js') && !f.endsWith('.spec.js'))
        .sort();
    it('finds the patchers at all', () => {
        // Vacuity guard: an empty scan would make both assertions below pass without checking anything.
        expect(shipped.length).toBeGreaterThanOrEqual(9);
    });
    it('exports a predicate from every patcher except the one guarded elsewhere', () => {
        const withoutPredicate = shipped.filter(f => {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const patcher = require(path.join(scripts, f));
            return typeof patcher.isApplied !== 'function';
        });
        // patch-wwebjs-201832.js is covered by wwebjs-backport-check.ts, which has its own predicate,
        // its own message and its own docs/12 entry. It is the ONLY patcher allowed to opt out: any
        // other name here is a patcher whose failure to apply would be silent again.
        expect(withoutPredicate).toEqual(['patch-wwebjs-201832.js']);
    });
    it('names a family this guard understands in every patcher filename', () => {
        // A patcher named outside both prefixes would be silently invisible to unappliedPatches.
        const unfamiliar = shipped.filter(f => !f.startsWith('patch-wwebjs-') && !f.startsWith('patch-baileys-'));
        expect(unfamiliar).toEqual([]);
    });
});
describe('unappliedPatchesMessage', () => {
    it('names the library, the count, every patcher and a command that fixes one', () => {
        const message = (0, engine_patch_status_1.unappliedPatchesMessage)('wwebjs', ['patch-wwebjs-block', 'patch-wwebjs-status']);
        expect(message).toContain('whatsapp-web.js');
        expect(message).toContain('missing 2');
        expect(message).toContain('patch-wwebjs-block, patch-wwebjs-status');
        expect(message).toContain('node scripts/patch-wwebjs-block.js');
        expect(message).toContain('docs/12-troubleshooting-faq.md');
    });
    it('names the Baileys package for the baileys family', () => {
        expect((0, engine_patch_status_1.unappliedPatchesMessage)('baileys', ['patch-baileys-appstate'])).toContain('@whiskeysockets/baileys');
    });
});
