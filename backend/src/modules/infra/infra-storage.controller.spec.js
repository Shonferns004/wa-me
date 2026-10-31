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
const stream_1 = require("stream");
// saveConfig writes the generated env via fs.writeFileSync and reads the existing file
// via fs.existsSync/readFileSync; mock those so tests assert produced content without
// touching the filesystem. existsSync defaults to false (no prior config).
jest.mock('fs', () => {
    const actual = jest.requireActual('fs');
    return {
        ...actual,
        writeFileSync: jest.fn(),
        // saveConfig now writes the generated env via writeSecretFile, which chmods 0600 — mock it
        // so the secret-hygiene path never touches the real filesystem.
        chmodSync: jest.fn(),
        existsSync: jest.fn().mockReturnValue(false),
        readFileSync: jest.fn().mockReturnValue(''),
        createReadStream: jest.fn(() => jest.requireActual('stream').Readable.from([])),
        createWriteStream: jest.fn(actual.createWriteStream),
    };
});
const common_1 = require("@nestjs/common");
const infra_storage_controller_1 = require("./infra-storage.controller");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
describe('InfraStorageController.importStorage filePath validation', () => {
    function buildController(storage) {
        return new infra_storage_controller_1.InfraStorageController(storage);
    }
    it('rejects a filePath that escapes the data directory before touching the filesystem', async () => {
        const storage = { importFromStream: jest.fn(), getCurrentStorageType: jest.fn(() => 'local') };
        const controller = buildController(storage);
        await expect(controller.importStorage({ filePath: '../../../../etc/passwd' })).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(storage.importFromStream).not.toHaveBeenCalled();
    });
    it('guards and opens the same cwd-resolved path returned by storage export', async () => {
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
        fs.existsSync.mockImplementation((p) => p === '/srv/openwa/data/exports/export.tar.gz');
        fs.createReadStream.mockClear();
        const storage = {
            importFromStream: jest.fn().mockResolvedValue({ imported: 3, failed: 0 }),
            getCurrentStorageType: jest.fn(() => 'local'),
        };
        try {
            const result = await buildController(storage).importStorage({ filePath: 'data/exports/export.tar.gz' });
            expect(fs.createReadStream).toHaveBeenCalledWith('/srv/openwa/data/exports/export.tar.gz');
            expect(storage.importFromStream).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ imported: true, count: 3, failed: 0, storageType: 'local' });
        }
        finally {
            cwdSpy.mockRestore();
            fs.existsSync.mockReturnValue(false);
        }
    });
});
describe('InfraStorageController.exportStorage keeps the export import-able and sweeps it', () => {
    function buildController(storage) {
        return new infra_storage_controller_1.InfraStorageController({ getCurrentStorageType: () => 'local', ...storage });
    }
    // fs.existsSync is globally mocked in this file, so probe the real filesystem via fs.promises.access.
    const exists = (p) => fs.promises
        .access(p)
        .then(() => true)
        .catch(() => false);
    // Poll (don't sleep a fixed time) so the sweep assertion isn't flaky under CI load.
    const waitForGone = async (p, timeoutMs = 3000) => {
        const start = Date.now();
        while (await exists(p)) {
            if (Date.now() - start > timeoutMs)
                throw new Error(`file was not swept in time: ${p}`);
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    };
    let cwdSpy;
    let cwd;
    afterEach(() => {
        cwdSpy?.mockRestore();
        if (cwd)
            fs.rmSync(cwd, { recursive: true, force: true });
        cwdSpy = undefined;
        cwd = undefined;
        delete process.env.STORAGE_EXPORT_TTL_MS;
    });
    it('writes under data/exports (so it stays import-able + survives restart) and TTL-sweeps it', async () => {
        cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-cwd-'));
        cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
        process.env.STORAGE_EXPORT_TTL_MS = '30';
        const createExportStream = jest.fn().mockResolvedValue(stream_1.Readable.from([Buffer.from('archive-bytes')]));
        const controller = buildController({ createExportStream });
        const result = await controller.exportStorage();
        // download is cwd-relative (no absolute host path leak) and stays under data/exports so the import
        // handler — which only accepts paths inside data/ — can still consume it.
        expect(path.isAbsolute(result.download)).toBe(false);
        expect(result.download.startsWith(path.join('data', 'exports'))).toBe(true);
        // Resolve against the (mocked) cwd to check on-disk existence; fs itself uses the real cwd.
        const abs = path.join(cwd, result.download);
        expect(await exists(abs)).toBe(true);
        await waitForGone(abs);
        expect(await exists(abs)).toBe(false);
    });
});
describe('InfraStorageController.sweepStaleExportArchives (boot orphan sweep)', () => {
    function buildController() {
        return new infra_storage_controller_1.InfraStorageController({});
    }
    // A name in exactly the shape exportStorage writes: storage-export-<epochMs>-<uuid>.tar.gz.
    const archiveName = (epochMs) => `storage-export-${epochMs}-3b241101-e2bb-4255-8caf-4136c566a962.tar.gz`;
    const exists = (p) => fs.promises
        .access(p)
        .then(() => true)
        .catch(() => false);
    let dir;
    let cwdSpy;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-exports-'));
    });
    afterEach(() => {
        cwdSpy?.mockRestore();
        cwdSpy = undefined;
        if (dir)
            fs.rmSync(dir, { recursive: true, force: true });
        dir = undefined;
        delete process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS;
    });
    const touch = async (name) => {
        const p = path.join(dir, name);
        await fs.promises.writeFile(p, 'archive-bytes');
        return p;
    };
    it('deletes export archives older than the default 24h but keeps young archives and non-export files', async () => {
        const stale = await touch(archiveName(Date.now() - 25 * 60 * 60 * 1000));
        const young = await touch(archiveName(Date.now() - 60 * 1000));
        const operatorImportCandidate = await touch('to-import.tar.gz');
        // Near-miss names are NOT ours: no uuid / wrong extension / different prefix.
        const noUuid = await touch(`storage-export-${Date.now() - 48 * 60 * 60 * 1000}.tar.gz`);
        const wrongExt = await touch(archiveName(Date.now() - 48 * 60 * 60 * 1000).replace(/\.tar\.gz$/, '.zip'));
        const otherPrefix = await touch(`backup-${Date.now() - 48 * 60 * 60 * 1000}.tar.gz`);
        await buildController().sweepStaleExportArchives(dir);
        expect(await exists(stale)).toBe(false);
        expect(await exists(young)).toBe(true);
        expect(await exists(operatorImportCandidate)).toBe(true);
        expect(await exists(noUuid)).toBe(true);
        expect(await exists(wrongExt)).toBe(true);
        expect(await exists(otherPrefix)).toBe(true);
    });
    it('takes the max age from STORAGE_EXPORT_SWEEP_MAX_AGE_MS', async () => {
        const oneHourOld = archiveName(Date.now() - 60 * 60 * 1000);
        // A 30-minute cap sweeps a 1-hour-old archive...
        process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS = '1800000';
        const swept = await touch(oneHourOld);
        await buildController().sweepStaleExportArchives(dir);
        expect(await exists(swept)).toBe(false);
        // ...while a 2-hour cap keeps it.
        process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS = '7200000';
        const kept = await touch(oneHourOld);
        await buildController().sweepStaleExportArchives(dir);
        expect(await exists(kept)).toBe(true);
    });
    it('resolves quietly when the exports directory does not exist yet', async () => {
        await expect(buildController().sweepStaleExportArchives(path.join(dir, 'never-created'))).resolves.toBeUndefined();
    });
    it('runs the sweep against <cwd>/data/exports at application bootstrap', async () => {
        cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(dir);
        const exportDir = path.join(dir, 'data', 'exports');
        await fs.promises.mkdir(exportDir, { recursive: true });
        const stale = path.join(exportDir, archiveName(Date.now() - 25 * 60 * 60 * 1000));
        await fs.promises.writeFile(stale, 'archive-bytes');
        await buildController().onApplicationBootstrap();
        expect(await exists(stale)).toBe(false);
    });
});
describe('InfraStorageController storage stream failures surface as request errors, not process crashes', () => {
    it('importStorage maps an archive/stream failure to a 400 with the real reason', async () => {
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
        fs.existsSync.mockImplementation((p) => p === '/srv/openwa/data/exports/bad.tar.gz');
        try {
            const storage = {
                importFromStream: jest.fn().mockRejectedValue(new Error('incorrect header check')),
                getCurrentStorageType: () => 'local',
            };
            const controller = new infra_storage_controller_1.InfraStorageController(storage);
            const err = await controller.importStorage({ filePath: 'data/exports/bad.tar.gz' }).catch((e) => e);
            expect(err).toBeInstanceOf(common_1.BadRequestException);
            expect(err.message).toContain('incorrect header check');
        }
        finally {
            cwdSpy.mockRestore();
            fs.existsSync.mockReturnValue(false);
        }
    });
    it('exportStorage destroys the export stream when the archive file cannot be written', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-sink-'));
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
        const sink = new stream_1.Writable({
            write(_chunk, _encoding, callback) {
                callback(new Error('disk full'));
            },
        });
        fs.createWriteStream.mockReturnValueOnce(sink);
        try {
            // The export fills the archive while it is being written; a failed sink must stop it, or it
            // keeps a file open waiting for a reader that is gone.
            const source = new stream_1.Readable({
                read() {
                    this.push(Buffer.alloc(1024));
                },
            });
            const storage = { createExportStream: jest.fn().mockResolvedValue(source), getCurrentStorageType: () => 'local' };
            await expect(new infra_storage_controller_1.InfraStorageController(storage).exportStorage()).rejects.toThrow(/disk full/);
            expect(source.destroyed).toBe(true);
        }
        finally {
            cwdSpy.mockRestore();
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
    it('exportStorage rejects (and the process lives) when the export source stream errors', async () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-export-err-'));
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
        try {
            // pipe() never forwards source errors: without a listener on the source this would be an
            // unhandled 'error' event and kill the process instead of failing the request.
            // Some bytes land first, so the failure leaves a partial archive behind unless it is removed.
            let reads = 0;
            const errStream = new stream_1.Readable({
                read() {
                    if (reads++ === 0)
                        this.push(Buffer.alloc(1000));
                    else
                        this.destroy(new Error('archive boom'));
                },
            });
            const storage = {
                createExportStream: jest.fn().mockResolvedValue(errStream),
                getCurrentStorageType: () => 'local',
            };
            const controller = new infra_storage_controller_1.InfraStorageController(storage);
            await expect(controller.exportStorage()).rejects.toThrow(/archive boom/);
            expect(fs.readdirSync(path.join(cwd, 'data', 'exports'))).toEqual([]);
        }
        finally {
            cwdSpy.mockRestore();
            fs.rmSync(cwd, { recursive: true, force: true });
        }
    });
});
// The infra module's sensitive ADMIN operations (credential config write, restart/Docker
// orchestration, full-DB + storage export/import) must leave an audit trail — each emits an AuditAction.
describe('InfraStorageController audit trail (light-dependency handlers)', () => {
    const makeAudit = () => ({ logInfo: jest.fn().mockResolvedValue(null) });
    // Positional constructor: (storageService, auditService?). auditService is the last @Optional arg.
    const build = (audit, overrides = {}) => new infra_storage_controller_1.InfraStorageController((overrides.storageService ?? {}), audit);
    it('importStorage emits INFRA_STORAGE_IMPORTED with the imported file count', async () => {
        const audit = makeAudit();
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
        fs.existsSync.mockImplementation((p) => p === '/srv/openwa/data/exports/x.tar.gz');
        try {
            const storageService = {
                importFromStream: jest.fn().mockResolvedValue({ imported: 5, failed: 0 }),
                getCurrentStorageType: () => 'local',
            };
            await build(audit, { storageService }).importStorage({ filePath: 'data/exports/x.tar.gz' });
            const calls = audit.logInfo.mock.calls;
            expect(calls[0][0]).toBe(audit_log_entity_1.AuditAction.INFRA_STORAGE_IMPORTED);
            expect(calls[0][1].metadata).toEqual({ count: 5, failed: 0, storageType: 'local' });
        }
        finally {
            cwdSpy.mockRestore();
            fs.existsSync.mockReturnValue(false);
        }
    });
    it('importStorage records an import that wrote nothing as a warning, with its failed count', async () => {
        const audit = { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) };
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
        fs.existsSync.mockImplementation((p) => p === '/srv/openwa/data/exports/x.tar.gz');
        try {
            const storageService = {
                importFromStream: jest.fn().mockResolvedValue({ imported: 0, failed: 4 }),
                getCurrentStorageType: () => 'local',
            };
            await new infra_storage_controller_1.InfraStorageController(storageService, audit).importStorage({
                filePath: 'data/exports/x.tar.gz',
            });
            expect(audit.logInfo).not.toHaveBeenCalled();
            expect(audit.logWarn).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.INFRA_STORAGE_IMPORTED, {
                metadata: { count: 0, failed: 4, storageType: 'local' },
            });
        }
        finally {
            cwdSpy.mockRestore();
            fs.existsSync.mockReturnValue(false);
        }
    });
    it('importStorage records how many entries an aborted import had already written', async () => {
        const audit = { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) };
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
        fs.existsSync.mockImplementation((p) => p === '/srv/openwa/data/exports/x.tar.gz');
        try {
            const abort = Object.assign(new Error('archive exceeds 100000 entries'), { imported: 100000, failed: 2 });
            const storageService = {
                importFromStream: jest.fn().mockRejectedValue(abort),
                getCurrentStorageType: () => 'local',
            };
            await expect(new infra_storage_controller_1.InfraStorageController(storageService, audit).importStorage({
                filePath: 'data/exports/x.tar.gz',
            })).rejects.toBeInstanceOf(common_1.BadRequestException);
            expect(audit.logWarn).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.INFRA_STORAGE_IMPORTED, {
                metadata: {
                    aborted: true,
                    error: 'archive exceeds 100000 entries',
                    storageType: 'local',
                    count: 100000,
                    failed: 2,
                },
            });
        }
        finally {
            cwdSpy.mockRestore();
            fs.existsSync.mockReturnValue(false);
        }
    });
    it('importStorage records an aborted import as a warning, since the entries before the abort were kept', async () => {
        const audit = { logInfo: jest.fn().mockResolvedValue(null), logWarn: jest.fn().mockResolvedValue(null) };
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
        fs.existsSync.mockImplementation((p) => p === '/srv/openwa/data/exports/x.tar.gz');
        try {
            const storageService = {
                importFromStream: jest.fn().mockRejectedValue(new Error('archive exceeds 100000 entries')),
                getCurrentStorageType: () => 'local',
            };
            await expect(new infra_storage_controller_1.InfraStorageController(storageService, audit).importStorage({
                filePath: 'data/exports/x.tar.gz',
            })).rejects.toBeInstanceOf(common_1.BadRequestException);
            expect(audit.logInfo).not.toHaveBeenCalled();
            expect(audit.logWarn).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.INFRA_STORAGE_IMPORTED, {
                metadata: { aborted: true, error: 'archive exceeds 100000 entries', storageType: 'local' },
            });
        }
        finally {
            cwdSpy.mockRestore();
            fs.existsSync.mockReturnValue(false);
        }
    });
    it('exportStorage emits INFRA_STORAGE_EXPORTED', async () => {
        const audit = makeAudit();
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-audit-'));
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue(cwd);
        process.env.STORAGE_EXPORT_TTL_MS = '30';
        try {
            const storageService = {
                createExportStream: jest.fn().mockResolvedValue(stream_1.Readable.from([Buffer.from('x')])),
                getCurrentStorageType: () => 'local',
            };
            await build(audit, { storageService }).exportStorage();
            const calls = audit.logInfo.mock.calls;
            expect(calls[0][0]).toBe(audit_log_entity_1.AuditAction.INFRA_STORAGE_EXPORTED);
            expect(typeof calls[0][1].metadata.download).toBe('string');
        }
        finally {
            cwdSpy.mockRestore();
            fs.rmSync(cwd, { recursive: true, force: true });
            delete process.env.STORAGE_EXPORT_TTL_MS;
        }
    });
});
describe('InfraStorageController refuses to run a storage migration against the local fallback', () => {
    function unavailableS3() {
        return {
            getCurrentStorageType: jest.fn(() => 's3'),
            refreshS3Availability: jest.fn().mockResolvedValue(false),
            getFileCount: jest.fn(),
            createExportStream: jest.fn(),
            importFromStream: jest.fn(),
        };
    }
    it('answers 503 for the file count, the export and the import when the configured bucket is unusable', async () => {
        const storage = unavailableS3();
        const controller = new infra_storage_controller_1.InfraStorageController(storage);
        await expect(controller.getStorageFileCount()).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        await expect(controller.exportStorage()).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        await expect(controller.importStorage({ filePath: 'data/exports/x.tar.gz' })).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        expect(storage.refreshS3Availability).toHaveBeenCalledTimes(3);
        expect(storage.getFileCount).not.toHaveBeenCalled();
        expect(storage.createExportStream).not.toHaveBeenCalled();
        expect(storage.importFromStream).not.toHaveBeenCalled();
    });
    it('proceeds once the re-probe finds the bucket', async () => {
        const storage = unavailableS3();
        storage.refreshS3Availability.mockResolvedValue(true);
        storage.getFileCount.mockResolvedValue({ count: 2, sizeBytes: 0 });
        await expect(new infra_storage_controller_1.InfraStorageController(storage).getStorageFileCount()).resolves.toMatchObject({
            storageType: 's3',
            count: 2,
        });
    });
    it('never probes S3 for a local backend', async () => {
        const storage = { ...unavailableS3(), getCurrentStorageType: jest.fn(() => 'local') };
        storage.getFileCount.mockResolvedValue({ count: 0, sizeBytes: 0 });
        await new infra_storage_controller_1.InfraStorageController(storage).getStorageFileCount();
        expect(storage.refreshS3Availability).not.toHaveBeenCalled();
    });
});
describe('InfraStorageController.importStorage reports an import that wrote nothing', () => {
    async function importWith(result) {
        const cwdSpy = jest.spyOn(process, 'cwd').mockReturnValue('/srv/openwa');
        fs.existsSync.mockImplementation((p) => p === '/srv/openwa/data/exports/x.tar.gz');
        try {
            const storage = { importFromStream: jest.fn().mockResolvedValue(result), getCurrentStorageType: () => 'local' };
            return await new infra_storage_controller_1.InfraStorageController(storage).importStorage({ filePath: 'data/exports/x.tar.gz' });
        }
        finally {
            cwdSpy.mockRestore();
            fs.existsSync.mockReturnValue(false);
        }
    }
    it('answers imported:false when every entry was refused', async () => {
        await expect(importWith({ imported: 0, failed: 4 })).resolves.toEqual({
            imported: false,
            count: 0,
            failed: 4,
            storageType: 'local',
        });
    });
    it('keeps imported:true when only some entries were skipped', async () => {
        await expect(importWith({ imported: 3, failed: 1 })).resolves.toMatchObject({ imported: true, failed: 1 });
    });
    it('keeps imported:true for an empty archive', async () => {
        await expect(importWith({ imported: 0, failed: 0 })).resolves.toMatchObject({ imported: true, count: 0 });
    });
});
describe('InfraStorageController export setup failure', () => {
    it('prepares the directory before starting archive work', async () => {
        const filesystem = jest.requireMock('fs');
        const mkdir = jest.spyOn(filesystem, 'mkdirSync').mockImplementation(() => {
            throw new Error('directory unavailable');
        });
        const source = stream_1.Readable.from(['archive']);
        const create = jest.fn().mockResolvedValue(source);
        fs.existsSync.mockReturnValueOnce(false);
        const controller = new infra_storage_controller_1.InfraStorageController({
            getCurrentStorageType: () => 'local',
            createExportStream: create,
        });
        try {
            await expect(controller.exportStorage()).rejects.toThrow('directory unavailable');
            expect(create).not.toHaveBeenCalled();
        }
        finally {
            mkdir.mockRestore();
            source.destroy();
        }
    });
    it('closes the archive if constructing the destination throws', async () => {
        const source = stream_1.Readable.from(['archive']);
        fs.existsSync.mockReturnValueOnce(true);
        fs.createWriteStream.mockImplementationOnce(() => {
            throw new Error('destination unavailable');
        });
        const controller = new infra_storage_controller_1.InfraStorageController({
            getCurrentStorageType: () => 'local',
            createExportStream: jest.fn().mockResolvedValue(source),
        });
        try {
            await expect(controller.exportStorage()).rejects.toThrow('destination unavailable');
            expect(source.destroyed).toBe(true);
        }
        finally {
            source.destroy();
        }
    });
});
