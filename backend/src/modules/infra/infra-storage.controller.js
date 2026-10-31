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
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
var InfraStorageController_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.InfraStorageController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const infra_response_dto_1 = require("./dto/infra-response.dto");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const path_safety_1 = require("../../common/utils/path-safety");
const storage_service_1 = require("../../common/storage/storage.service");
const storage_local_files_1 = require("../../common/storage/storage-local-files");
const logger_service_1 = require("../../common/services/logger.service");
const audit_service_1 = require("../audit/audit.service");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const import_storage_dto_1 = require("./dto/import-storage.dto");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const S3_UNAVAILABLE_DESCRIPTION = 'STORAGE_TYPE is s3 but the bucket is unreachable or its credentials are missing; nothing was read or written.';
const WALK_REFUSED_DESCRIPTION = 'The local storage directory cannot be enumerated completely, so the answer would silently leave files out: ' +
    'it holds a symbolic link, a directory the app cannot read, or one nested too deep. `message` names the path ' +
    'relative to the storage root and the cause. Replace a link with a bind mount or fix the permissions, then ' +
    'retry; nothing was written.';
let InfraStorageController = class InfraStorageController {
    static { InfraStorageController_1 = this; }
    storageService;
    auditService;
    logger = (0, logger_service_1.createLogger)('InfraStorageController');
    constructor(storageService, auditService) {
        this.storageService = storageService;
        this.auditService = auditService;
    }
    // Matches exactly the filename exportStorage writes: storage-export-<Date.now()>-<randomUUID()>.tar.gz.
    // The captured group is the creation epoch-ms, so the sweep reads the age from the name — anything
    // not in this exact shape (an operator's import candidate, any other file) is never touched.
    static EXPORT_ARCHIVE_PATTERN = /^storage-export-(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tar\.gz$/;
    /**
     * Boot sweep for orphaned storage-export archives. exportStorage deletes each archive on a TTL
     * timer, but that timer dies with the process — an archive whose process restarted or crashed
     * before the timer fired would accumulate on the data volume forever. At bootstrap, delete the
     * archives WE created whose embedded creation timestamp is older than
     * STORAGE_EXPORT_SWEEP_MAX_AGE_MS (default 24h; kept generous so the documented
     * export→restart→import migration flow still finds its file). Young archives and any
     * non-export file in data/exports/ are left untouched.
     */
    async onApplicationBootstrap() {
        await this.sweepStaleExportArchives();
    }
    /**
     * Delete export archives older than STORAGE_EXPORT_SWEEP_MAX_AGE_MS from exportDir. Sweep
     * failures are logged, never thrown: a leftover archive must not block boot.
     */
    async sweepStaleExportArchives(exportDir = path.join(process.cwd(), 'data', 'exports')) {
        const maxAgeRaw = Number.parseInt(process.env.STORAGE_EXPORT_SWEEP_MAX_AGE_MS ?? '', 10);
        const maxAgeMs = Number.isInteger(maxAgeRaw) && maxAgeRaw > 0 ? maxAgeRaw : 24 * 60 * 60 * 1000; // default 24h
        let entries;
        try {
            entries = await fs.promises.readdir(exportDir, { withFileTypes: true });
        }
        catch (error) {
            // ENOENT just means no export has ever run on this deployment — nothing to sweep.
            if (error.code !== 'ENOENT') {
                this.logger.warn('Storage export sweep could not read the exports directory', {
                    exportDir,
                    error: String(error),
                });
            }
            return;
        }
        const now = Date.now();
        for (const entry of entries) {
            if (!entry.isFile())
                continue;
            const match = InfraStorageController_1.EXPORT_ARCHIVE_PATTERN.exec(entry.name);
            if (!match)
                continue;
            if (now - Number(match[1]) < maxAgeMs)
                continue;
            try {
                await fs.promises.unlink(path.join(exportDir, entry.name));
                this.logger.log('Swept stale storage export archive', { file: entry.name });
            }
            catch (error) {
                this.logger.warn('Failed to sweep stale storage export archive', { file: entry.name, error: String(error) });
            }
        }
    }
    // ============================================================================
    // STORAGE MIGRATION API
    // ============================================================================
    /**
     * A store the walk refuses to enumerate completely is a state the operator can fix, so the caller is told what and
     * where instead of a bare 500. Any other failure stays an internal error.
     */
    static refusalAsConflict(error) {
        if (error instanceof storage_local_files_1.StorageWalkRefusedError)
            throw new common_1.ConflictException(error.message);
        throw error;
    }
    /**
     * With STORAGE_TYPE=s3 and the bucket unusable (credentials missing, or unreachable since boot),
     * every StorageService operation quietly uses the local fallback directory. A count, export or
     * import run in that state reports on the wrong store: an import lands on local disk while answering
     * storageType 's3', and an export archives only the fallback files. Refuse instead, so the operator
     * retries once the bucket is back rather than trusting a migration that did not reach it.
     */
    async assertStorageBackendReady() {
        if (this.storageService.getCurrentStorageType() !== 's3')
            return;
        if (await this.storageService.refreshS3Availability())
            return;
        throw new common_1.ServiceUnavailableException('S3 storage is not available (bucket unreachable or credentials missing); retry once GET /api/infra/status reports s3Available: true');
    }
    async getStorageFileCount() {
        await this.assertStorageBackendReady();
        const { count, sizeBytes } = await this.storageService
            .getFileCount()
            .catch((error) => InfraStorageController_1.refusalAsConflict(error));
        return {
            storageType: this.storageService.getCurrentStorageType(),
            count,
            sizeBytes,
            sizeMB: (sizeBytes / 1024 / 1024).toFixed(2),
        };
    }
    async exportStorage() {
        await this.assertStorageBackendReady();
        // Note: In production, this would return a StreamableFile
        // For simplicity, we'll save to a temp file and return the path
        // Keep the export INSIDE data/ (under data/exports/): the import handler only accepts paths under
        // data/, and the documented backend-migration flow re-imports this file AFTER a container restart,
        // so it must live on the persistent volume — the OS temp dir is wiped on restart. The original
        // unbounded-accumulation leak is addressed by the TTL sweep below + a collision-proof filename
        // (a per-call UUID), not by relocating off the volume.
        const exportDir = path.join(process.cwd(), 'data', 'exports');
        if (!fs.existsSync(exportDir)) {
            fs.mkdirSync(exportDir, { recursive: true });
        }
        const exportPath = path.join(exportDir, `storage-export-${Date.now()}-${(0, crypto_1.randomUUID)()}.tar.gz`);
        // Created only once the destination can be prepared: the archive starts reading files at once, and one
        // nothing consumes would hold its open file and buffered bytes until the process exits.
        const stream = await this.storageService
            .createExportStream()
            .catch((error) => InfraStorageController_1.refusalAsConflict(error));
        let writeStream;
        try {
            const sink = (writeStream = fs.createWriteStream(exportPath));
            await new Promise((resolve, reject) => {
                sink.on('finish', resolve);
                // The archive is filled while it is written: destroying the source stops the export from
                // opening further files once the sink has failed.
                sink.on('error', (err) => {
                    stream.destroy();
                    reject(err);
                });
                // pipe() does NOT forward source errors: a tar/gzip failure surfaces as an 'error' event on
                // the source stream, which without a listener crashes the process. Fail the request instead and
                // tear down the sink so its fd isn't held open waiting for a 'finish' that never comes.
                stream.on('error', (err) => {
                    sink.destroy();
                    reject(err);
                });
                stream.pipe(sink);
            });
        }
        catch (error) {
            // The TTL sweep below only covers a finished archive; a failed one would otherwise stay on the
            // data volume until a restart a day later. Wait for the sink to close so the unlink cannot race
            // an open that is still pending.
            stream.destroy();
            if (writeStream) {
                const sink = writeStream;
                sink.destroy();
                if (!sink.closed)
                    await new Promise(resolve => sink.once('close', () => resolve()));
            }
            await fs.promises.unlink(exportPath).catch(() => undefined);
            throw error;
        }
        // Sweep the throwaway archive so repeated exports don't accumulate on the data volume.
        const ttlRaw = Number.parseInt(process.env.STORAGE_EXPORT_TTL_MS ?? '', 10);
        const ttlMs = Number.isInteger(ttlRaw) && ttlRaw > 0 ? ttlRaw : 60 * 60 * 1000; // default 1h
        setTimeout(() => {
            fs.promises.unlink(exportPath).catch(() => undefined);
        }, ttlMs).unref();
        // cwd-relative rather than an absolute host path: doesn't leak the filesystem layout, and the
        // import round-trip still works because importStorage's existsSync/createReadStream resolve a
        // relative filePath against the same cwd this was made relative to.
        const download = path.relative(process.cwd(), exportPath);
        // Audit the bulk media-export (all stored files leave the box as one archive).
        await this.auditService?.logInfo(audit_log_entity_1.AuditAction.INFRA_STORAGE_EXPORTED, { metadata: { download } });
        return {
            message: 'Storage export completed',
            download,
        };
    }
    async importStorage(body) {
        await this.assertStorageBackendReady();
        const { filePath } = body;
        // `filePath` is fully caller-controlled. Restrict it to the app's data
        // directory so it cannot point at arbitrary files on the host. Resolve once against the
        // same cwd-relative base used by exportStorage, then use that exact path for both the guard
        // and the file sink.
        const dataDir = path.join(process.cwd(), 'data');
        const resolved = path.resolve(process.cwd(), filePath || '');
        if (!filePath || !(0, path_safety_1.isPathWithin)(dataDir, resolved)) {
            throw new common_1.BadRequestException('filePath must reference a file inside the data directory');
        }
        if (!fs.existsSync(resolved)) {
            throw new common_1.BadRequestException(`File not found: ${filePath}`);
        }
        const readStream = fs.createReadStream(resolved);
        // importFromStream rejects on archive/gzip/read failures (its streams carry error listeners, so a
        // bad file fails the request instead of crashing the process on an unhandled 'error' event). The
        // failures that reach here are almost always a problem with the caller-supplied file (not a gzip,
        // not a tar, unreadable, over the resource caps), so surface them as a 400 with the real reason
        // rather than an opaque 500.
        let count;
        let failed;
        try {
            ({ imported: count, failed } = await this.storageService.importFromStream(readStream));
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // An abort keeps the entries written before it (there is no rollback), so it is audited too,
            // with the partial counts when the import attaches them to its rejection, so the row says how much changed.
            const partial = error;
            await this.auditService?.logWarn(audit_log_entity_1.AuditAction.INFRA_STORAGE_IMPORTED, {
                metadata: {
                    aborted: true,
                    error: message,
                    storageType: this.storageService.getCurrentStorageType(),
                    count: partial?.imported,
                    failed: partial?.failed,
                },
            });
            throw new common_1.BadRequestException(`Storage import failed: ${message}`);
        }
        const storageType = this.storageService.getCurrentStorageType();
        // A bad or traversing entry is skipped by design, so one refusal does not fail the import. An
        // archive whose every entry was refused (the store rejects writes) wrote nothing and says so.
        const imported = !(failed > 0 && count === 0);
        // Audit the bulk media-import (files written into the active storage backend); one whose every
        // entry was refused is recorded as a warning.
        const audit = { metadata: { count, failed, storageType } };
        if (imported) {
            await this.auditService?.logInfo(audit_log_entity_1.AuditAction.INFRA_STORAGE_IMPORTED, audit);
        }
        else {
            await this.auditService?.logWarn(audit_log_entity_1.AuditAction.INFRA_STORAGE_IMPORTED, audit);
        }
        return {
            imported,
            count,
            failed,
            storageType,
        };
    }
};
exports.InfraStorageController = InfraStorageController;
__decorate([
    (0, common_1.Get)('storage/files/count'),
    (0, auth_decorators_1.RequireRole)(api_key_entity_1.ApiKeyRole.ADMIN),
    (0, swagger_1.ApiOperation)({ summary: 'Get file count in current storage' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'File count and size', type: infra_response_dto_1.StorageFileCountResponseDto }),
    (0, swagger_1.ApiResponse)({ status: 409, description: WALK_REFUSED_DESCRIPTION }),
    (0, swagger_1.ApiResponse)({ status: 503, description: S3_UNAVAILABLE_DESCRIPTION }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], InfraStorageController.prototype, "getStorageFileCount", null);
__decorate([
    (0, common_1.Get)('storage/export'),
    (0, auth_decorators_1.RequireRole)(api_key_entity_1.ApiKeyRole.ADMIN),
    (0, swagger_1.ApiOperation)({ summary: 'Export all storage files as tar.gz' }),
    (0, swagger_1.ApiResponse)({
        status: 200,
        description: 'JSON pointing at the archive that was written under data/exports/. This route does NOT stream ' +
            'the tar.gz, and no route serves it: `download` is a server-side path to pass as `filePath` to ' +
            'POST /api/infra/storage/import.',
        type: infra_response_dto_1.StorageExportResponseDto,
    }),
    (0, swagger_1.ApiResponse)({ status: 409, description: WALK_REFUSED_DESCRIPTION }),
    (0, swagger_1.ApiResponse)({ status: 503, description: S3_UNAVAILABLE_DESCRIPTION }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], InfraStorageController.prototype, "exportStorage", null);
__decorate([
    (0, common_1.Post)('storage/import'),
    (0, common_1.HttpCode)(common_1.HttpStatus.OK),
    (0, auth_decorators_1.RequireRole)(api_key_entity_1.ApiKeyRole.ADMIN),
    (0, swagger_1.ApiOperation)({ summary: 'Import storage files from tar.gz' })
    // `type:` is required, not decoration: a description-only @ApiBody has nothing to infer the DTO
    // from and publishes `{"type":"string"}`, telling every generated client the body is a bare
    // string while the handler takes an object.
    ,
    (0, swagger_1.ApiBody)({ type: import_storage_dto_1.ImportStorageDto, description: 'Path to tar.gz file to import' }),
    (0, swagger_1.ApiResponse)({ status: 200, description: 'Import result', type: infra_response_dto_1.StorageImportResponseDto }),
    (0, swagger_1.ApiResponse)({
        status: 400,
        description: '`filePath` is outside the data directory or does not exist, or the archive could not be read or ' +
            'broke a resource cap. Entries written before an abort are kept.',
    }),
    (0, swagger_1.ApiResponse)({ status: 503, description: S3_UNAVAILABLE_DESCRIPTION }),
    __param(0, (0, common_1.Body)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [import_storage_dto_1.ImportStorageDto]),
    __metadata("design:returntype", Promise)
], InfraStorageController.prototype, "importStorage", null);
exports.InfraStorageController = InfraStorageController = InfraStorageController_1 = __decorate([
    (0, swagger_1.ApiTags)('infrastructure'),
    (0, common_1.Controller)('infra')
    // Every route here is deployment-global (data export/import, infra config, service orchestration),
    // so the guard's route-param session fence can never bite. Reject session-scoped keys outright at
    // class level, which also covers routes added later. @Public routes are unaffected: the guard
    // returns before it reads this metadata.
    ,
    (0, auth_decorators_1.RequireUnscopedKey)(),
    __param(1, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [storage_service_1.StorageService,
        audit_service_1.AuditService])
], InfraStorageController);
