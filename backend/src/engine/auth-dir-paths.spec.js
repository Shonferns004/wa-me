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
const auth_dir_paths_1 = require("./auth-dir-paths");
const baileys_adapter_1 = require("./adapters/baileys.adapter");
const whatsapp_web_js_adapter_1 = require("./adapters/whatsapp-web-js.adapter");
// #1597: the engine auth directories are keyed by Session.id. Every writer of those paths has to
// agree, so each is asserted against the shared builders rather than a hand-written string.
describe('engine auth directory paths', () => {
    const SESSION_ID = '8f5b1d9e-0c4a-4e21-9d6b-2a7c3f0e1b44';
    it('the baileys adapter stores credentials at the id-keyed path', () => {
        const adapter = new baileys_adapter_1.BaileysAdapter({
            sessionId: SESSION_ID,
            dbSessionId: SESSION_ID,
            authDir: './data/baileys',
        });
        expect(adapter.authPath).toBe((0, auth_dir_paths_1.baileysAuthDir)('./data/baileys', SESSION_ID));
    });
    it('the whatsapp-web.js adapter removes the id-keyed LocalAuth profile', async () => {
        // force:true makes an unstubbed rm silent, so it is stubbed: the assertion is the path, not the
        // removal (covered in whatsapp-web-js.adapter.spec).
        const rm = jest.spyOn(fs.promises, 'rm').mockResolvedValue(undefined);
        try {
            const adapter = new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({
                sessionId: SESSION_ID,
                sessionDataPath: './data/sessions',
                puppeteer: {},
            });
            await adapter.clearLocalAuth.call(adapter);
            expect(rm).toHaveBeenCalledWith((0, auth_dir_paths_1.wwjsAuthDir)('./data/sessions', SESSION_ID), expect.anything());
        }
        finally {
            rm.mockRestore();
        }
    });
    it('resolves the whatsapp-web.js base but leaves the baileys one as configured, as the adapters do', () => {
        expect((0, auth_dir_paths_1.wwjsAuthDir)('./data/sessions', SESSION_ID)).toBe(path.join(path.resolve('./data/sessions'), `session-${SESSION_ID}`));
        expect((0, auth_dir_paths_1.baileysAuthDir)('./data/baileys', SESSION_ID)).toBe(path.join('./data/baileys', SESSION_ID));
    });
    describe('readAuthDirEntries', () => {
        let tmpRoot;
        beforeEach(() => {
            tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-dir-entries-'));
        });
        afterEach(() => {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        });
        it('lists directories and symlinked directories, not plain files', () => {
            fs.mkdirSync(path.join(tmpRoot, 'base', 'session-alice'), { recursive: true });
            fs.mkdirSync(path.join(tmpRoot, 'elsewhere', 'profile'), { recursive: true });
            fs.writeFileSync(path.join(tmpRoot, 'base', 'notes.txt'), 'x');
            // An operator who moved a large profile off the data volume: the link is what the adapter
            // opens, so it has to count as an auth directory.
            fs.symlinkSync(path.join(tmpRoot, 'elsewhere', 'profile'), path.join(tmpRoot, 'base', 'session-bob'));
            expect((0, auth_dir_paths_1.readAuthDirEntries)(path.join(tmpRoot, 'base'))).toEqual(new Set(['session-alice', 'session-bob']));
        });
        it('throws ENOENT for a missing base directory, so a caller can tell it from a failure', () => {
            expect(() => (0, auth_dir_paths_1.readAuthDirEntries)(path.join(tmpRoot, 'absent'))).toThrow(/ENOENT/);
        });
    });
});
