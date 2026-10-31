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
const path = __importStar(require("path"));
const path_safety_1 = require("./path-safety");
describe('isPathWithin', () => {
    const root = path.resolve('/srv/app/data');
    it('allows a normal nested path', () => {
        expect((0, path_safety_1.isPathWithin)(root, 'media/file.jpg')).toBe(true);
    });
    it('allows the root itself', () => {
        expect((0, path_safety_1.isPathWithin)(root, '.')).toBe(true);
    });
    it('blocks parent traversal via ".."', () => {
        expect((0, path_safety_1.isPathWithin)(root, '../../etc/passwd')).toBe(false);
    });
    it('blocks an absolute path outside the root', () => {
        expect((0, path_safety_1.isPathWithin)(root, '/etc/passwd')).toBe(false);
    });
    it('blocks a sibling directory that shares the root prefix', () => {
        // "/srv/app/data-evil" must NOT be considered inside "/srv/app/data"
        expect((0, path_safety_1.isPathWithin)('/srv/app/data', '/srv/app/data-evil/x')).toBe(false);
    });
});
describe('isSafeStorageKey', () => {
    it.each([
        'file.jpg',
        'sessionId/messageId.jpg',
        'a/b/c.txt',
        'group:sid:123@g.us.json', // plugin/JID-style keys must survive (':' '@' '.' '-')
    ])('accepts the safe relative key %s', k => {
        expect((0, path_safety_1.isSafeStorageKey)(k)).toBe(true);
    });
    it.each([
        '../evil.txt',
        'a/../../etc/passwd',
        'media/../../../secret',
        '/etc/passwd', // absolute
        '..',
        'a\\..\\b', // backslash traversal (pins the split on '\\' too)
        '', // empty
    ])('rejects the traversing/absolute key %j', k => {
        expect((0, path_safety_1.isSafeStorageKey)(k)).toBe(false);
    });
    it('rejects a key containing a NUL or other control character (it reaches the raw S3 object key)', () => {
        expect((0, path_safety_1.isSafeStorageKey)(`foo${String.fromCharCode(0)}.txt`)).toBe(false); // NUL
        expect((0, path_safety_1.isSafeStorageKey)(`bar${String.fromCharCode(9)}.txt`)).toBe(false); // tab
        expect((0, path_safety_1.isSafeStorageKey)(`baz${String.fromCharCode(31)}.txt`)).toBe(false); // unit separator
    });
});
describe('isSafeSessionName', () => {
    it.each(['my-session', 'Session1', 'abc', 'A-B-2'])('accepts the safe name %j', n => {
        expect((0, path_safety_1.isSafeSessionName)(n)).toBe(true);
    });
    it.each([
        '../../etc', // traversal
        'a/b', // slash
        'a\\b', // backslash
        'a.b', // dot (would traverse / change the auth dir)
        'has space',
        'name@x',
        '', // empty
        undefined,
        null,
        123,
    ])('rejects the unsafe name %j', n => {
        expect((0, path_safety_1.isSafeSessionName)(n)).toBe(false);
    });
});
