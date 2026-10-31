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
const wwebjs_backport_check_1 = require("./wwebjs-backport-check");
// The patcher is a CommonJS build script; its site list is what a finished backport is measured against.
const { REQUIRED_SITES,
// eslint-disable-next-line @typescript-eslint/no-require-imports
 } = require('../../../scripts/patch-wwebjs-201832');
/**
 * Guards the startup diagnostic for an unpatched whatsapp-web.js (#889). The cost of getting this
 * wrong runs both ways: a missed detection restores the silence the check exists to break, and a
 * false alarm sends operators after a patch they do not need.
 */
describe('isBackportMissing', () => {
    const tmpDirs = [];
    /** A whatsapp-web.js install stubbed down to the one file the check reads. */
    function install(messageJs) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-check-'));
        tmpDirs.push(dir);
        fs.mkdirSync(path.join(dir, 'src', 'structures'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'src', 'structures', 'Message.js'), messageJs);
        return dir;
    }
    afterAll(() => {
        for (const dir of tmpDirs)
            fs.rmSync(dir, { recursive: true, force: true });
    });
    it('flags a tree that still reads the pre-rename id', () => {
        expect((0, wwebjs_backport_check_1.isBackportMissing)(install('this.id = data.id;'))).toBe(true);
    });
    it('accepts the shape our patcher lands', () => {
        expect((0, wwebjs_backport_check_1.isBackportMissing)(install('this.id = Base._normalizeId(data.id);'))).toBe(false);
    });
    it('accepts an upstream fix that inlines the $1 fallback instead', () => {
        // The check must stand down for any fix, not just ours — otherwise the first upstream release
        // that lands this differently makes every healthy install log a phantom error.
        expect((0, wwebjs_backport_check_1.isBackportMissing)(install('this.id = data.id._serialized || data.id.$1;'))).toBe(false);
    });
    it('stays quiet about an install it cannot inspect', () => {
        expect((0, wwebjs_backport_check_1.isBackportMissing)(path.join(os.tmpdir(), 'wwjs-not-installed-here'))).toBe(false);
    });
    /** An install the backport finished: every site carries the text its marker looks for. */
    function wholeInstall() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wwjs-check-'));
        tmpDirs.push(dir);
        for (const [rel, marker] of REQUIRED_SITES) {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), marker.source.replace(/\\(.)/g, '$1'));
        }
        return dir;
    }
    // The patcher writes file by file, so a run killed part-way (out of memory, Ctrl-C, a full disk) leaves
    // Message.js patched and the rest not. The patcher itself refuses that tree, and every later start of it
    // would otherwise read as healthy.
    describe('a backport that was begun and not finished', () => {
        it('is not reported for a tree the patcher finished', () => {
            const dir = wholeInstall();
            expect((0, wwebjs_backport_check_1.isBackportMissing)(dir)).toBe(false);
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).toEqual([]);
            expect((0, wwebjs_backport_check_1.backportProblem)(dir)).toBeUndefined();
        });
        it('names the sites the patcher did not reach', () => {
            const dir = wholeInstall();
            fs.writeFileSync(path.join(dir, 'src', 'util', 'Injected', 'Utils.js'), '_serialized: msg.id._serialized');
            fs.writeFileSync(path.join(dir, 'src', 'Client.js'), 'res.gid._serialized');
            expect((0, wwebjs_backport_check_1.isBackportMissing)(dir)).toBe(false);
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).toEqual(['src/util/Injected/Utils.js', 'src/Client.js']);
            expect((0, wwebjs_backport_check_1.backportProblem)(dir)).toContain('src/util/Injected/Utils.js, src/Client.js');
        });
        it('answers a tree with no backport at all with the missing-backport message, not a list of sites', () => {
            const dir = wholeInstall();
            for (const [rel] of REQUIRED_SITES)
                fs.writeFileSync(path.join(dir, rel), 'this.id = data.id;');
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).toEqual([]);
            expect((0, wwebjs_backport_check_1.backportProblem)(dir)).toBe(wwebjs_backport_check_1.BACKPORT_MISSING_MESSAGE);
        });
        // Message.js is the 10th of 11 files the patcher writes, so a run that was killed usually stopped
        // before it: nine sites landed, Message.js did not, and the tree is not a pristine one.
        it('names a tree whose run stopped before Message.js, not the missing-backport message', () => {
            const dir = wholeInstall();
            fs.writeFileSync(path.join(dir, 'src', 'structures', 'Message.js'), 'this.id = data.id;');
            fs.writeFileSync(path.join(dir, 'src', 'util', 'Injected', 'Utils.js'), '_serialized: msg.id._serialized');
            expect((0, wwebjs_backport_check_1.isBackportMissing)(dir)).toBe(true);
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).toEqual(['src/structures/Message.js', 'src/util/Injected/Utils.js']);
            expect((0, wwebjs_backport_check_1.backportProblem)(dir)).toContain('src/structures/Message.js, src/util/Injected/Utils.js');
        });
        // src/Client.js is the first file written, so a run killed right after it leaves every structure file
        // unpatched: the tree is not a pristine one, and the answer is the list, not "run the patcher".
        it('names a tree where only the first file the patcher writes landed', () => {
            const dir = wholeInstall();
            for (const [rel] of REQUIRED_SITES) {
                if (rel !== 'src/Client.js')
                    fs.writeFileSync(path.join(dir, rel), 'this.id = data.id;');
            }
            expect((0, wwebjs_backport_check_1.isBackportMissing)(dir)).toBe(true);
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).toHaveLength(REQUIRED_SITES.length - 1);
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).not.toContain('src/Client.js');
            expect((0, wwebjs_backport_check_1.backportProblem)(dir)).toContain('src/structures/Message.js');
            expect((0, wwebjs_backport_check_1.backportProblem)(dir)).not.toBe(wwebjs_backport_check_1.BACKPORT_MISSING_MESSAGE);
        });
        it('leaves a tree fixed upstream in its own way alone', () => {
            const dir = install('this.id = data.id._serialized || data.id.$1;');
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).toEqual([]);
            expect((0, wwebjs_backport_check_1.backportProblem)(dir)).toBeUndefined();
        });
        it('does not count a site whose file is not there', () => {
            const dir = wholeInstall();
            fs.rmSync(path.join(dir, 'src', 'structures', 'GroupChat.js'));
            fs.writeFileSync(path.join(dir, 'src', 'structures', 'Chat.js'), 'this.id = data.id;');
            expect((0, wwebjs_backport_check_1.partialBackportSites)(dir)).toEqual(['src/structures/Chat.js']);
        });
    });
    it('can reach the file it reads in a real install', () => {
        // The no-argument path fails open, so a resolution that silently stopped working — an `exports`
        // map on a future whatsapp-web.js would do it — would retire the check without failing anything.
        const installed = path.dirname(require.resolve('whatsapp-web.js/package.json'));
        expect(fs.existsSync(path.join(installed, 'src', 'structures', 'Message.js'))).toBe(true);
    });
});
