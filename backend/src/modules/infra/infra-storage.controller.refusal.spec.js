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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const testing_1 = require("@nestjs/testing");
const supertest_1 = __importDefault(require("supertest"));
const storage_service_1 = require("../../common/storage/storage.service");
const infra_storage_controller_1 = require("./infra-storage.controller");
/**
 * The count and the export refuse a store the walk cannot enumerate completely, because an answer that leaves
 * files out would lose them on the next backend. That refusal has to reach the ADMIN who runs the migration with
 * its cause, not as a bare 500, and only that refusal: any other failure stays an internal error.
 */
describe('GET /infra/storage/files/count and GET /infra/storage/export over a store the walk refuses', () => {
    let tmp;
    let media;
    let app;
    let storage;
    beforeEach(async () => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-refusal-'));
        media = path.join(tmp, 'media');
        fs.mkdirSync(media, { recursive: true });
        fs.writeFileSync(path.join(media, 'real.bin'), 'real');
        // The export writes under <cwd>/data/exports.
        jest.spyOn(process, 'cwd').mockReturnValue(tmp);
        storage = new storage_service_1.StorageService({
            get: (key) => ({ 'storage.type': 'local', 'storage.localPath': media })[key],
        });
        const moduleRef = await testing_1.Test.createTestingModule({
            controllers: [infra_storage_controller_1.InfraStorageController],
            providers: [{ provide: storage_service_1.StorageService, useValue: storage }],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.init();
    });
    afterEach(async () => {
        await app.close();
        storage.onModuleDestroy();
        jest.restoreAllMocks();
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    /** A mode-000 directory is still readable by root, so the failure is injected for the one path. */
    const failReaddirAt = (suffix, code) => {
        const error = Object.assign(new Error(`${code}: cannot read ${path.join(media, suffix)}`), { code });
        const readdir = fs.promises.readdir.bind(fs.promises);
        jest
            .spyOn(fs.promises, 'readdir')
            .mockImplementation(((target, ...rest) => String(target).endsWith(path.join(media, suffix)) ? Promise.reject(error) : readdir(target, ...rest)));
    };
    const linkMediaAway = () => {
        fs.mkdirSync(path.join(tmp, 'bigdisk'));
        fs.writeFileSync(path.join(tmp, 'bigdisk', 'archived.bin'), 'archived');
        fs.symlinkSync(path.join(tmp, 'bigdisk'), path.join(media, 'chat-media'));
    };
    const exportsLeft = () => {
        const dir = path.join(tmp, 'data', 'exports');
        return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    };
    it.each(['/infra/storage/files/count', '/infra/storage/export'])('answers 409 naming the symbolic link, and not the host path, for %s', async (route) => {
        linkMediaAway();
        const response = await (0, supertest_1.default)(app.getHttpServer()).get(route);
        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            statusCode: 409,
            message: 'Storage path is a symbolic link and is not followed: chat-media',
            error: 'Conflict',
        });
        expect(JSON.stringify(response.body)).not.toContain(tmp);
        expect(exportsLeft()).toEqual([]);
    });
    it.each(['/infra/storage/files/count', '/infra/storage/export'])('answers 409 naming a directory the app cannot read, and the cause, for %s', async (route) => {
        fs.mkdirSync(path.join(media, 'locked'));
        failReaddirAt('locked', 'EACCES');
        const response = await (0, supertest_1.default)(app.getHttpServer()).get(route);
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
            statusCode: 409,
            message: 'Storage directory cannot be read: locked (EACCES)',
        });
        expect(JSON.stringify(response.body)).not.toContain(tmp);
    });
    it.each(['/infra/storage/files/count', '/infra/storage/export'])('still answers 500 for a failure that is not a refusal of the walk, for %s', async (route) => {
        fs.mkdirSync(path.join(media, 'broken'));
        failReaddirAt('broken', 'EIO');
        const response = await (0, supertest_1.default)(app.getHttpServer()).get(route);
        expect(response.status).toBe(500);
        expect(response.body).toEqual({ statusCode: 500, message: 'Internal server error' });
        expect(exportsLeft()).toEqual([]);
    });
    it('counts a store with nothing to refuse', async () => {
        const response = await (0, supertest_1.default)(app.getHttpServer()).get('/infra/storage/files/count');
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ storageType: 'local', count: 1, sizeBytes: 4 });
    });
});
