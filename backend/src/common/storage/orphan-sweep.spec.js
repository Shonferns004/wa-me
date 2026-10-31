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
const orphan_sweep_1 = require("./orphan-sweep");
const storage_service_1 = require("./storage.service");
describe('sweepOrphanedFiles', () => {
    const PREFIX = 'status/';
    function fixture(initial) {
        let keys = initial;
        const deleted = [];
        const deleteFile = jest.fn((key) => {
            deleted.push(key);
            return Promise.resolve();
        });
        const storage = {
            iterateFiles: async function* () {
                await Promise.resolve();
                for (const key of keys)
                    yield key;
            },
            deleteFile,
        };
        return {
            deleted,
            deleteFile,
            set: (next) => {
                keys = next;
            },
            sweep: (overrides) => (0, orphan_sweep_1.sweepOrphanedFiles)({
                storage,
                prefix: PREFIX,
                graceMs: 500,
                referencedAmong: () => Promise.resolve(new Set()),
                onDeleteFailed: jest.fn(),
                ...overrides,
            }),
        };
    }
    it('never touches a file outside the prefix it owns', async () => {
        const f = fixture(['status/a.jpg', 'chat-media/b.jpg']);
        const removed = await f.sweep({ firstSeenAt: new Map(), now: 1000, graceMs: 0 });
        expect(removed).toBe(1);
        expect(f.deleted).toEqual(['status/a.jpg']);
    });
    it('deletes an unreferenced file only after the grace window has run from its first sighting', async () => {
        const f = fixture(['status/a.jpg']);
        const firstSeenAt = new Map();
        expect(await f.sweep({ firstSeenAt, now: 1000 })).toBe(0);
        expect(firstSeenAt.get('status/a.jpg')).toBe(1000);
        expect(await f.sweep({ firstSeenAt, now: 1499 })).toBe(0);
        expect(await f.sweep({ firstSeenAt, now: 1500 })).toBe(1);
        expect(f.deleted).toEqual(['status/a.jpg']);
        expect(firstSeenAt.size).toBe(0);
    });
    it('drops the bookkeeping of a file that disappeared or became referenced between passes', async () => {
        const f = fixture(['status/gone.jpg', 'status/claimed.jpg']);
        const firstSeenAt = new Map();
        await f.sweep({ firstSeenAt, now: 1000 });
        expect([...firstSeenAt.keys()].sort()).toEqual(['status/claimed.jpg', 'status/gone.jpg']);
        f.set(['status/claimed.jpg']);
        await f.sweep({
            firstSeenAt,
            now: 1100,
            referencedAmong: () => Promise.resolve(new Set(['status/claimed.jpg'])),
        });
        expect(firstSeenAt.size).toBe(0);
    });
    it('reports a failed delete and retries the file on a later pass', async () => {
        const f = fixture(['status/a.jpg']);
        f.deleteFile.mockRejectedValueOnce(new Error('EBUSY'));
        const onDeleteFailed = jest.fn();
        const firstSeenAt = new Map();
        await f.sweep({ firstSeenAt, now: 1000, graceMs: 0, onDeleteFailed });
        expect(onDeleteFailed).toHaveBeenCalledWith('status/a.jpg', expect.any(Error));
        expect(firstSeenAt.has('status/a.jpg')).toBe(true);
        expect(await f.sweep({ firstSeenAt, now: 1001, graceMs: 0, onDeleteFailed })).toBe(1);
    });
    it('asks which keys are referenced in chunks of the size it was given', async () => {
        const f = fixture(['status/1', 'status/2', 'status/3', 'status/4', 'status/5']);
        const referencedAmong = jest.fn((keys) => {
            void keys;
            return Promise.resolve(new Set());
        });
        await f.sweep({ firstSeenAt: new Map(), now: 1000, chunkSize: 2, referencedAmong });
        expect(referencedAmong.mock.calls.map(([keys]) => keys.length)).toEqual([2, 2, 1]);
    });
});
/**
 * The export and the file count refuse a store they cannot enumerate completely, because a short archive
 * would lose media on the next backend. A sweep has no such duty: it deletes only files it saw, so a
 * subtree it cannot read is merely left alone and must not stop it from reclaiming everything else.
 */
describe('sweepOrphanedFiles over a store with a directory it cannot read', () => {
    let baseDir;
    let storage;
    beforeEach(() => {
        baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-sweep-'));
        const localPath = path.join(baseDir, 'media');
        for (const file of ['statuses/s1/orphan.bin', 'statuses/locked/hidden.bin', 'chat-media/s1/other.bin']) {
            fs.mkdirSync(path.dirname(path.join(localPath, file)), { recursive: true });
            fs.writeFileSync(path.join(localPath, file), 'x');
        }
        storage = new storage_service_1.StorageService({
            get: (key) => ({ 'storage.type': 'local', 'storage.localPath': localPath })[key],
        });
        // A mode-000 directory is still readable by root, so the failure is injected for that one path.
        const readdir = fs.promises.readdir.bind(fs.promises);
        jest
            .spyOn(fs.promises, 'readdir')
            .mockImplementation(((target, ...rest) => String(target).endsWith(path.join('statuses', 'locked'))
            ? Promise.reject(Object.assign(new Error('EACCES: permission denied, scandir'), { code: 'EACCES' }))
            : readdir(target, ...rest)));
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        storage.onModuleDestroy();
        fs.rmSync(baseDir, { recursive: true, force: true });
    });
    const sweep = (prefix) => (0, orphan_sweep_1.sweepOrphanedFiles)({
        storage,
        prefix,
        graceMs: 0,
        now: 1000,
        firstSeenAt: new Map(),
        referencedAmong: () => Promise.resolve(new Set()),
        onDeleteFailed: jest.fn(),
    });
    it('reclaims the orphans it can see and never touches the subtree it cannot', async () => {
        expect(await sweep('statuses/')).toBe(1);
        const present = (file) => fs.existsSync(path.join(baseDir, 'media', file));
        expect(present('statuses/s1/orphan.bin')).toBe(false);
        expect(present('statuses/locked/hidden.bin')).toBe(true);
        expect(present('chat-media/s1/other.bin')).toBe(true);
        const warnings = console.warn.mock.calls.map(([line]) => String(line));
        expect(warnings.some(line => line.includes('statuses/locked'))).toBe(true);
    });
    it('keeps refusing a file count of the same store', async () => {
        await expect(storage.getFileCount()).rejects.toThrow(/EACCES/);
    });
});
