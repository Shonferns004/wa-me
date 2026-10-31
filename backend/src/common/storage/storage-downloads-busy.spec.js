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
// The S3 SDK is replaced so the bucket answers locally: HeadBucket succeeds and every GetObject answers a
// body that never ends, so each opened download keeps its place.
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
const chat_scope_service_1 = require("../../modules/auth/chat-scope.service");
const bulk_message_service_1 = require("../../modules/message/bulk-message.service");
const send_idempotency_service_1 = require("../../modules/message/idempotency/send-idempotency.service");
const message_controller_1 = require("../../modules/message/message.controller");
const message_service_1 = require("../../modules/message/message.service");
const status_controller_1 = require("../../modules/status/status.controller");
const status_service_1 = require("../../modules/status/status.service");
const storage_service_1 = require("./storage.service");
const { mockSend } = jest.requireMock('@aws-sdk/client-s3');
function get(port, route) {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: route }, res => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        });
        req.on('error', reject);
    });
}
describe('S3 media download routes once every download place is held', () => {
    const saved = { ...process.env };
    const bodies = [];
    let dir;
    let storage;
    let app;
    let port;
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-downloads-busy-'));
        process.env.S3_ACCESS_KEY_ID = 'test';
        process.env.S3_SECRET_ACCESS_KEY = 'test';
        mockSend.mockReset();
        mockSend.mockImplementation((command) => {
            if (!(command instanceof client_s3_1.GetObjectCommand))
                return Promise.resolve({});
            const body = new stream_1.PassThrough();
            bodies.push(body);
            return Promise.resolve({ Body: body, ContentLength: 1000 });
        });
        const media = path.join(dir, 'media');
        storage = new storage_service_1.StorageService({
            get: (key, fallback) => ({ 'storage.type': 's3', 'storage.localPath': media })[key] ?? fallback,
        });
        await new Promise(resolve => setImmediate(resolve)); // the boot HeadBucket marks the bucket available
        const statusStore = {
            getMedia: jest.fn().mockResolvedValue({ path: 'statuses/sess-1/a.mp4', mimetype: 'video/mp4' }),
        };
        const archive = {
            getMedia: jest.fn().mockResolvedValue({ path: 'chat-media/sess-1/a.mp4', mimetype: 'video/mp4' }),
        };
        const lids = {
            findPhoneForLid: jest.fn().mockResolvedValue(null),
            findLidsForPhone: jest.fn().mockResolvedValue([]),
        };
        const statusService = new status_service_1.StatusService({}, {}, statusStore, storage, {});
        const messageService = new message_service_1.MessageService({ findOne: jest.fn().mockResolvedValue(null) }, {}, {}, {}, lids, {}, {}, archive, storage);
        const moduleRef = await testing_1.Test.createTestingModule({
            controllers: [status_controller_1.StatusController, message_controller_1.MessageController],
            providers: [
                { provide: status_service_1.StatusService, useValue: statusService },
                { provide: message_service_1.MessageService, useValue: messageService },
                { provide: bulk_message_service_1.BulkMessageService, useValue: {} },
                { provide: chat_scope_service_1.ChatScopeService, useValue: {} },
                { provide: send_idempotency_service_1.SendIdempotencyService, useValue: {} },
            ],
        }).compile();
        app = moduleRef.createNestApplication({ logger: false });
        await app.listen(0, '127.0.0.1');
        port = app.getHttpServer().address().port;
    });
    afterEach(async () => {
        for (const body of bodies.splice(0))
            body.destroy();
        await app?.close();
        storage?.onModuleDestroy();
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });
    async function holdEveryPlace() {
        for (let i = 0; i < storage_service_1.S3_MAX_OPEN_DOWNLOADS; i++)
            await storage.openFile(`statuses/sess-1/held${i}.mp4`);
    }
    it.each([
        ['status media', '/sessions/sess-1/status/ST1/media'],
        ['chat media', '/sessions/sess-1/messages/628111@c.us/WA1/media'],
    ])('refuses %s with a 503 that says when to retry', async (_name, route) => {
        await holdEveryPlace();
        const answer = await get(port, route);
        expect([answer.status, answer.headers['retry-after']]).toEqual([503, '1']);
    });
    it('sends no Retry-After with another store failure', async () => {
        mockSend.mockImplementation((command) => command instanceof client_s3_1.GetObjectCommand
            ? Promise.reject(Object.assign(new Error('SlowDown'), { name: 'SlowDown' }))
            : Promise.resolve({}));
        const answer = await get(port, '/sessions/sess-1/status/ST1/media');
        expect([answer.status, answer.headers['retry-after']]).toEqual([500, undefined]);
    });
});
