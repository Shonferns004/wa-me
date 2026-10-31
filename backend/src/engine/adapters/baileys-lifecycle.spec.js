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
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));
jest.mock('@whiskeysockets/baileys', () => ({
    __esModule: true,
    initAuthCreds: jest.fn(),
    makeCacheableSignalKeyStore: jest.fn((keys) => keys),
}));
jest.mock('./baileys-auth-store', () => ({
    useAtomicMultiFileAuthState: jest.fn().mockRejectedValue(new Error('stop after auth load')),
}));
const qrcode = __importStar(require("qrcode"));
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const BaileysLib = __importStar(require("@whiskeysockets/baileys"));
const baileys_auth_store_1 = require("./baileys-auth-store");
const baileys_lifecycle_1 = require("./baileys-lifecycle");
describe('BaileysLifecycle.connect', () => {
    it('loads the auth state through the atomic store with the session auth dir, library and logger', async () => {
        const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        const noCallback = () => undefined;
        const host = {
            authPath: '/data/baileys/session-sess-1',
            logger,
            config: { sessionId: 'sess-1' },
            getOnStateChanged: noCallback,
            getOnError: noCallback,
        };
        await expect(new baileys_lifecycle_1.BaileysLifecycle(host).initialize()).rejects.toThrow('stop after auth load');
        expect(baileys_auth_store_1.useAtomicMultiFileAuthState).toHaveBeenCalledTimes(1);
        const [folder, lib, authLogger] = jest.mocked(baileys_auth_store_1.useAtomicMultiFileAuthState).mock.calls[0];
        expect(folder).toBe(host.authPath);
        expect(lib.initAuthCreds).toBe(BaileysLib.initAuthCreds);
        expect(authLogger).toBe(logger);
    });
});
describe('BaileysLifecycle unlink cleanup', () => {
    function lifecycle() {
        const noCallback = () => undefined;
        const fenceStoredWrites = jest.fn();
        const messageStore = { clearSession: jest.fn().mockResolvedValue(undefined) };
        const host = {
            authPath: '/nonexistent/openwa-lifecycle-spec/session-sess-1',
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            config: { sessionId: 'sess-1', dbSessionId: 'db-1', messageStore },
            liveCalls: new Map(),
            fenceStoredWrites,
            getOnStateChanged: noCallback,
            getOnDisconnected: noCallback,
            getOnError: noCallback,
            getOnCredentialTeardownStarted: noCallback,
        };
        const sock = {
            user: { id: '628999:1@s.whatsapp.net' },
            authState: { creds: { me: { id: '628999:1@s.whatsapp.net' }, account: {} } },
            query: jest.fn().mockResolvedValue({ tag: 'iq' }),
            generateMessageTag: () => 'tag-1',
            end: jest.fn(),
        };
        const engine = new baileys_lifecycle_1.BaileysLifecycle(host);
        engine.sock = sock;
        return { engine, fenceStoredWrites, clearSession: messageStore.clearSession };
    }
    // A message still being processed must not recreate a row of the unlinked account after its store
    // is wiped, so the store writes are fenced first.
    it('fences stored writes before wiping the message store on an API logout', async () => {
        const { engine, fenceStoredWrites, clearSession } = lifecycle();
        await engine.logout();
        expect(clearSession).toHaveBeenCalledWith('db-1');
        expect(fenceStoredWrites).toHaveBeenCalledTimes(1);
        expect(fenceStoredWrites.mock.invocationCallOrder[0]).toBeLessThan(clearSession.mock.invocationCallOrder[0]);
    });
    it('fences stored writes before wiping the message store on a WhatsApp-side logout', async () => {
        const { engine, fenceStoredWrites, clearSession } = lifecycle();
        await engine.handleRemoteLoggedOut();
        expect(clearSession).toHaveBeenCalledWith('db-1');
        expect(fenceStoredWrites).toHaveBeenCalledTimes(1);
        expect(fenceStoredWrites.mock.invocationCallOrder[0]).toBeLessThan(clearSession.mock.invocationCallOrder[0]);
    });
});
describe('BaileysLifecycle QR refresh', () => {
    // Exercise the promise overload used by the adapter, rather than qrcode's
    // callback overload (whose return type is void).
    const renderQr = jest.mocked(qrcode.toDataURL);
    function fixture() {
        const onQRCode = jest.fn(), noCallback = () => undefined;
        const host = {
            authPath: '/fixture',
            config: { sessionId: 'fixture' },
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            getOnQRCode: () => onQRCode,
            getOnStateChanged: noCallback,
            getOnError: noCallback,
        };
        const lifecycle = new baileys_lifecycle_1.BaileysLifecycle(host);
        const renderer = lifecycle;
        renderer.sock = { ws: { isOpen: true } };
        renderer.status = whatsapp_engine_interface_1.EngineStatus.QR_READY;
        renderer.qrCode = 'retired-image';
        return { renderer, onQRCode };
    }
    it('clears a retired image immediately and ignores a slow older render', async () => {
        const { renderer, onQRCode } = fixture();
        let finishOld, finishNew;
        renderQr
            .mockImplementationOnce(() => new Promise(resolve => {
            finishOld = resolve;
        }))
            .mockImplementationOnce(() => new Promise(resolve => {
            finishNew = resolve;
        }));
        const old = renderer.handleQrCode('retired-secret');
        expect(renderer.qrCode).toBeNull();
        const fresh = renderer.handleQrCode('current-secret');
        expect(renderer.qrCode).toBeNull();
        finishNew('current-image');
        await fresh;
        finishOld('retired-image');
        await old;
        expect(renderer.qrCode).toBe('current-image');
        expect(onQRCode).toHaveBeenCalledTimes(1);
        expect(onQRCode).toHaveBeenCalledWith('current-image');
    });
    it.each([whatsapp_engine_interface_1.EngineStatus.AUTHENTICATING, whatsapp_engine_interface_1.EngineStatus.READY])('does not publish a pending render after linking enters %s', async (status) => {
        const { renderer, onQRCode } = fixture();
        let finish;
        renderQr.mockImplementationOnce(() => new Promise(resolve => {
            finish = resolve;
        }));
        const pending = renderer.handleQrCode('pending');
        renderer.status = status;
        finish('expired-image');
        await pending;
        expect(renderer.qrCode).toBeNull();
        expect(onQRCode).not.toHaveBeenCalled();
    });
    it('discards a pending render after the socket acquires a pairing-code identity', async () => {
        const { renderer, onQRCode } = fixture();
        let finish;
        renderQr.mockImplementationOnce(() => new Promise(resolve => {
            finish = resolve;
        }));
        const pending = renderer.handleQrCode('pending');
        renderer.sock.user = { id: 'fixture@s.whatsapp.net' };
        finish('expired-image');
        await pending;
        expect(renderer.qrCode).toBeNull();
        expect(onQRCode).not.toHaveBeenCalled();
    });
});
describe('BaileysLifecycle proxy fetch dispatcher', () => {
    function lifecycle() {
        const noCallback = () => undefined;
        const host = {
            authPath: '/nonexistent/openwa-lifecycle-spec/session-sess-1',
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            config: {
                sessionId: 'sess-1',
                dbSessionId: 'db-1',
                proxyUrl: 'http://user:pass@proxy.example:8080',
                messageStore: { clearSession: jest.fn().mockResolvedValue(undefined) },
            },
            liveCalls: new Map(),
            fenceStoredWrites: jest.fn(),
            getOnStateChanged: noCallback,
            getOnDisconnected: noCallback,
            getOnError: noCallback,
            getOnCredentialTeardownStarted: noCallback,
        };
        const engine = new baileys_lifecycle_1.BaileysLifecycle(host);
        engine.sock = {
            user: { id: '628999:1@s.whatsapp.net' },
            authState: { creds: { me: { id: '628999:1@s.whatsapp.net' }, account: {} } },
            query: jest.fn().mockResolvedValue({ tag: 'iq' }),
            generateMessageTag: () => 'tag-1',
            end: jest.fn(),
        };
        return engine;
    }
    // The pooled proxy tunnels must not outlive the session: teardown closes the dispatcher (gracefully,
    // so a request already in progress still finishes) and forgets it, so a later fetch gets a fresh one.
    it.each([
        ['disconnect', (engine) => engine.disconnect()],
        ['destroy', (engine) => engine.destroy()],
        ['logout', (engine) => engine.logout()],
        [
            'a failed logout',
            async (engine) => {
                jest.mocked(engine.sock.query).mockRejectedValue(new Error('timed out'));
                await expect(engine.logout()).rejects.toThrow('timed out');
            },
        ],
        [
            'a WhatsApp-side logout',
            (engine) => engine.handleRemoteLoggedOut(),
        ],
    ])('closes the dispatcher on %s and builds a fresh one afterwards', async (_name, teardown) => {
        const engine = lifecycle();
        const dispatcher = engine.fetchDispatcher();
        if (!dispatcher)
            throw new Error('Expected a proxy dispatcher');
        const close = jest.spyOn(dispatcher, 'close');
        const destroy = jest.spyOn(dispatcher, 'destroy');
        await teardown(engine);
        expect(close).toHaveBeenCalledTimes(1);
        expect(destroy).not.toHaveBeenCalled();
        const fresh = engine.fetchDispatcher();
        expect(fresh).toBeDefined();
        expect(fresh).not.toBe(dispatcher);
        await fresh?.close();
    });
    describe('teardown while connecting', () => {
        const settle = () => new Promise(resolve => setImmediate(resolve));
        function connecting() {
            const engine = lifecycle();
            engine.sock = null;
            let releaseAuth;
            jest.mocked(baileys_auth_store_1.useAtomicMultiFileAuthState).mockImplementationOnce(() => new Promise(resolve => {
                releaseAuth = resolve;
            }));
            const resolver = engine.versionResolver;
            const resolve = jest.spyOn(resolver, 'resolve');
            const authRequested = async () => {
                while (!releaseAuth)
                    await settle();
            };
            const loadAuth = () => releaseAuth?.({ state: { creds: {}, keys: {} }, saveCreds: jest.fn() });
            return { engine, resolve, authRequested, loadAuth };
        }
        // Opening the auth state creates the session's directory, which a deleted session no longer has.
        it('does not open the auth state when the session stops while the library loads', async () => {
            const engine = lifecycle();
            engine.sock = null;
            let finishLibrary = () => undefined;
            jest.spyOn(engine, 'loadLib').mockReturnValueOnce(new Promise(resolve => {
                finishLibrary = resolve;
            }));
            jest.mocked(baileys_auth_store_1.useAtomicMultiFileAuthState).mockClear();
            const init = engine.initialize();
            await engine.destroy();
            finishLibrary(BaileysLib);
            await init;
            expect(baileys_auth_store_1.useAtomicMultiFileAuthState).not.toHaveBeenCalled();
            expect(engine.sock).toBeNull();
        });
        // The teardown closed the only dispatcher there was; a lookup after it would build one nothing
        // closes and send a stopped session's requests through its proxy.
        it('skips the version lookup when the session stops while its auth state loads', async () => {
            const { engine, resolve, authRequested, loadAuth } = connecting();
            const init = engine.initialize();
            await authRequested();
            await engine.disconnect();
            loadAuth();
            await init;
            expect(resolve).not.toHaveBeenCalled();
            expect(engine.dispatcher).toBeUndefined();
            expect(engine.sock).toBeNull();
        });
        it('aborts the version lookup when the session stops during it', async () => {
            const { engine, resolve, authRequested, loadAuth } = connecting();
            let signal;
            let finish;
            resolve.mockImplementationOnce((_lib, options) => new Promise(done => {
                signal = options?.signal;
                finish = done;
            }));
            const init = engine.initialize();
            await authRequested();
            loadAuth();
            while (!finish)
                await settle();
            expect(signal?.aborted).toBe(false);
            await engine.destroy();
            expect(signal?.aborted).toBe(true);
            finish([2, 3000, 1]);
            await init;
            expect(engine.sock).toBeNull();
        });
    });
});
