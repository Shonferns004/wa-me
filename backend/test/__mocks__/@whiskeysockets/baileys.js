"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BufferJSON = exports.proto = exports.DisconnectReason = exports.generateWAMessageFromContent = exports.normalizeMessageContent = exports.getContentType = exports.fetchLatestBaileysVersion = exports.useMultiFileAuthState = void 0;
/**
 * Unit-test stub for @whiskeysockets/baileys (ESM-only package).
 * ts-jest runs in CommonJS mode; this stub prevents "Cannot use import statement outside a module"
 * when any source file importing baileys is pulled into the unit test graph.
 * The e2e boot gate uses jest.mock() inline instead (test/baileys-engine.e2e-spec.ts).
 *
 * Note: the jest moduleNameMapper also redirects the `@whiskeysockets/baileys/(.*)` subpath
 * (including `/package.json`) to this stub, so BaileysPlugin.getEngineLibrary() returns an
 * undefined version in unit tests by design. Production reads the real package.json via the
 * unmapped require.
 */
exports.default = jest.fn();
exports.useMultiFileAuthState = jest.fn();
exports.fetchLatestBaileysVersion = jest.fn();
exports.getContentType = jest.fn();
exports.normalizeMessageContent = jest.fn((c) => c);
exports.generateWAMessageFromContent = jest.fn();
exports.DisconnectReason = { loggedOut: 401 };
/**
 * Protocol constants the adapter reads at RUNTIME (not just as types), mirrored from
 * WAProto/index.d.ts. Values are wire-format enum members, so they are fixed by the protocol
 * rather than by the library version — but keep them in step with the real proto if more are
 * added here.
 */
exports.proto = {
    // namespace proto.PinInChat { enum Type } — WAProto/index.d.ts:10355-10361
    PinInChat: { Type: { UNKNOWN_TYPE: 0, PIN_FOR_ALL: 1, UNPIN_FOR_ALL: 2 } },
};
exports.BufferJSON = {
    replacer: (_k, value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            return { type: 'Buffer', data: Buffer.from(value).toString('base64') };
        }
        if (typeof value === 'object' && value !== null && value.type === 'Buffer') {
            return { type: 'Buffer', data: Buffer.from(value.data).toString('base64') };
        }
        return value;
    },
    reviver: (_, value) => {
        if (typeof value === 'object' && value !== null) {
            const obj = value;
            if (obj.type === 'Buffer' && typeof obj.data === 'string') {
                return Buffer.from(obj.data, 'base64');
            }
            if (!Array.isArray(value)) {
                const keys = Object.keys(value);
                if (keys.length > 0 && keys.every(k => !isNaN(parseInt(k, 10)))) {
                    const values = Object.values(value);
                    if (values.every(v => typeof v === 'number')) {
                        return Buffer.from(values);
                    }
                }
            }
        }
        return value;
    },
};
