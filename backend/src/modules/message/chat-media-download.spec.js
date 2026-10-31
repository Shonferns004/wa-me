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
const stream_1 = require("stream");
const testing_1 = require("@nestjs/testing");
// The S3 SDK is replaced so the bucket answers locally: HeadBucket succeeds and GetObject answers
// whatever the test sets.
jest.mock('@aws-sdk/client-s3', () => {
    class Command {
        input;
        constructor(input) {
            this.input = input;
        }
    }
    class HeadBucketCommand extends Command {
    }
    class CreateBucketCommand extends Command {
    }
    class ListObjectsV2Command extends Command {
    }
    class GetObjectCommand extends Command {
    }
    class PutObjectCommand extends Command {
    }
    class DeleteObjectCommand extends Command {
    }
    const send = jest.fn();
    return {
        S3Client: jest.fn(() => ({ send })),
        HeadBucketCommand,
        CreateBucketCommand,
        ListObjectsV2Command,
        GetObjectCommand,
        PutObjectCommand,
        DeleteObjectCommand,
        mockSend: send,
    };
});
const client_s3_1 = require("@aws-sdk/client-s3");
const storage_service_1 = require("../../common/storage/storage.service");
const chat_scope_service_1 = require("../auth/chat-scope.service");
const bulk_message_service_1 = require("./bulk-message.service");
const send_idempotency_service_1 = require("./idempotency/send-idempotency.service");
const message_controller_1 = require("./message.controller");
const message_service_1 = require("./message.service");
const { mockSend } = jest.requireMock('@aws-sdk/client-s3');
/** GET over a real socket, reporting how the response ended. */
function get(port, route, waitMs) {
    return new Promise(resolve => {
        const answer = { headers: {}, body: Buffer.alloc(0), outcome: 'pending' };
        const chunks = [];
        let settled = false;
        const done = (outcome) => {
            if (settled)
                return;
            settled = true;
            answer.body = Buffer.concat(chunks);
            answer.outcome = outcome;
            resolve(answer);
        };
        const req = http.get({ host: '127.0.0.1', port, path: route }, res => {
            answer.status = res.statusCode;
            answer.headers = res.headers;
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => done('end'));
            res.on('aborted', () => done('aborted'));
            res.on('error', () => done('aborted'));
        });
        req.on('error', () => done('request error'));
        if (waitMs !== undefined) {
            setTimeout(() => {
                done('pending');
                req.destroy();
            }, waitMs);
        }
    });
}
const ROUTE = '/sessions/sess-1/messages/628111@c.us/WA1/media';
const INLINE = Buffer.from('inline copy bytes');
describe('GET /sessions/:sessionId/messages/:chatId/:messageId/media', () => {
    const saved = { ...process.env };
    let dir;
    let media;
    let storage;
    let app;
    let port;
    const archive = { getMedia: jest.fn() };
    const repository = { findOne: jest.fn() };
    async function start(type) {
        storage = new storage_service_1.StorageService({
            get: (key, fallback) => ({ 'storage.type': type, 'storage.localPath': media })[key] ?? fallback,
        });
        await new Promise(resolve => setImmediate(resolve)); // the boot HeadBucket marks the bucket available
        const lids = {
            findPhoneForLid: jest.fn().mockResolvedValue(null),
            findLidsForPhone: jest.fn().mockResolvedValue([]),
        };
        const service = new message_service_1.MessageService(repository, {}, {}, {}, lids, {}, {}, archive, storage);
        const moduleRef = await testing_1.Test.createTestingModule({
            controllers: [message_controller_1.MessageController],
            providers: [
                { provide: message_service_1.MessageService, useValue: service },
                { provide: bulk_message_service_1.BulkMessageService, useValue: {} },
                { provide: chat_scope_service_1.ChatScopeService, useValue: {} },
                // The send routes' replay control; the media route never reaches it.
                { provide: send_idempotency_service_1.SendIdempotencyService, useValue: {} },
            ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.listen(0, '127.0.0.1');
        port = app.getHttpServer().address().port;
    }
    const s3Answers = (answer) => {
        mockSend.mockImplementation((command) => command instanceof client_s3_1.GetObjectCommand ? answer() : Promise.resolve({}));
    };
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-chat-media-'));
        media = path.join(dir, 'media');
        process.env.S3_ACCESS_KEY_ID = 'test';
        process.env.S3_SECRET_ACCESS_KEY = 'test';
        mockSend.mockReset();
        mockSend.mockResolvedValue({});
        archive.getMedia.mockReset();
        archive.getMedia.mockResolvedValue({ path: 'chat-media/sess-1/a.mp4', mimetype: 'video/mp4' });
        repository.findOne.mockReset();
        repository.findOne.mockResolvedValue({
            type: 'video',
            metadata: { media: { mimetype: 'video/mp4', data: INLINE.toString('base64') } },
        });
    });
    afterEach(async () => {
        await app?.close();
        storage?.onModuleDestroy();
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });
    it('serves an archived local file intact, with its length and the attachment headers', async () => {
        const bytes = Buffer.alloc(300 * 1024, 9);
        fs.mkdirSync(path.join(media, 'chat-media', 'sess-1'), { recursive: true });
        fs.writeFileSync(path.join(media, 'chat-media', 'sess-1', 'a.mp4'), bytes);
        await start('local');
        const answer = await get(port, ROUTE);
        expect(answer.outcome).toBe('end');
        expect(answer.status).toBe(200);
        expect(answer.headers['content-type']).toBe('video/mp4');
        expect(answer.headers['x-content-type-options']).toBe('nosniff');
        expect(answer.headers['content-disposition']).toBe('attachment');
        expect(answer.headers['content-length']).toBe(String(bytes.length));
        expect(answer.body.equals(bytes)).toBe(true);
    });
    it('starts answering before the store has delivered the whole archived file', async () => {
        // A 20 MiB archived video (under the 25 MiB archive cap) whose first MiB has arrived.
        const body = new stream_1.PassThrough();
        body.write(Buffer.alloc(1024 * 1024, 1));
        await start('s3');
        s3Answers(() => Promise.resolve({ Body: body, ContentLength: 20 * 1024 * 1024 }));
        const answer = await get(port, ROUTE, 500);
        body.destroy();
        expect(answer.status).toBe(200);
        expect(answer.headers['content-length']).toBe(String(20 * 1024 * 1024));
    });
    it.each([
        ['NoSuchKey', { name: 'NoSuchKey' }],
        ['NotFound', { name: 'NotFound' }],
        ['a 404 answer', { $metadata: { httpStatusCode: 404 } }],
    ])('falls back to the inline copy when the archived S3 object is gone (%s)', async (_label, shape) => {
        await start('s3');
        s3Answers(() => Promise.reject(Object.assign(new Error('gone'), shape)));
        const answer = await get(port, ROUTE);
        expect([answer.status, answer.headers['content-length'], answer.body.toString()]).toEqual([
            200,
            String(INLINE.length),
            INLINE.toString(),
        ]);
    });
    it('falls back to the inline copy when the archived local file is gone', async () => {
        await start('local');
        const answer = await get(port, ROUTE);
        expect([answer.status, answer.body.toString()]).toEqual([200, INLINE.toString()]);
    });
    it('answers 404 for a revoked message', async () => {
        archive.getMedia.mockResolvedValue(null);
        repository.findOne.mockResolvedValue({
            type: 'revoked',
            metadata: { media: { mimetype: 'video/mp4', data: 'QQ==' } },
        });
        await start('local');
        expect((await get(port, ROUTE)).status).toBe(404);
    });
    it('answers a JSON 500 for a store fault while opening, without falling back', async () => {
        await start('s3');
        s3Answers(() => Promise.reject(Object.assign(new Error('SlowDown'), { name: 'SlowDown' })));
        const answer = await get(port, ROUTE);
        expect(answer.status).toBe(500);
        expect(answer.headers['content-disposition']).toBeUndefined();
    });
    it('answers a JSON 500 without the media headers when the store fails before the first byte', async () => {
        const body = new stream_1.PassThrough();
        await start('s3');
        s3Answers(() => Promise.resolve({ Body: body, ContentLength: 1000 }));
        setTimeout(() => body.destroy(new Error('connection reset by the store')), 50);
        const answer = await get(port, ROUTE);
        expect(answer.status).toBe(500);
        expect(answer.headers['content-type']).toMatch(/^application\/json/);
        expect(answer.headers['content-disposition']).toBeUndefined();
        expect(answer.headers['content-length']).not.toBe('1000');
        expect(JSON.parse(answer.body.toString())).toEqual({ statusCode: 500, message: 'Internal server error' });
    });
    it('serves the inline copy with its length when nothing is archived', async () => {
        archive.getMedia.mockResolvedValue(null);
        await start('local');
        const answer = await get(port, ROUTE);
        expect([answer.status, answer.headers['content-length'], answer.body.toString()]).toEqual([
            200,
            String(INLINE.length),
            INLINE.toString(),
        ]);
    });
});
