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
const crypto_1 = require("crypto");
const stream_1 = require("stream");
const tar = __importStar(require("tar-stream"));
const zlib_1 = require("zlib");
const storage_transfer_1 = require("./storage-transfer");
const FILE_BYTES = 256 * 1024;
const files = Array.from({ length: 12 }, (_, i) => `media/file-${String.fromCharCode(97 + i)}.bin`);
const makeLogger = () => ({ warn: jest.fn(), error: jest.fn(), log: jest.fn(), debug: jest.fn() });
// Random bytes do not compress, so gzip cannot hide a file inside a few kilobytes of stream buffer.
const contents = new Map();
const contentFor = (name) => {
    if (!contents.has(name))
        contents.set(name, (0, crypto_1.randomBytes)(FILE_BYTES));
    return contents.get(name);
};
/** An openFile that counts the file streams open at once and the files ever opened. */
function trackingOpener(failing = {}, withSize = true) {
    const stats = { opened: 0, open: 0, maxOpen: 0 };
    const openFile = (name) => {
        if (failing[name] === 'gone')
            return Promise.reject(Object.assign(new Error(`ENOENT: ${name}`), { code: 'ENOENT' }));
        if (failing[name] === 'bucket')
            return Promise.reject(Object.assign(new Error('The specified bucket does not exist'), {
                name: 'NoSuchBucket',
                $metadata: { httpStatusCode: 404 },
            }));
        if (failing[name] === 'open')
            return Promise.reject(new Error(`SlowDown: ${name}`));
        const data = contentFor(name);
        stats.opened++;
        stats.open++;
        stats.maxOpen = Math.max(stats.maxOpen, stats.open);
        let offset = 0;
        const stream = new stream_1.Readable({
            highWaterMark: 16 * 1024,
            read() {
                if (failing[name] === 'read' && offset > 0) {
                    this.destroy(new Error(`read failed: ${name}`));
                    return;
                }
                const chunk = data.subarray(offset, offset + 16 * 1024);
                offset += chunk.length;
                this.push(chunk.length ? chunk : null);
            },
        });
        stream.once('close', () => stats.open--);
        return Promise.resolve({ stream, size: withSize ? data.length : undefined });
    };
    return { stats, openFile };
}
const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function importAll(output, logger) {
    const imported = new Map();
    await (0, storage_transfer_1.importFromStream)(output, (name, data) => {
        imported.set(name, data);
        return Promise.resolve();
    }, logger);
    return imported;
}
describe('createExportStream streams one file at a time', () => {
    it('returns before reading the store and opens no further files while nothing consumes the output', async () => {
        const { stats, openFile } = trackingOpener();
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files), openFile, makeLogger());
        await settle(100);
        // Stream buffers absorb a file or so; every file past that waits for a reader.
        expect(stats.opened).toBeLessThanOrEqual(2);
        output.destroy();
    });
    it('holds one file stream open at a time, skips a file deleted since the listing, and round-trips the rest', async () => {
        const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'gone' });
        const logger = makeLogger();
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files), openFile, logger);
        const imported = await importAll(output, logger);
        expect(stats.maxOpen).toBe(1);
        expect(stats.open).toBe(0);
        expect(logger.warn).toHaveBeenCalledWith('Failed to export file: media/file-c.bin', expect.anything());
        expect([...imported.keys()].sort()).toEqual(files.filter(f => f !== 'media/file-c.bin'));
        for (const [name, data] of imported)
            expect(data.equals(contentFor(name))).toBe(true);
    });
    it('fails the output when a listed file cannot be opened for any other reason', async () => {
        const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'open' });
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files), openFile, makeLogger());
        const error = await new Promise(resolve => {
            output.on('error', resolve);
            output.resume();
        });
        await settle(20);
        expect(error.message).toBe('SlowDown: media/file-c.bin');
        expect(stats.opened).toBe(2);
    });
    it('fails the output when the bucket itself is gone, not only one object', async () => {
        const { stats, openFile } = trackingOpener({ 'media/file-c.bin': 'bucket' });
        const logger = makeLogger();
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files), openFile, logger);
        const error = await new Promise(resolve => {
            output.on('error', resolve);
            output.resume();
        });
        await settle(20);
        expect(error.name).toBe('NoSuchBucket');
        expect(stats.opened).toBe(2);
        expect(logger.warn).not.toHaveBeenCalledWith('Failed to export file: media/file-c.bin', expect.anything());
    });
    it('still exports a file whose size the backend did not report', async () => {
        const { openFile } = trackingOpener({}, false);
        const logger = makeLogger();
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files.slice(0, 2)), openFile, logger);
        const imported = await importAll(output, logger);
        expect(imported.get(files[1])?.equals(contentFor(files[1]))).toBe(true);
    });
    // A key is an opaque name. A backslash, a doubled slash or a leading `word:` belongs to it, and an archive that
    // rewrites any of them restores the file under a different key.
    it.each([true, false])('writes every key under exactly the name it is stored by (size reported: %s)', async (withSize) => {
        const names = [
            'media/back\\slash.bin',
            'media/dir//double.bin',
            '628123:4@s.whatsapp.net/c.jpg',
            'status:x/y.bin',
        ];
        const { openFile } = trackingOpener({}, withSize);
        const logger = makeLogger();
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(names), openFile, logger);
        const imported = await importAll(output, logger);
        expect([...imported.keys()]).toEqual(names);
        expect(imported.get(names[0])?.equals(contentFor(names[0]))).toBe(true);
    });
    it('fails the output with a read error part-way through a file and stops opening files', async () => {
        const { stats, openFile } = trackingOpener({ 'media/file-b.bin': 'read' });
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files), openFile, makeLogger());
        const error = await new Promise(resolve => {
            output.on('error', resolve);
            output.resume();
        });
        await settle(20);
        expect(error.message).toBe('read failed: media/file-b.bin');
        expect(stats.opened).toBe(2);
        expect(stats.open).toBe(0);
    });
    it('stops and releases the open file when the consumer destroys the output', async () => {
        const { stats, openFile } = trackingOpener();
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files), openFile, makeLogger());
        await settle(50);
        const openedBefore = stats.opened;
        output.destroy();
        await settle(50);
        expect(stats.open).toBe(0);
        expect(stats.opened).toBe(openedBefore);
    });
});
describe('createExportStream releases the archive streams', () => {
    // The tar and gzip streams hold whatever the consumer had not read yet, and zlib a native handle. Destroying
    // the output has to release them at once, not leave them to the garbage collector. Nothing else fails when it
    // does not: the export stops opening files either way, so only the two streams themselves can show it.
    it('destroys the tar and gzip streams when the consumer destroys the output mid-entry', async () => {
        const realZlib = jest.requireActual('zlib');
        const realCreateGzip = realZlib.createGzip;
        const readOnlyExport = { configurable: true, enumerable: true, writable: false };
        const gzips = [];
        // createGzip is a read-only export. jest.spyOn cannot wrap it, and the failed attempt makes the suite fail
        // when the mocks are restored, so the export is replaced by hand for the length of the test.
        Object.defineProperty(realZlib, 'createGzip', {
            ...readOnlyExport,
            value: (...args) => {
                const gzip = realCreateGzip(...args);
                gzips.push(gzip);
                return gzip;
            },
        });
        const pack = jest.spyOn(jest.requireActual('tar-stream'), 'pack');
        try {
            let reading = false;
            // An entry that never ends, so the export is parked inside it when the consumer goes away.
            const stuck = new stream_1.Readable({
                read() {
                    reading = true;
                },
            });
            const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(['media/stuck.bin']), () => Promise.resolve({ stream: stuck, size: FILE_BYTES }), makeLogger());
            for (let waited = 0; !reading && waited < 1000; waited += 10)
                await settle(10);
            expect(reading).toBe(true);
            expect(pack).toHaveBeenCalledTimes(1);
            expect(gzips).toHaveLength(1);
            const tarPack = pack.mock.results[0].value;
            const gzip = gzips[0];
            expect(tarPack.destroyed).toBe(false);
            expect(gzip.destroyed).toBe(false);
            output.destroy();
            // Destroying a stream finishes on a later tick; a missing teardown shows here as a stream still open.
            for (let waited = 0; !(tarPack.destroyed && gzip.destroyed) && waited < 1000; waited += 10)
                await settle(10);
            expect(tarPack.destroyed).toBe(true);
            expect(gzip.destroyed).toBe(true);
        }
        finally {
            pack.mockRestore();
            Object.defineProperty(realZlib, 'createGzip', { ...readOnlyExport, value: realCreateGzip });
        }
    });
});
describe('importFromStream reports refused writes', () => {
    it('counts every entry putFile rejects as failed, and none as imported', async () => {
        const { openFile } = trackingOpener();
        const names = files.slice(0, 3);
        const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(names), openFile, makeLogger());
        const result = await (0, storage_transfer_1.importFromStream)(output, () => Promise.reject(new Error('AccessDenied')), makeLogger());
        expect(result).toEqual({ imported: 0, failed: names.length });
    });
});
describe('importFromStream writes regular files only', () => {
    it('skips directory and link entries and drops a leading ./ from the key', async () => {
        const pack = tar.pack();
        pack.entry({ name: './', type: 'directory' });
        pack.entry({ name: './status/', type: 'directory' });
        pack.entry({ name: './status/link.jpg', type: 'symlink', linkname: 'a.jpg' });
        pack.entry({ name: './status/hard.jpg', type: 'link', linkname: './status/a.jpg' });
        pack.entry({ name: './status/a.jpg' }, Buffer.from('jpeg!!'));
        pack.finalize();
        const written = new Map();
        const result = await (0, storage_transfer_1.importFromStream)(pack.pipe((0, zlib_1.createGzip)()), (name, data) => {
            written.set(name, data);
            return Promise.resolve();
        }, makeLogger());
        expect([...written.keys()]).toEqual(['status/a.jpg']);
        expect(written.get('status/a.jpg')?.toString()).toBe('jpeg!!');
        expect(result).toEqual({ imported: 1, failed: 0 });
    });
});
describe('importFromStream reports partial counts on an abort', () => {
    it('carries the entries already written on an entry-cap rejection', async () => {
        const prev = process.env.STORAGE_IMPORT_MAX_ENTRIES;
        process.env.STORAGE_IMPORT_MAX_ENTRIES = '2';
        const pack = tar.pack();
        for (const name of ['a.jpg', 'b.jpg', 'c.jpg'])
            pack.entry({ name }, Buffer.from(name));
        pack.finalize();
        const written = [];
        try {
            const rejection = await (0, storage_transfer_1.importFromStream)(pack.pipe((0, zlib_1.createGzip)()), name => {
                written.push(name);
                return Promise.resolve();
            }, makeLogger()).catch((err) => err);
            expect(rejection).toBeInstanceOf(Error);
            expect(rejection.message).toMatch(/2-entry limit \(STORAGE_IMPORT_MAX_ENTRIES\)/);
            expect(rejection).toMatchObject({ imported: 2, failed: 0 });
            expect(written).toEqual(['a.jpg', 'b.jpg']);
        }
        finally {
            if (prev === undefined)
                delete process.env.STORAGE_IMPORT_MAX_ENTRIES;
            else
                process.env.STORAGE_IMPORT_MAX_ENTRIES = prev;
        }
    });
});
describe('importFromStream caps the total bytes one import extracts', () => {
    const withTotalCap = async (cap, run) => {
        const prev = process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES;
        process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES = cap;
        try {
            return await run();
        }
        finally {
            if (prev === undefined)
                delete process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES;
            else
                process.env.STORAGE_IMPORT_MAX_TOTAL_BYTES = prev;
        }
    };
    const importEntries = (written, sizes) => {
        const pack = tar.pack();
        sizes.forEach((size, i) => pack.entry({ name: `e${i}.bin` }, Buffer.alloc(size, 0x61)));
        pack.finalize();
        return (0, storage_transfer_1.importFromStream)(pack.pipe((0, zlib_1.createGzip)()), (name, data) => {
            written.set(name, data);
            return Promise.resolve();
        }, makeLogger());
    };
    const bytesIn = (written) => [...written.values()].reduce((n, b) => n + b.length, 0);
    it('aborts when entries that each fit the per-entry cap add up past the total cap', async () => {
        const written = new Map();
        const rejection = await withTotalCap('10000', () => importEntries(written, [4000, 4000, 4000, 4000])).catch((err) => err);
        expect(rejection).toBeInstanceOf(Error);
        expect(rejection.message).toMatch(/10000-byte total cap \(STORAGE_IMPORT_MAX_TOTAL_BYTES\)/);
        expect(rejection).toMatchObject({ imported: 2, failed: 0 });
        expect([...written.keys()]).toEqual(['e0.bin', 'e1.bin']);
        expect(bytesIn(written)).toBeLessThanOrEqual(10000);
    });
    it('imports an archive whose total is exactly the cap', async () => {
        const written = new Map();
        const result = await withTotalCap('8000', () => importEntries(written, [4000, 4000]));
        expect(result).toEqual({ imported: 2, failed: 0 });
        expect(bytesIn(written)).toBe(8000);
    });
    it('warns at export time when the archive holds more bytes than the import accepts', async () => {
        const exportWith = async (cap) => {
            const logger = makeLogger();
            await withTotalCap(cap, async () => {
                const { openFile } = trackingOpener();
                const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files.slice(0, 3)), openFile, logger);
                await new Promise(resolve => output.on('end', resolve).resume());
            });
            return logger.warn;
        };
        expect(await exportWith(String(3 * FILE_BYTES))).not.toHaveBeenCalled();
        expect(await exportWith(String(3 * FILE_BYTES - 1))).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_TOTAL_BYTES'));
    });
});
describe('createExportStream and the per-entry import cap', () => {
    it('warns at export time when one file is larger than the import accepts', async () => {
        const exportWith = async (cap) => {
            const logger = makeLogger();
            const prev = process.env.STORAGE_IMPORT_MAX_BYTES;
            process.env.STORAGE_IMPORT_MAX_BYTES = cap;
            try {
                const { openFile } = trackingOpener();
                const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files.slice(0, 3)), openFile, logger);
                await new Promise(resolve => output.on('end', resolve).resume());
            }
            finally {
                if (prev === undefined)
                    delete process.env.STORAGE_IMPORT_MAX_BYTES;
                else
                    process.env.STORAGE_IMPORT_MAX_BYTES = prev;
            }
            return logger.warn;
        };
        expect(await exportWith(String(FILE_BYTES))).not.toHaveBeenCalled();
        const warn = await exportWith(String(FILE_BYTES - 1));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_BYTES'));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`(${FILE_BYTES} bytes)`));
    });
});
describe('the per-entry import cap boundary', () => {
    const importOne = async (cap, size) => {
        const prev = process.env.STORAGE_IMPORT_MAX_BYTES;
        process.env.STORAGE_IMPORT_MAX_BYTES = cap;
        const pack = tar.pack();
        pack.entry({ name: 'only.bin' }, Buffer.alloc(size, 0x61));
        pack.finalize();
        try {
            return await (0, storage_transfer_1.importFromStream)(pack.pipe((0, zlib_1.createGzip)()), () => Promise.resolve(), makeLogger()).catch((err) => err);
        }
        finally {
            if (prev === undefined)
                delete process.env.STORAGE_IMPORT_MAX_BYTES;
            else
                process.env.STORAGE_IMPORT_MAX_BYTES = prev;
        }
    };
    it('imports an entry of exactly the cap and aborts on one byte more', async () => {
        expect(await importOne('10', 10)).toEqual({ imported: 1, failed: 0 });
        const over = await importOne('10', 11);
        expect(over).toBeInstanceOf(Error);
        expect(over.message).toMatch(/10-byte per-entry cap \(STORAGE_IMPORT_MAX_BYTES\)/);
    });
});
describe('createExportStream and the entry-count limit this deployment lowered', () => {
    it('warns above the lower limit, though the shipped default would not', async () => {
        const prev = process.env.STORAGE_IMPORT_MAX_ENTRIES;
        process.env.STORAGE_IMPORT_MAX_ENTRIES = '2';
        const logger = makeLogger();
        try {
            const { openFile } = trackingOpener();
            const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(files.slice(0, 3)), openFile, logger);
            await new Promise(resolve => output.on('end', resolve).resume());
        }
        finally {
            if (prev === undefined)
                delete process.env.STORAGE_IMPORT_MAX_ENTRIES;
            else
                process.env.STORAGE_IMPORT_MAX_ENTRIES = prev;
        }
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('above the import limit of 2'));
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_ENTRIES'));
    });
});
// A backend that does not report a length (ExportFileSource.size is optional) still exports a file the
// destination may refuse, so the warning is worked out from the bytes actually read.
describe('createExportStream warns about import limits for files of unreported size', () => {
    const exportWithLimits = async (limits, sizes) => {
        const previous = Object.fromEntries(Object.keys(limits).map(key => [key, process.env[key]]));
        Object.assign(process.env, limits);
        const logger = makeLogger();
        try {
            const names = sizes.map((_, index) => `media/unknown-${index}.bin`);
            const output = await (0, storage_transfer_1.createExportStream)(() => Promise.resolve(names), name => Promise.resolve({ stream: stream_1.Readable.from([Buffer.alloc(sizes[names.indexOf(name)], 0x61)]) }), logger);
            await new Promise(resolve => output.on('end', resolve).resume());
        }
        finally {
            for (const [key, value] of Object.entries(previous)) {
                if (value === undefined)
                    delete process.env[key];
                else
                    process.env[key] = value;
            }
        }
        return logger;
    };
    it('warns when one file is above the per-entry limit', async () => {
        const logger = await exportWithLimits({ STORAGE_IMPORT_MAX_BYTES: '5' }, [6]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_BYTES'));
    });
    it('warns when the files together are above the total limit', async () => {
        const logger = await exportWithLimits({ STORAGE_IMPORT_MAX_TOTAL_BYTES: '5' }, [3, 3]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Raise STORAGE_IMPORT_MAX_TOTAL_BYTES'));
    });
    it('stays quiet at exactly the limits', async () => {
        const logger = await exportWithLimits({ STORAGE_IMPORT_MAX_BYTES: '3', STORAGE_IMPORT_MAX_TOTAL_BYTES: '6' }, [3, 3]);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
// docs/14, .env.example and the upgrade notes state these figures, and an operator sizes an import
// against them: a drifted default changes what an import is allowed to extract without a word.
describe('storage import caps', () => {
    it('ship at the documented defaults', () => {
        expect(storage_transfer_1.DEFAULT_IMPORT_MAX_BYTES).toBe(209_715_200);
        expect(storage_transfer_1.DEFAULT_IMPORT_MAX_ENTRIES).toBe(100_000);
        expect(storage_transfer_1.DEFAULT_IMPORT_MAX_TOTAL_BYTES).toBe(10_737_418_240);
    });
});
