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
const http = __importStar(require("http"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const logger_service_1 = require("../services/logger.service");
const storage_service_1 = require("./storage.service");
// The real S3 SDK against a local S3 stand-in: the property under test is the SDK's per-client socket pool.
jest.setTimeout(30_000);
/** The SDK's default pool size per client (@smithy/node-http-handler). */
const POOL_SIZE = 50;
/**
 * Answers PUT, DELETE and HEAD at once, and every GET with a body that never ends: one chunk of a declared
 * gigabyte. Each opened download therefore keeps its socket checked out until its reader takes the rest,
 * whatever the loopback buffers hold, which is what a client reading slowly does to a streamed download.
 */
function s3Stub() {
    return http.createServer((req, res) => {
        if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(1024 ** 3), ETag: '"x"' });
            res.write(Buffer.alloc(64 * 1024, 5));
            return;
        }
        req.resume();
        req.on('end', () => {
            res.writeHead(req.method === 'DELETE' ? 204 : 200, { ETag: '"x"' });
            res.end();
        });
    });
}
describe('StorageService S3 downloads and the socket pool', () => {
    const saved = { ...process.env };
    let stub;
    let storage;
    let dir;
    const streams = [];
    beforeEach(async () => {
        jest.spyOn(logger_service_1.LoggerService.prototype, 'log').mockImplementation(() => undefined);
        jest.spyOn(logger_service_1.LoggerService.prototype, 'warn').mockImplementation(() => undefined);
        stub = s3Stub();
        await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-stream-pool-'));
        process.env.S3_ENDPOINT = `http://127.0.0.1:${stub.address().port}`;
        process.env.S3_ACCESS_KEY_ID = 'test';
        process.env.S3_SECRET_ACCESS_KEY = 'test';
        process.env.S3_BUCKET = 'openwa';
        const values = { 'storage.type': 's3', 'storage.localPath': path.join(dir, 'media') };
        storage = new storage_service_1.StorageService({ get: (key) => values[key] });
        expect(await storage.refreshS3Availability()).toBe(true);
    });
    afterEach(async () => {
        for (const stream of streams.splice(0))
            stream.destroy();
        storage.onModuleDestroy();
        const clients = storage;
        for (const key of ['s3Client', 's3StreamClient'])
            clients[key]?.destroy();
        stub.closeAllConnections();
        await new Promise(resolve => stub.close(resolve));
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
        jest.restoreAllMocks();
    });
    it('still writes and deletes while a full pool of opened downloads is unread', async () => {
        // A status video or chat media file opened for each of fifty clients that have stopped reading.
        for (let i = 0; i < POOL_SIZE; i++)
            streams.push((await storage.openFile(`statuses/s1/v${i}.mp4`)).stream);
        // The next inbound status is written, and a retention purge deletes, on the same bucket. Waiting for a
        // socket instead would end in the SDK's connect timeout (5 s, three attempts), so 3 s is ample.
        const work = Promise.all([
            storage.putFile('statuses/s1/next.jpg', Buffer.from('x')),
            storage.deleteFile('statuses/s1/old.jpg'),
        ]).then(() => 'done');
        let timer;
        const waited = new Promise(resolve => (timer = setTimeout(() => resolve('still waiting'), 3000)));
        const outcome = await Promise.race([work, waited]).finally(() => clearTimeout(timer));
        expect(outcome).toBe('done');
    });
});
