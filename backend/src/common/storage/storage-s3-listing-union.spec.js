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
// The S3 SDK is replaced so the bucket answers locally: HeadBucket succeeds and ListObjectsV2 pages
// through the keys the test sets.
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
const storage_service_1 = require("./storage.service");
const { mockSend } = jest.requireMock('@aws-sdk/client-s3');
describe('listing an S3 store unioned with its local fallback dir', () => {
    const saved = { ...process.env };
    let dir;
    let storage;
    // Two pages of archive keys in the bucket, one of which also sits in the local fallback dir.
    const bucketKeys = Array.from({ length: 1200 }, (_, i) => `chat-media/sess-1/k${i}.jpg`);
    const shared = bucketKeys[7];
    const localOnly = 'chat-media/sess-1/written-during-outage.jpg';
    beforeEach(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-union-'));
        const media = path.join(dir, 'media');
        for (const key of [shared, localOnly]) {
            fs.mkdirSync(path.dirname(path.join(media, key)), { recursive: true });
            fs.writeFileSync(path.join(media, key), 'x');
        }
        process.env.S3_ACCESS_KEY_ID = 'test';
        process.env.S3_SECRET_ACCESS_KEY = 'test';
        mockSend.mockReset();
        mockSend.mockImplementation((command) => {
            if (!(command instanceof client_s3_1.ListObjectsV2Command))
                return Promise.resolve({});
            const page = Number(command.input.ContinuationToken ?? 0);
            const keys = bucketKeys.slice(page * 1000, page * 1000 + 1000);
            return Promise.resolve({
                Contents: keys.map(key => ({ Key: `media/${key}` })),
                NextContinuationToken: page * 1000 + 1000 < bucketKeys.length ? String(page + 1) : undefined,
            });
        });
        storage = new storage_service_1.StorageService({
            get: (key, fallback) => ({ 'storage.type': 's3', 'storage.localPath': media })[key] ?? fallback,
        });
        await new Promise(resolve => setImmediate(resolve)); // the boot HeadBucket marks the bucket available
    });
    afterEach(() => {
        storage.onModuleDestroy();
        jest.restoreAllMocks();
        process.env = { ...saved };
        fs.rmSync(dir, { recursive: true, force: true });
    });
    it('lists every key once, from the bucket and from the fallback dir', async () => {
        const listed = [];
        for await (const key of storage.iterateFiles('chat-media/'))
            listed.push(key);
        expect(listed.length).toBe(bucketKeys.length + 1);
        expect([...listed].sort()).toEqual([...bucketKeys, localOnly].sort());
    });
    it('does not keep the bucket keys it streams past', async () => {
        // Calls through: the Sets keep working, the spy only records what goes into them.
        const added = jest.spyOn(Set.prototype, 'add');
        let listed = 0;
        for await (const key of storage.iterateFiles('chat-media/')) {
            void key;
            listed += 1;
        }
        expect(listed).toBe(bucketKeys.length + 1);
        // Only what the fallback dir holds is remembered for the union, never the bucket's own keys.
        const remembered = added.mock.calls.map(([value]) => value);
        expect(remembered.filter(value => typeof value === 'string' && bucketKeys.includes(value) && value !== shared)).toEqual([]);
    });
});
