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
const storage_local_files_1 = require("./storage-local-files");
describe('iterateLocalFiles', () => {
    let root;
    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-walk-'));
    });
    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const write = (file) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), 'x');
    };
    const walk = async (prefix = '', options) => {
        const files = [];
        for await (const file of (0, storage_local_files_1.iterateLocalFiles)(root, prefix, options))
            files.push(file);
        return files.sort();
    };
    /** A mode-000 directory is still readable by root, so the failure is injected for the one path. */
    const failReaddirAt = (suffix, code = 'EACCES') => {
        const error = Object.assign(new Error(`${code}: cannot read ${suffix}`), { code });
        const readdir = fs.promises.readdir.bind(fs.promises);
        jest
            .spyOn(fs.promises, 'readdir')
            .mockImplementation(((target, ...rest) => String(target).endsWith(suffix) ? Promise.reject(error) : readdir(target, ...rest)));
        return error;
    };
    const deepKey = [...Array(20).fill('d'), 'deep.bin'].join('/');
    /** Walk and return what it threw. */
    const refusal = async (prefix = '', options) => {
        const error = await walk(prefix, options).then(() => undefined, (e) => e);
        expect(error).toBeInstanceOf(storage_local_files_1.StorageWalkRefusedError);
        return error;
    };
    it('lists every file with "/" separated keys', async () => {
        write('a.bin');
        write('x/y/b.bin');
        expect(await walk()).toEqual(['a.bin', 'x/y/b.bin']);
        expect(await walk('x/')).toEqual(['x/y/b.bin']);
    });
    describe('by default', () => {
        // The message reaches the API caller, so it names the path relative to the storage root and the cause, never the
        // host path. The error the host raised, with its path, stays on `cause` for the log.
        it.each(['EACCES', 'EPERM'])('refuses a directory it cannot read (%s), naming it and the cause', async (code) => {
            write('ok.bin');
            write('locked/hidden.bin');
            const error = failReaddirAt(path.join(root, 'locked'), code);
            const refused = await refusal();
            expect(refused.message).toBe(`Storage directory cannot be read: locked (${code})`);
            expect(refused.message).not.toContain(root);
            expect(refused.name).toBe('StorageWalkRefusedError');
            expect(refused.cause).toBe(error);
        });
        it('names the storage root as "." when the root itself cannot be read', async () => {
            failReaddirAt(root, 'EACCES');
            expect((await refusal()).message).toBe('Storage directory cannot be read: . (EACCES)');
        });
        it('lets any other failure through as it came, so it stays an internal error', async () => {
            write('broken/file.bin');
            const error = failReaddirAt(path.join(root, 'broken'), 'EIO');
            await expect(walk()).rejects.toBe(error);
        });
        // mkfs leaves a root-owned lost+found (mode 0700) at the top of a volume. A store that sits on a volume of
        // its own, read by an unprivileged user, would otherwise refuse every export and count for good.
        describe('for lost+found', () => {
            const lostAndFound = 'lost+found';
            it.each(['EACCES', 'EPERM'])('skips an unreadable %s at the storage root and says so', async (code) => {
                write('ok.bin');
                write(`${lostAndFound}/recovered.bin`);
                failReaddirAt(path.join(root, lostAndFound), code);
                const log = jest.fn();
                expect(await walk('', { logger: { log, warn: jest.fn() } })).toEqual(['ok.bin']);
                expect(log).toHaveBeenCalledWith(expect.stringContaining(lostAndFound));
            });
            it('walks one it can read like any other directory', async () => {
                write(`${lostAndFound}/recovered.bin`);
                expect(await walk()).toEqual([`${lostAndFound}/recovered.bin`]);
            });
            it('still fails on one that is not at the storage root', async () => {
                write(`nested/${lostAndFound}/recovered.bin`);
                failReaddirAt(path.join(root, 'nested', lostAndFound));
                expect((await refusal()).message).toBe(`Storage directory cannot be read: nested/${lostAndFound} (EACCES)`);
            });
            it('still fails on an error that is not a permission error', async () => {
                write(`${lostAndFound}/recovered.bin`);
                const error = failReaddirAt(path.join(root, lostAndFound), 'EIO');
                await expect(walk()).rejects.toBe(error);
            });
        });
        it('refuses a directory below the maximum depth, naming it', async () => {
            write(deepKey);
            const refused = await refusal();
            expect(refused.message).toMatch(/^Storage directory exceeds the maximum traversal depth: d(\/d){19}$/);
            expect(refused.message).not.toContain(root);
        });
        // A link is neither followed (it can loop, or leave the store) nor listed, so what it points at would be
        // missing from an export or a count without a word. Refusing is the only answer that cannot lose it.
        it.each([
            ['directory', 'linked'],
            ['file', 'alias.bin'],
        ])('refuses a symbolic link to a %s, naming it', async (kind, name) => {
            write('real/inside.bin');
            write('real.bin');
            fs.symlinkSync(path.join(root, kind === 'directory' ? 'real' : 'real.bin'), path.join(root, name));
            const refused = await refusal();
            expect(refused.message).toBe(`Storage path is a symbolic link and is not followed: ${name}`);
            expect(refused.message).not.toContain(root);
        });
        it('walks a prefix that is itself a symbolic link, since the walk starts from a path', async () => {
            write('elsewhere/s1/archived.bin');
            fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'chat-media'));
            expect(await walk('chat-media/')).toEqual(['chat-media/s1/archived.bin']);
        });
        it('treats a directory removed during the walk as empty', async () => {
            write('ok.bin');
            write('gone/file.bin');
            failReaddirAt(path.join(root, 'gone'), 'ENOENT');
            expect(await walk()).toEqual(['ok.bin']);
        });
    });
    describe('when asked to skip what it cannot read', () => {
        const lenient = () => {
            const warn = jest.fn();
            return { options: { skipUnreadable: true, logger: { log: jest.fn(), warn } }, warn };
        };
        it('skips an unreadable directory, names it, and still lists the rest', async () => {
            write('ok.bin');
            write('locked/hidden.bin');
            write('other/fine.bin');
            failReaddirAt(path.join(root, 'locked'));
            const { options, warn } = lenient();
            expect(await walk('', options)).toEqual(['ok.bin', 'other/fine.bin']);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('"locked"'));
            // The log keeps the host's own account of the failure, with its path; only the API message drops it.
            expect(warn).toHaveBeenCalledWith(expect.stringContaining(path.join(root, 'locked')));
        });
        it('skips a directory below the maximum depth and still lists the rest', async () => {
            write('ok.bin');
            write(deepKey);
            const { options, warn } = lenient();
            expect(await walk('', options)).toEqual(['ok.bin']);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('maximum traversal depth'));
        });
        it('skips a symbolic link, names it, and still lists the rest', async () => {
            write('ok.bin');
            write('real/inside.bin');
            fs.symlinkSync(path.join(root, 'real'), path.join(root, 'linked'));
            const { options, warn } = lenient();
            expect(await walk('', options)).toEqual(['ok.bin', 'real/inside.bin']);
            expect(warn).toHaveBeenCalledWith(expect.stringMatching(/"linked".*symbolic link/));
        });
        it('skips without a logger too', async () => {
            write('ok.bin');
            write('locked/hidden.bin');
            failReaddirAt(path.join(root, 'locked'));
            expect(await walk('', { skipUnreadable: true })).toEqual(['ok.bin']);
        });
    });
});
