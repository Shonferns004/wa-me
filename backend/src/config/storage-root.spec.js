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
const storage_root_1 = require("./storage-root");
describe('resolveStorageRoot', () => {
    const writableAlways = () => true;
    const writableNever = () => false;
    it('returns the configured root unchanged when it is writable', () => {
        expect((0, storage_root_1.resolveStorageRoot)({ configured: './data/media', isWritable: writableAlways })).toBe('./data/media');
    });
    it('returns the default when nothing is configured', () => {
        expect((0, storage_root_1.resolveStorageRoot)({ configured: undefined, isWritable: writableAlways })).toBe(storage_root_1.DEFAULT_STORAGE_ROOT);
    });
    it('leaves a WRITABLE ./uploads alone — a healthy bare-metal install must not be relocated', () => {
        expect((0, storage_root_1.resolveStorageRoot)({ configured: './uploads', isWritable: writableAlways })).toBe('./uploads');
    });
    it('migrates an UNWRITABLE ./uploads fossil to the default and warns', () => {
        const warnings = [];
        const effective = (0, storage_root_1.resolveStorageRoot)({
            configured: './uploads',
            isWritable: (p) => p !== './uploads',
            logger: { warn: (m) => void warnings.push(m) },
        });
        expect(effective).toBe(storage_root_1.DEFAULT_STORAGE_ROOT);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('STORAGE_LOCAL_PATH');
        expect(warnings[0]).toContain('./uploads');
    });
    it('migrates the bare "uploads" spelling too — path.join normalises ./uploads to it', () => {
        expect((0, storage_root_1.resolveStorageRoot)({ configured: 'uploads', isWritable: (p) => p !== 'uploads' })).toBe(storage_root_1.DEFAULT_STORAGE_ROOT);
    });
    it('throws an actionable error naming STORAGE_LOCAL_PATH when a non-fossil root is unwritable', () => {
        expect(() => (0, storage_root_1.resolveStorageRoot)({ configured: '/mnt/readonly', isWritable: writableNever })).toThrow(/STORAGE_LOCAL_PATH/);
        expect(() => (0, storage_root_1.resolveStorageRoot)({ configured: '/mnt/readonly', isWritable: writableNever })).toThrow(/\/mnt\/readonly/);
    });
    it('throws rather than silently continuing when the fossil AND the migration target are both unwritable', () => {
        expect(() => (0, storage_root_1.resolveStorageRoot)({ configured: './uploads', isWritable: writableNever })).toThrow(/STORAGE_LOCAL_PATH/);
    });
});
describe('isStorageRootWritable', () => {
    let tmp;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openwa-storage-root-'));
    });
    afterEach(() => {
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    it('creates a missing root and reports it writable', () => {
        const root = path.join(tmp, 'media');
        expect((0, storage_root_1.isStorageRootWritable)(root)).toBe(true);
        expect(fs.existsSync(root)).toBe(true);
    });
    it('reports an EXISTING but unwritable root as not writable (the #1065 case existsSync misses)', () => {
        // Running as root bypasses permission bits entirely, so the negative case is unprovable there.
        if (typeof process.getuid === 'function' && process.getuid() === 0)
            return;
        const root = path.join(tmp, 'locked');
        fs.mkdirSync(root);
        fs.chmodSync(root, 0o555);
        try {
            expect((0, storage_root_1.isStorageRootWritable)(root)).toBe(false);
        }
        finally {
            fs.chmodSync(root, 0o755);
        }
    });
});
