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
const private_dir_util_1 = require("./private-dir.util");
// Session credential directories (whatsapp-web.js profiles, baileys creds.json) hold everything
// needed to take over the linked WhatsApp account — read access to the volume must not be enough.
// The plugin registry already writes itself owner-only (plugin-storage.service); these tests pin
// the same guarantee for dirs created on the engine path.
describe('ensurePrivateDir', () => {
    let tmpRoot;
    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'private-dir-'));
    });
    afterEach(() => {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
    it('creates a fresh nested directory with owner-only permissions (0o700)', () => {
        const dir = path.join(tmpRoot, 'baileys', 'alice');
        (0, private_dir_util_1.ensurePrivateDir)(dir);
        expect(fs.existsSync(dir)).toBe(true);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });
    it('tightens a pre-existing world-readable directory back to 0o700', () => {
        // mkdir's `mode` only applies to directories it creates; an upgraded deployment reuses the
        // session dir it already has, so the re-chmod half is what protects existing installs.
        const dir = path.join(tmpRoot, 'sessions', 'session-alice');
        fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
        (0, private_dir_util_1.ensurePrivateDir)(dir);
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    });
    it('is best-effort: an unwritable location must not throw (the engine lib owns real failures)', () => {
        const file = path.join(tmpRoot, 'blocker');
        fs.writeFileSync(file, 'not a directory');
        expect(() => (0, private_dir_util_1.ensurePrivateDir)(path.join(file, 'under-a-file'))).not.toThrow();
    });
});
