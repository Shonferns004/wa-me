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
const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({ send: mockSend })),
    HeadBucketCommand: jest.fn(),
    CreateBucketCommand: jest.fn(),
    ListObjectsV2Command: jest.fn(),
    GetObjectCommand: jest.fn(),
    PutObjectCommand: jest.fn(),
    DeleteObjectCommand: jest.fn(),
}));
const client_s3_1 = require("@aws-sdk/client-s3");
const stream_1 = require("stream");
const env_validation_1 = require("../../config/env.validation");
const s3_key_prefix_1 = require("./s3-key-prefix");
const storage_service_1 = require("./storage.service");
/** The input object of every construction of a mocked AWS command. */
function inputs(command) {
    return command.mock.calls.map(([input]) => input);
}
describe('normalizeS3KeyPrefix', () => {
    it.each([
        [undefined, 'media/'],
        ['', 'media/'],
        ['   ', 'media/'],
        ['staging', 'staging/'],
        ['staging/', 'staging/'],
        [' tenants/prod// ', 'tenants/prod/'],
    ])('%j gives %j', (raw, root) => {
        expect((0, s3_key_prefix_1.normalizeS3KeyPrefix)(raw)).toBe(root);
    });
    it.each(['/', '//', '/abs', '../x', 'a/../b', 'a\u0000b', '.', './', 'a//b', 'a/./b'])('rejects %j', raw => {
        expect((0, s3_key_prefix_1.normalizeS3KeyPrefix)(raw)).toBeNull();
    });
    it('fails boot on an unsafe S3_KEY_PREFIX and accepts a relative one', () => {
        expect(() => (0, env_validation_1.validateEnv)({ S3_KEY_PREFIX: '../x' })).toThrow(/S3_KEY_PREFIX/);
        expect(() => (0, env_validation_1.validateEnv)({ S3_KEY_PREFIX: '/abs' })).toThrow(/S3_KEY_PREFIX/);
        expect(() => (0, env_validation_1.validateEnv)({ S3_KEY_PREFIX: '/' })).toThrow(/S3_KEY_PREFIX/);
        expect(() => (0, env_validation_1.validateEnv)({ S3_KEY_PREFIX: 'tenants//prod' })).toThrow(/S3_KEY_PREFIX/);
        expect(() => (0, env_validation_1.validateEnv)({ S3_KEY_PREFIX: 'staging/' })).not.toThrow();
        expect(() => (0, env_validation_1.validateEnv)({ S3_KEY_PREFIX: '' })).not.toThrow();
    });
});
describe('StorageService S3 key prefix', () => {
    let tmpRoot;
    let svc;
    beforeEach(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-s3-prefix-'));
        jest.clearAllMocks();
        mockSend.mockResolvedValue({});
        delete process.env.S3_KEY_PREFIX;
    });
    afterEach(() => {
        svc?.onModuleDestroy();
        svc = undefined;
        delete process.env.S3_KEY_PREFIX;
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
    async function makeService(keyPrefix) {
        const config = {
            get: (key) => {
                if (key === 'storage.type')
                    return 's3';
                if (key === 'storage.localPath')
                    return path.join(tmpRoot, 'media');
                if (key === 'storage.s3')
                    return { accessKeyId: 'k', secretAccessKey: 's', keyPrefix };
                return undefined;
            },
        };
        svc = new storage_service_1.StorageService(config);
        await new Promise(resolve => setImmediate(resolve));
        expect(svc.s3Available).toBe(true);
        return svc;
    }
    it('routes put, get and delete through a custom prefix, adding the missing trailing slash', async () => {
        mockSend.mockImplementation((cmd) => Promise.resolve(cmd instanceof client_s3_1.GetObjectCommand ? { Body: stream_1.Readable.from([Buffer.from('x')]) } : {}));
        const storage = await makeService('staging');
        await storage.putFile('x.bin', Buffer.from('x'));
        await storage.getFile('x.bin');
        await storage.deleteFile('x.bin');
        expect(inputs(client_s3_1.PutObjectCommand)[0].Key).toBe('staging/x.bin');
        expect(inputs(client_s3_1.GetObjectCommand)[0].Key).toBe('staging/x.bin');
        expect(inputs(client_s3_1.DeleteObjectCommand)[0].Key).toBe('staging/x.bin');
    });
    it('S3_KEY_PREFIX in the environment wins over the config value', async () => {
        process.env.S3_KEY_PREFIX = 'from-env/';
        const storage = await makeService('from-config');
        await storage.putFile('x.bin', Buffer.from('x'));
        expect(inputs(client_s3_1.PutObjectCommand)[0].Key).toBe('from-env/x.bin');
    });
    it('lists under the prefix and never yields a key outside it', async () => {
        mockSend.mockImplementation((cmd) => Promise.resolve(cmd instanceof client_s3_1.ListObjectsV2Command
            ? {
                Contents: [
                    { Key: 'staging/chat-media/a', Size: 3 },
                    { Key: 'staging-old/chat-media/b', Size: 5 },
                    { Key: 'media/chat-media/c', Size: 7 },
                ],
            }
            : {}));
        const storage = await makeService('staging');
        const seen = [];
        for await (const key of storage.iterateFiles('chat-media/'))
            seen.push(key);
        expect(inputs(client_s3_1.ListObjectsV2Command)[0].Prefix).toBe('staging/chat-media/');
        expect(seen).toEqual(['chat-media/a']);
        const { count, sizeBytes } = await storage.getFileCount();
        expect(inputs(client_s3_1.ListObjectsV2Command)[1].Prefix).toBe('staging/');
        expect({ count, sizeBytes }).toEqual({ count: 1, sizeBytes: 3 });
    });
    it.each([undefined, '', '  '])('keeps the media/ root when the prefix is %j', async (keyPrefix) => {
        const storage = await makeService(keyPrefix);
        await storage.putFile('x.bin', Buffer.from('x'));
        expect(inputs(client_s3_1.PutObjectCommand)[0].Key).toBe('media/x.bin');
    });
});
describe('S3_KEY_PREFIX sharing guidance', () => {
    // Listing uses the root as a plain key prefix, so a nested root (media/ and media/staging/) puts
    // the inner deployment's objects in the outer one's stats, export and orphan sweeps.
    it.each(['.env.example', 'docs/10-devops-infrastructure.md'])('%s rules out nested prefixes', file => {
        const text = fs
            .readFileSync(path.join(__dirname, '../../..', file), 'utf8')
            .replace(/^\s*# ?/gm, '')
            .replace(/\s+/g, ' ');
        expect(text).toContain('neither may start with the other');
    });
});
