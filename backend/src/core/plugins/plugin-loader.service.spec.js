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
const path = __importStar(require("path"));
const plugin_loader_service_1 = require("./plugin-loader.service");
const plugin_capability_context_1 = require("./plugin-capability-context");
/** Regression lock: a plugin's manifest.main must not escape its plugin directory. */
describe('resolvePluginMainPath', () => {
    const dir = '/app/data/plugins';
    it('allows a normal entry inside the plugin directory', () => {
        expect((0, plugin_loader_service_1.resolvePluginMainPath)(dir, 'my-plugin', 'index.js')).toBe(path.resolve(dir, 'my-plugin', 'index.js'));
        expect((0, plugin_loader_service_1.resolvePluginMainPath)(dir, 'my-plugin', 'dist/main.js')).toBe(path.resolve(dir, 'my-plugin', 'dist/main.js'));
    });
    it('rejects a path-traversal escape (../../)', () => {
        expect(() => (0, plugin_loader_service_1.resolvePluginMainPath)(dir, 'my-plugin', '../../etc/passwd')).toThrow(/escapes/);
    });
    it('rejects an absolute path', () => {
        expect(() => (0, plugin_loader_service_1.resolvePluginMainPath)(dir, 'my-plugin', '/etc/passwd')).toThrow(/escapes/);
    });
    it('rejects climbing into a sibling plugin', () => {
        expect(() => (0, plugin_loader_service_1.resolvePluginMainPath)(dir, 'my-plugin', '../other-plugin/evil.js')).toThrow(/escapes/);
    });
});
/**
 * Untrusted plugins run in a worker thread; the worker must NOT inherit the host's secrets. The
 * worker env is an allowlist, not a copy of process.env.
 */
describe('buildSandboxWorkerEnv', () => {
    it('forwards only the allowlisted vars and drops host secrets', () => {
        const env = (0, plugin_loader_service_1.buildSandboxWorkerEnv)({
            NODE_ENV: 'production',
            TZ: 'UTC',
            NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
            API_MASTER_KEY: 'super-secret',
            API_KEY_PEPPER: 'pepper',
            DATABASE_PASSWORD: 'dbpw',
            DATABASE_URL: 'postgres://u:p@host/db',
            REDIS_URL: 'redis://u:p@host',
            DOCKER_HOST: 'tcp://0.0.0.0:2375',
        });
        expect(env.NODE_ENV).toBe('production');
        expect(env.TZ).toBe('UTC');
        expect(env.NODE_EXTRA_CA_CERTS).toBe('/certs/ca.pem');
        // Host secrets must never reach an untrusted plugin.
        expect(env.API_MASTER_KEY).toBeUndefined();
        expect(env.API_KEY_PEPPER).toBeUndefined();
        expect(env.DATABASE_PASSWORD).toBeUndefined();
        expect(env.DATABASE_URL).toBeUndefined();
        expect(env.REDIS_URL).toBeUndefined();
        expect(env.DOCKER_HOST).toBeUndefined();
    });
    it('omits allowlisted keys that are unset rather than emitting undefined entries', () => {
        const env = (0, plugin_loader_service_1.buildSandboxWorkerEnv)({ NODE_ENV: 'development' });
        expect(env.NODE_ENV).toBe('development');
        expect('TZ' in env).toBe(false);
        expect('NODE_EXTRA_CA_CERTS' in env).toBe(false);
    });
    it('defaults NODE_ENV to production when the host has none', () => {
        expect((0, plugin_loader_service_1.buildSandboxWorkerEnv)({}).NODE_ENV).toBe('production');
    });
});
/** conversation.send media types must route to the matching MessageService method (not a copy-paste sibling). */
describe('dispatchConversationMedia', () => {
    const svc = () => ({
        sendImage: jest.fn().mockResolvedValue({ messageId: 'i' }),
        sendVideo: jest.fn().mockResolvedValue({ messageId: 'v' }),
        sendAudio: jest.fn().mockResolvedValue({ messageId: 'a' }),
        sendDocument: jest.fn().mockResolvedValue({ messageId: 'd' }),
    });
    const opts = (type) => ({
        chatId: 'c@c.us',
        url: 'https://cdn.example/m',
        caption: 'cap',
        type,
    });
    it.each([
        ['image', 'sendImage'],
        ['video', 'sendVideo'],
        ['audio', 'sendAudio'],
        ['file', 'sendDocument'],
    ])('routes %s to %s with a url+caption DTO (no ptt)', async (type, method) => {
        const s = svc();
        await (0, plugin_capability_context_1.dispatchConversationMedia)(s, 's', opts(type));
        expect(s[method]).toHaveBeenCalledWith('s', { chatId: 'c@c.us', url: 'https://cdn.example/m', caption: 'cap' });
        // No sibling method is invoked for the wrong type.
        for (const other of ['sendImage', 'sendVideo', 'sendAudio', 'sendDocument']) {
            if (other !== method)
                expect(s[other]).not.toHaveBeenCalled();
        }
    });
    it("routes 'voice' to sendAudio with ptt:true so it renders as a WhatsApp voice note", async () => {
        const s = svc();
        await (0, plugin_capability_context_1.dispatchConversationMedia)(s, 's', { chatId: 'c@c.us', url: 'https://cdn.example/n.ogg', type: 'voice' });
        expect(s.sendAudio).toHaveBeenCalledWith('s', {
            chatId: 'c@c.us',
            url: 'https://cdn.example/n.ogg',
            caption: undefined,
            ptt: true,
        });
        for (const other of ['sendImage', 'sendVideo', 'sendDocument']) {
            expect(s[other]).not.toHaveBeenCalled();
        }
    });
});
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const plugin_loader_service_2 = require("./plugin-loader.service");
const config_1 = require("@nestjs/config");
const hooks_1 = require("../hooks");
const plugin_storage_service_1 = require("./plugin-storage.service");
const plugin_interfaces_1 = require("./plugin.interfaces");
const configuration_1 = __importDefault(require("../../config/configuration"));
const search_provider_registry_1 = require("../../modules/search/search-provider.registry");
const worker_thread_channel_1 = require("./sandbox/worker-thread-channel");
const plugin_worker_host_1 = require("./sandbox/plugin-worker-host");
describe('PluginLoaderService.registerBuiltInPlugin config', () => {
    function makeLoader() {
        const configService = { get: jest.fn().mockReturnValue(undefined) };
        const pluginStorage = {
            getPluginEntry: jest.fn().mockReturnValue(undefined),
            setPluginEntry: jest.fn(),
            getPluginConfig: jest.fn().mockReturnValue(null),
            getPluginSessions: jest.fn().mockReturnValue(undefined),
            getPluginSessionConfig: jest.fn().mockReturnValue(undefined),
        };
        return new plugin_loader_service_2.PluginLoaderService(configService, new hooks_1.HookManager(), pluginStorage, {});
    }
    const manifest = {
        id: 'cfg-test',
        name: 'Cfg Test',
        version: '1.0.0',
        type: plugin_interfaces_1.PluginType.ENGINE,
        main: 'index.js',
    };
    const instance = {};
    it('stores the supplied config on the plugin instance', () => {
        const loader = makeLoader();
        loader.registerBuiltInPlugin(manifest, instance, { sessionDataPath: '/d', puppeteer: { headless: false } });
        expect(loader.getPlugin('cfg-test')?.config).toEqual({ sessionDataPath: '/d', puppeteer: { headless: false } });
    });
    it('defaults to an empty config when none is supplied (back-compat)', () => {
        const loader = makeLoader();
        loader.registerBuiltInPlugin(manifest, instance);
        expect(loader.getPlugin('cfg-test')?.config).toEqual({});
    });
});
describe('PluginLoaderService — enable/config persistence', () => {
    let tmpDir;
    let config;
    let storage;
    let loader;
    const manifest = {
        id: 'persist-test',
        name: 'Persist Test',
        version: '1.0.0',
        type: plugin_interfaces_1.PluginType.EXTENSION,
        main: 'index.js',
    };
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-plugin-'));
        config = { get: (k) => (k === 'dataDir' ? tmpDir : undefined) };
        storage = new plugin_storage_service_1.PluginStorageService(config);
        loader = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage, {});
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('creates a complete INSTALLED registry entry on register so a status write persists across a restart', () => {
        loader.registerBuiltInPlugin(manifest, {}, { apiKey: 'default' });
        const entry = storage.getPluginEntry('persist-test');
        expect(entry).toMatchObject({
            id: 'persist-test',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            builtIn: true,
        });
        // The status write now lands (previously a silent no-op because no entry existed).
        storage.setPluginStatus('persist-test', plugin_interfaces_1.PluginStatus.ENABLED);
        // Durable: a fresh storage instance re-reads registry.json (simulates a restart).
        expect(new plugin_storage_service_1.PluginStorageService(config).getPluginStatus('persist-test')).toBe(plugin_interfaces_1.PluginStatus.ENABLED);
    });
    it('keeps using live env config for a built-in across restarts (the first snapshot must not freeze it)', () => {
        // Boot 1: register with one env-derived default, no operator edit.
        loader.registerBuiltInPlugin(manifest, {}, { execPath: '/old/chromium', headless: true });
        // Boot 2: env changed (e.g. operator set PUPPETEER_EXECUTABLE_PATH on a new image) → the live value wins.
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage2, {});
        loader2.registerBuiltInPlugin(manifest, {}, { execPath: '/new/chromium', headless: true });
        expect(loader2.getPlugin('persist-test')?.config).toEqual({ execPath: '/new/chromium', headless: true });
    });
    it('reports a re-registered plugin as installed: registering never runs it, and the registry agrees', () => {
        loader.registerBuiltInPlugin(manifest, {}, {});
        storage.setPluginStatus('persist-test', plugin_interfaces_1.PluginStatus.ENABLED); // operator enabled it
        // Restart: re-register the built-in.
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage2, {});
        loader2.registerBuiltInPlugin(manifest, {}, {});
        // Runtime is INSTALLED (registering does not run the lifecycle) AND the registry agrees, so there
        // is no enabled/installed divergence. Restoring an operator-enabled plugin is a separate step that
        // happens at bootstrap and skips built-ins — see plugin-restore-on-boot.spec.ts (#856).
        expect(loader2.getPlugin('persist-test')?.status).toBe(plugin_interfaces_1.PluginStatus.INSTALLED);
        expect(storage2.getPluginStatus('persist-test')).toBe(plugin_interfaces_1.PluginStatus.INSTALLED);
    });
    it('writes registry.json without group/other access (plugin config can hold secrets)', () => {
        loader.registerBuiltInPlugin(manifest, {}, { apiKey: 'secret' });
        const registryPath = path.join(tmpDir, 'plugins', 'registry.json');
        expect(fs.existsSync(registryPath)).toBe(true);
        if (process.platform !== 'win32') {
            const mode = fs.statSync(registryPath).mode & 0o777;
            expect(mode & 0o077).toBe(0);
        }
    });
    it('restores the operator config on the next load instead of resetting to the default', () => {
        loader.registerBuiltInPlugin(manifest, {}, { apiKey: 'default' });
        loader.updatePluginConfig('persist-test', { apiKey: 'operator-secret' });
        expect(storage.getPluginConfig('persist-test')).toEqual({ apiKey: 'operator-secret' });
        // Restart: re-register the built-in with its default config — the persisted operator config wins.
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage2, {});
        loader2.registerBuiltInPlugin(manifest, {}, { apiKey: 'default' });
        expect(loader2.getPlugin('persist-test')?.config).toEqual({ apiKey: 'operator-secret' });
    });
    it('persists only the keys a config update set, so other env-derived keys stay live', () => {
        loader.registerBuiltInPlugin(manifest, {}, { execPath: '/old/chromium', headless: true });
        loader.updatePluginConfig('persist-test', { apiKey: 'operator-secret' });
        expect(loader.getPlugin('persist-test')?.config).toEqual({
            execPath: '/old/chromium',
            headless: true,
            apiKey: 'operator-secret',
        });
        expect(storage.getPluginConfig('persist-test')).toEqual({ apiKey: 'operator-secret' });
        // Restart with a changed env value: it wins, and the operator's key is still applied.
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage2, {});
        loader2.registerBuiltInPlugin(manifest, {}, { execPath: '/new/chromium', headless: true });
        expect(loader2.getPlugin('persist-test')?.config).toEqual({
            execPath: '/new/chromium',
            headless: true,
            apiKey: 'operator-secret',
        });
    });
});
describe('PluginLoaderService — engine mutual exclusion', () => {
    let tmpDir;
    let storage;
    const engineManifest = (id) => ({
        id,
        name: id,
        version: '1.0.0',
        type: plugin_interfaces_1.PluginType.ENGINE,
        main: 'index.js',
    });
    const makeLoader = (activeEngine) => {
        const config = {
            get: (k) => (k === 'engine.type' ? activeEngine : k === 'dataDir' ? tmpDir : undefined),
        };
        return new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage, {});
    };
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-eng-'));
        storage = new plugin_storage_service_1.PluginStorageService({
            get: (k) => (k === 'dataDir' ? tmpDir : undefined),
        });
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('rejects enabling an engine that is not the configured active engine', async () => {
        const loader = makeLoader('whatsapp-web.js');
        loader.registerBuiltInPlugin(engineManifest('baileys'), {});
        await expect(loader.enablePlugin('baileys')).rejects.toThrow(/active engine/i);
        // Rejected up front — the plugin stays INSTALLED (not flipped to ERROR).
        expect(loader.getPlugin('baileys')?.status).toBe(plugin_interfaces_1.PluginStatus.INSTALLED);
    });
    it('allows enabling the configured active engine', async () => {
        const loader = makeLoader('baileys');
        loader.registerBuiltInPlugin(engineManifest('baileys'), {});
        await loader.enablePlugin('baileys');
        expect(loader.getPlugin('baileys')?.status).toBe(plugin_interfaces_1.PluginStatus.ENABLED);
    });
});
describe('PluginLoaderService — enable concurrency', () => {
    let tmpDir;
    let loader;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-enable-'));
        const config = { get: (k) => (k === 'dataDir' ? tmpDir : undefined) };
        loader = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('rejects a racing second enable instead of double-running onEnable', async () => {
        let enableCount = 0;
        const instance = {
            onEnable: async () => {
                enableCount++;
                await new Promise(resolve => setTimeout(resolve, 25)); // keep the first enable in flight
            },
        };
        loader.registerBuiltInPlugin({ id: 'race-plg', name: 'Race', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.js' }, instance);
        const results = await Promise.allSettled([loader.enablePlugin('race-plg'), loader.enablePlugin('race-plg')]);
        // The first claims the lock and runs onEnable once; the second is rejected before any await.
        expect(enableCount).toBe(1);
        const rejected = results.filter((r) => r.status === 'rejected');
        expect(rejected).toHaveLength(1);
        expect(String(rejected[0].reason)).toMatch(/already being enabled/i);
        expect(loader.getPlugin('race-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.ENABLED);
    });
});
describe('PluginLoaderService — graceful shutdown (onModuleDestroy)', () => {
    let tmpDir;
    let loader;
    const ext = (id) => ({
        id,
        name: id,
        version: '1.0.0',
        type: plugin_interfaces_1.PluginType.EXTENSION,
        main: 'index.js',
    });
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-shutdown-'));
        const config = { get: (k) => (k === 'dataDir' ? tmpDir : undefined) };
        loader = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('runs onDisable for every enabled plugin on shutdown, best-effort past a failure', async () => {
        const okDisable = jest.fn(() => Promise.resolve());
        loader.registerBuiltInPlugin(ext('bad-plg'), {
            onDisable: () => Promise.reject(new Error('flush failed')),
        });
        loader.registerBuiltInPlugin(ext('ok-plg'), { onDisable: okDisable });
        await loader.enablePlugin('bad-plg');
        await loader.enablePlugin('ok-plg');
        await expect(loader.onModuleDestroy()).resolves.toBeUndefined();
        // The failing plugin's onDisable error didn't block the other from being disabled.
        expect(okDisable).toHaveBeenCalledTimes(1);
        expect(loader.getPlugin('ok-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.DISABLED);
    });
    it('waits for an enable already in flight and disables it, so its onDisable still runs', async () => {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const onDisable = jest.fn(() => Promise.resolve());
        loader.registerBuiltInPlugin(ext('slow-plg'), { onEnable: () => gate, onDisable });
        const enabling = loader.enablePlugin('slow-plg');
        const destroying = loader.onModuleDestroy();
        release();
        await enabling;
        await destroying;
        expect(onDisable).toHaveBeenCalledTimes(1);
        expect(loader.getPlugin('slow-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.DISABLED);
    });
    // Shutdown waits on every enable it has recorded, so a settled one left in the set is waited on for the
    // life of the process and the set grows by one entry per enable.
    it.each([
        ['succeeds', () => Promise.resolve()],
        ['fails', () => Promise.reject(new Error('onEnable failed'))],
    ])('stops tracking an enable once it %s', async (_outcome, onEnable) => {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        loader.registerBuiltInPlugin(ext('tracked-plg'), { onEnable: () => gate.then(onEnable) });
        const enabling = loader.enablePlugin('tracked-plg').catch(() => undefined);
        expect(loader['pendingEnables'].size).toBe(1);
        release();
        await enabling;
        expect(loader['pendingEnables'].size).toBe(0);
    });
    it('disables running plugins without waiting for an enable still in flight', async () => {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const runningDisable = jest.fn(() => Promise.resolve());
        const slowDisable = jest.fn(() => Promise.resolve());
        loader.registerBuiltInPlugin(ext('running-plg'), { onDisable: runningDisable });
        loader.registerBuiltInPlugin(ext('slow-plg'), { onEnable: () => gate, onDisable: slowDisable });
        await loader.enablePlugin('running-plg');
        const enabling = loader.enablePlugin('slow-plg');
        const destroying = loader.onModuleDestroy();
        await new Promise(resolve => setImmediate(resolve));
        // The running plugin's onDisable runs while the other enable is still held.
        expect(runningDisable).toHaveBeenCalledTimes(1);
        expect(slowDisable).not.toHaveBeenCalled();
        release();
        await enabling;
        await destroying;
        expect(runningDisable).toHaveBeenCalledTimes(1);
        expect(slowDisable).toHaveBeenCalledTimes(1);
        expect(loader.getPlugin('running-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.DISABLED);
        expect(loader.getPlugin('slow-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.DISABLED);
    });
    it('joins a disable already in flight instead of running onDisable twice', async () => {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const onDisable = jest.fn(() => gate);
        loader.registerBuiltInPlugin(ext('busy-plg'), { onDisable });
        await loader.enablePlugin('busy-plg');
        const disabling = loader.disablePlugin('busy-plg');
        const destroying = loader.onModuleDestroy();
        release();
        await disabling;
        await destroying;
        expect(onDisable).toHaveBeenCalledTimes(1);
        expect(loader.getPlugin('busy-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.DISABLED);
    });
    it('joins the disable of an unload already in flight', async () => {
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const onDisable = jest.fn(() => gate);
        const onUnload = jest.fn(() => Promise.resolve());
        loader.registerBuiltInPlugin(ext('gone-plg'), { onDisable, onUnload });
        await loader.enablePlugin('gone-plg');
        const unloading = loader.unloadPlugin('gone-plg');
        const destroying = loader.onModuleDestroy();
        release();
        await unloading;
        await destroying;
        expect(onDisable).toHaveBeenCalledTimes(1);
        expect(onUnload).toHaveBeenCalledTimes(1);
        expect(loader.getPlugin('gone-plg')).toBeUndefined();
    });
    describe('time cap', () => {
        beforeEach(() => jest.useFakeTimers());
        afterEach(() => jest.useRealTimers());
        const never = () => new Promise(() => undefined);
        it('disables plugins in parallel and returns at PLUGIN_SHUTDOWN_WAIT_MS when onDisable never settles', async () => {
            const a = jest.fn(never);
            const b = jest.fn(never);
            loader.registerBuiltInPlugin(ext('a-plg'), { onDisable: a });
            loader.registerBuiltInPlugin(ext('b-plg'), { onDisable: b });
            await loader.enablePlugin('a-plg');
            await loader.enablePlugin('b-plg');
            const warn = jest.spyOn(loader['logger'], 'warn').mockImplementation(() => undefined);
            let done = false;
            void loader.onModuleDestroy().then(() => (done = true));
            await jest.advanceTimersByTimeAsync(0);
            expect(a).toHaveBeenCalledTimes(1);
            expect(b).toHaveBeenCalledTimes(1);
            await jest.advanceTimersByTimeAsync(plugin_loader_service_2.PLUGIN_SHUTDOWN_WAIT_MS - 1);
            expect(done).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(done).toBe(true);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('time cap'), expect.objectContaining({ action: 'plugin_shutdown_timeout' }));
        });
        it('stops waiting for an enable that never settles at the same cap', async () => {
            loader.registerBuiltInPlugin(ext('stuck-plg'), { onEnable: never });
            void loader.enablePlugin('stuck-plg').catch(() => undefined);
            jest.spyOn(loader['logger'], 'warn').mockImplementation(() => undefined);
            let done = false;
            void loader.onModuleDestroy().then(() => (done = true));
            await jest.advanceTimersByTimeAsync(plugin_loader_service_2.PLUGIN_SHUTDOWN_WAIT_MS - 1);
            expect(done).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(done).toBe(true);
        });
        it('still disables an enable that lands at 2 s and returns then, without the warning', async () => {
            const onDisable = jest.fn(() => Promise.resolve());
            loader.registerBuiltInPlugin(ext('late-plg'), {
                onEnable: () => new Promise(resolve => setTimeout(resolve, 2000)),
                onDisable,
            });
            void loader.enablePlugin('late-plg');
            const warn = jest.spyOn(loader['logger'], 'warn').mockImplementation(() => undefined);
            let done = false;
            void loader.onModuleDestroy().then(() => (done = true));
            await jest.advanceTimersByTimeAsync(1999);
            expect(done).toBe(false);
            await jest.advanceTimersByTimeAsync(1);
            expect(done).toBe(true);
            expect(onDisable).toHaveBeenCalledTimes(1);
            expect(warn).not.toHaveBeenCalled();
        });
        it('leaves no timer behind after a teardown that finishes within the cap', async () => {
            loader.registerBuiltInPlugin(ext('ok-plg'), { onDisable: () => Promise.resolve() });
            await loader.enablePlugin('ok-plg');
            await loader.onModuleDestroy();
            expect(jest.getTimerCount()).toBe(0);
        });
        it('does not let one failing onDisable stop the others', async () => {
            const ok = jest.fn(() => Promise.resolve());
            loader.registerBuiltInPlugin(ext('bad-plg'), { onDisable: () => Promise.reject(new Error('flush failed')) });
            loader.registerBuiltInPlugin(ext('ok-plg'), { onDisable: ok });
            await loader.enablePlugin('bad-plg');
            await loader.enablePlugin('ok-plg');
            jest.spyOn(loader['logger'], 'error').mockImplementation(() => undefined);
            await expect(loader.onModuleDestroy()).resolves.toBeUndefined();
            expect(ok).toHaveBeenCalledTimes(1);
        });
    });
    it('refuses an enable once teardown has begun', async () => {
        const onEnable = jest.fn(() => Promise.resolve());
        loader.registerBuiltInPlugin(ext('late-plg'), { onEnable });
        await loader.onModuleDestroy();
        await expect(loader.enablePlugin('late-plg')).rejects.toThrow(/shutting down/);
        expect(onEnable).not.toHaveBeenCalled();
        expect(loader.getPlugin('late-plg')?.status).not.toBe(plugin_interfaces_1.PluginStatus.ENABLED);
    });
});
describe('PluginLoaderService — enable-failure hook cleanup', () => {
    let tmpDir;
    let hooks;
    let loader;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-enfail-'));
        const config = { get: (k) => (k === 'dataDir' ? tmpDir : undefined) };
        hooks = new hooks_1.HookManager();
        loader = new plugin_loader_service_2.PluginLoaderService(config, hooks, new plugin_storage_service_1.PluginStorageService(config), {});
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('does not leak hook registrations when an enable attempt fails, so a later enable does not double-dispatch', async () => {
        let shouldThrow = true;
        const instance = {
            onEnable: (ctx) => {
                // The plugin subscribes a hook, then its enable fails (e.g. a transient connect timeout).
                ctx.registerHook('message:received', () => Promise.resolve({ continue: true }));
                return shouldThrow ? Promise.reject(new Error('transient onEnable failure')) : Promise.resolve();
            },
        };
        loader.registerBuiltInPlugin({ id: 'flaky-plg', name: 'Flaky', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.js' }, instance);
        // First enable fails AFTER the hook was registered → the registration must not survive.
        await expect(loader.enablePlugin('flaky-plg')).rejects.toThrow(/transient/);
        expect(loader.getPlugin('flaky-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.ERROR);
        // Retry succeeds.
        shouldThrow = false;
        await loader.enablePlugin('flaky-plg');
        expect(loader.getPlugin('flaky-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.ENABLED);
        // Exactly one handler — the failed attempt left nothing behind. Without cleanup this is 2,
        // and every message:received would dispatch to the plugin twice.
        expect(hooks.getHookCount('message:received')).toBe(1);
    });
});
describe('PluginLoaderService.dispatchWebhookForInstance config delivery', () => {
    it('delivers the instance-session-resolved config to the sandbox host', async () => {
        // `list` is part of the real service and the dispatch path consults it to decide whether the
        // scope-keyed slice can be attributed to this instance. One enabled instance on the scope, so
        // the slice IS attributable and the per-session override below must still apply.
        const fakeInstanceService = {
            resolve: jest.fn().mockResolvedValue({ sessionScope: 'sess-1' }),
            list: jest.fn().mockResolvedValue([{ instanceId: 'acct1', enabled: true, sessionScope: 'sess-1' }]),
        };
        const configService = { get: jest.fn().mockReturnValue(undefined) };
        const pluginStorage = {
            getPluginEntry: jest.fn().mockReturnValue(undefined),
            setPluginEntry: jest.fn(),
            getPluginConfig: jest.fn().mockReturnValue(null),
            getPluginSessions: jest.fn().mockReturnValue(undefined),
            getPluginSessionConfig: jest.fn().mockReturnValue(undefined),
        };
        const moduleRef = { get: jest.fn().mockReturnValue(fakeInstanceService) };
        const loader = new plugin_loader_service_2.PluginLoaderService(configService, new hooks_1.HookManager(), pluginStorage, moduleRef);
        const internals = loader;
        internals.plugins.set('chatwoot-adapter', {
            manifest: {
                id: 'chatwoot-adapter',
                sessionScoped: true,
                ingress: [{ route: 'chatwoot', signature: { scheme: 'none' } }],
            },
            config: { baseUrl: 'base', accountId: 1 },
            sessionConfig: { 'sess-1': { baseUrl: 'https://tenant1' } },
        });
        const dispatchWebhook = jest.fn().mockResolvedValue({ ok: true, status: 200 });
        internals.sandboxHosts.set('chatwoot-adapter', { dispatchWebhook });
        await loader.dispatchWebhookForInstance({
            pluginId: 'chatwoot-adapter',
            instanceId: 'acct1',
            route: 'chatwoot',
            method: 'PATCH',
            deliveryId: 'd1',
            sessionId: 'sess-1',
            payload: { headers: {}, query: {}, body: '', rawBody: '' },
        });
        expect(fakeInstanceService.resolve).toHaveBeenCalledWith('chatwoot-adapter', 'acct1');
        expect(dispatchWebhook).toHaveBeenCalledTimes(1);
        // Session override (tenant1) merged over the base — this is what makes an instance multi-tenant.
        expect(dispatchWebhook).toHaveBeenCalledWith(expect.objectContaining({
            config: { baseUrl: 'https://tenant1', accountId: 1 },
            method: 'PATCH',
            verified: false,
        }));
    });
});
describe('PluginLoaderService — search-provider wiring', () => {
    function makeLoader(moduleRefGet) {
        const configService = { get: jest.fn().mockReturnValue(undefined) };
        const pluginStorage = {
            getPluginEntry: jest.fn().mockReturnValue(undefined),
            setPluginEntry: jest.fn(),
            setPluginStatus: jest.fn(),
            getPluginConfig: jest.fn().mockReturnValue(null),
            getPluginSessions: jest.fn().mockReturnValue(undefined),
            getPluginSessionConfig: jest.fn().mockReturnValue(undefined),
            createPluginStorage: jest
                .fn()
                .mockReturnValue({ get: jest.fn(), set: jest.fn(), delete: jest.fn(), list: jest.fn() }),
        };
        return new plugin_loader_service_2.PluginLoaderService(configService, new hooks_1.HookManager(), pluginStorage, {
            get: moduleRefGet,
        });
    }
    // getSearchRegistryPort's own behaviour now lives in plugin-host-services.spec.ts, tested on the class
    // that owns it instead of through a private reach-in on the loader.
    it('disablePlugin unregisters the plugin’s search-provider entry', async () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register({ id: 'plugin:disable-test', label: 'p', search: jest.fn(), health: jest.fn() });
        const loader = makeLoader(jest.fn().mockReturnValue(registry));
        const manifest = {
            id: 'disable-test',
            name: 'Disable Test',
            version: '1.0.0',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            main: 'index.js',
        };
        loader.registerBuiltInPlugin(manifest, {});
        await loader.enablePlugin('disable-test'); // builtIn → enableInProcess, status→ENABLED
        expect(registry.list().map(p => p.id)).toContain('plugin:disable-test');
        await loader.disablePlugin('disable-test');
        expect(registry.list().map(p => p.id)).not.toContain('plugin:disable-test');
    });
});
describe('PluginLoaderService — search-provider enable-failure cleanup', () => {
    jest.setTimeout(30000);
    let tmpDir;
    const BOOTSTRAP = path.resolve(__dirname, 'sandbox/worker-bootstrap.js');
    const TS_NODE_OPTS = JSON.stringify({
        module: 'commonjs',
        moduleResolution: 'node',
        resolvePackageJsonExports: false,
        // TypeScript 6 rejects the legacy resolution pair unless acknowledged. Revisit before TS 7.
        ignoreDeprecations: '6.0',
    });
    // Runs the REAL worker (ts-node) instead of the compiled dist bootstrap, so enableSandboxed
    // exercises its true load/lifecycle/catch path with a live worker thread.
    class RealWorkerLoader extends plugin_loader_service_2.PluginLoaderService {
        createSandboxHost(capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, onSearchProviderRegister) {
            return new plugin_worker_host_1.PluginWorkerHost(new worker_thread_channel_1.WorkerThreadChannel({
                workerEntry: BOOTSTRAP,
                execArgv: [],
                env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
            }), capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, undefined, onSearchProviderRegister);
        }
    }
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-search-ef-'));
        fs.mkdirSync(path.join(tmpDir, 'rt'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'rt', 'manifest.json'), JSON.stringify({ id: 'rt', name: 'RT', version: '1.0.0', type: 'extension', main: 'index.cjs' }));
        // Fixture: register a search provider, THEN throw in onEnable — so the host has received
        // search-provider-register (and activated the provider in auto mode) before enable fails.
        fs.writeFileSync(path.join(tmpDir, 'rt', 'index.cjs'), "module.exports = class { async onEnable(ctx) { ctx.registerSearchProvider(async () => ({ hits: [], total: 0, tookMs: 1, provider: 'plugin:rt' })); throw new Error('onEnable failed'); } };");
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('unregisters the search provider when enable fails after registration (no dead active provider)', async () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register({ id: 'builtin-fts', label: 'b', search: jest.fn(), health: jest.fn() });
        const config = {
            get: (k) => k === 'search.provider' ? 'auto' : k === 'plugins.dir' || k === 'dataDir' ? tmpDir : undefined,
        };
        const storage = new plugin_storage_service_1.PluginStorageService(config);
        const loader = new RealWorkerLoader(config, new hooks_1.HookManager(), storage, {
            get: () => registry,
        });
        loader.loadPlugin(path.join(tmpDir, 'rt'));
        await expect(loader.enablePlugin('rt')).rejects.toThrow('onEnable failed');
        // Registered mid-onEnable, then onEnable threw → the catch must unregister the dead provider.
        expect(registry.list().map(p => p.id)).not.toContain('plugin:rt');
        expect(registry.active()?.id).toBe('builtin-fts');
    });
});
describe('PluginLoaderService — search-provider worker-crash fallback', () => {
    jest.setTimeout(30000);
    let tmpDir;
    const BOOTSTRAP = path.resolve(__dirname, 'sandbox/worker-bootstrap.js');
    const TS_NODE_OPTS = JSON.stringify({
        module: 'commonjs',
        moduleResolution: 'node',
        resolvePackageJsonExports: false,
        // TypeScript 6 rejects the legacy resolution pair unless acknowledged. Revisit before TS 7.
        ignoreDeprecations: '6.0',
    });
    // Real ts-node worker (so enableSandboxed runs its true path) that captures the host so the test can
    // crash it.
    class CapturingLoader extends plugin_loader_service_2.PluginLoaderService {
        lastHost;
        createSandboxHost(capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, onSearchProviderRegister, onWorkerExit) {
            const host = new plugin_worker_host_1.PluginWorkerHost(new worker_thread_channel_1.WorkerThreadChannel({
                workerEntry: BOOTSTRAP,
                execArgv: [],
                env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
            }), capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, undefined, onSearchProviderRegister, onWorkerExit);
            this.lastHost = host;
            return host;
        }
    }
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-search-crash-'));
        fs.mkdirSync(path.join(tmpDir, 'ok'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'ok', 'manifest.json'), JSON.stringify({
            id: 'ok',
            name: 'OK',
            version: '1.0.0',
            type: 'extension',
            main: 'index.cjs',
            // This suite is about crash fallback, so the fixture must be a plugin the search bridge accepts.
            permissions: ['search:provide'],
        }));
        fs.writeFileSync(path.join(tmpDir, 'ok', 'index.cjs'), "module.exports = class { async onEnable(ctx) { ctx.registerSearchProvider(async () => ({ hits: [], total: 0, tookMs: 1, provider: 'plugin:ok' })); } };");
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('falls back to builtin-fts when the plugin worker crashes after a successful enable', async () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register({ id: 'builtin-fts', label: 'b', search: jest.fn(), health: jest.fn() });
        const config = {
            get: (k) => k === 'search.provider' ? 'auto' : k === 'plugins.dir' || k === 'dataDir' ? tmpDir : undefined,
        };
        const storage = new plugin_storage_service_1.PluginStorageService(config);
        const loader = new CapturingLoader(config, new hooks_1.HookManager(), storage, {
            get: () => registry,
        });
        loader.loadPlugin(path.join(tmpDir, 'ok'));
        await loader.enablePlugin('ok'); // registers + setActive -> active = plugin:ok
        expect(registry.active()?.id).toBe('plugin:ok');
        // Worker crashes (unexpected exit) — terminate() emits the worker 'exit' event -> handleExit -> onWorkerExit.
        await loader.lastHost.terminate();
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        expect(registry.list().map(p => p.id)).not.toContain('plugin:ok');
        expect(registry.active()?.id).toBe('builtin-fts'); // fell back, not pinned to the dead plugin
    });
    it('never activates a plugin that registers a search provider without declaring search:provide', async () => {
        // Same fixture, permission removed: ctx.registerSearchProvider is installed in EVERY worker context,
        // so this is the whole distance between an undeclared plugin and serving every /search query.
        fs.writeFileSync(path.join(tmpDir, 'ok', 'manifest.json'), JSON.stringify({ id: 'ok', name: 'OK', version: '1.0.0', type: 'extension', main: 'index.cjs' }));
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register({ id: 'builtin-fts', label: 'b', search: jest.fn(), health: jest.fn() });
        const config = {
            get: (k) => k === 'search.provider' ? 'auto' : k === 'plugins.dir' || k === 'dataDir' ? tmpDir : undefined,
        };
        const storage = new plugin_storage_service_1.PluginStorageService(config);
        const loader = new CapturingLoader(config, new hooks_1.HookManager(), storage, {
            get: () => registry,
        });
        loader.loadPlugin(path.join(tmpDir, 'ok'));
        await loader.enablePlugin('ok');
        // Assert BEFORE reaping: terminate() runs onWorkerExit -> unregisterPluginSearchProvider, which
        // drops plugin:ok and restores builtin-fts on its own. Asserting after it would pass whether or
        // not the permission gate works at all. The finally still reaps, so no worker handle leaks.
        try {
            expect(registry.list().map(p => p.id)).not.toContain('plugin:ok');
            expect(registry.active()?.id).toBe('builtin-fts'); // auto mode must NOT hand the gateway to it
        }
        finally {
            await loader.lastHost.terminate();
        }
    });
});
describe('PluginLoaderService — onUnload dispatch', () => {
    let tmpDir;
    let pluginsDir;
    let loader;
    let storage;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-onunload-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        const config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
        storage = new plugin_storage_service_1.PluginStorageService(config);
        loader = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage, {});
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const extManifest = (id) => ({
        id,
        name: id,
        version: '1.0.0',
        type: plugin_interfaces_1.PluginType.EXTENSION,
        main: 'index.js',
    });
    it('runs an in-process plugin’s onUnload on the uninstall path (after onDisable)', async () => {
        const calls = [];
        const instance = {
            onDisable: () => {
                calls.push('onDisable');
                return Promise.resolve();
            },
            onUnload: () => {
                calls.push('onUnload');
                return Promise.resolve();
            },
        };
        loader.registerBuiltInPlugin(extManifest('un-plg'), instance);
        // Built-ins can't be uninstalled, so drive the same unload path an uninstall takes.
        await loader.enablePlugin('un-plg');
        await loader.unloadPlugin('un-plg');
        expect(calls).toEqual(['onDisable', 'onUnload']);
        expect(loader.getPlugin('un-plg')).toBeUndefined();
    });
    it('does NOT fire onUnload on a plain disable (disable is reversible; its hook is onDisable)', async () => {
        const onUnload = jest.fn(() => Promise.resolve());
        loader.registerBuiltInPlugin(extManifest('no-unload-plg'), { onUnload });
        await loader.enablePlugin('no-unload-plg');
        await loader.disablePlugin('no-unload-plg');
        expect(onUnload).not.toHaveBeenCalled();
        expect(loader.getPlugin('no-unload-plg')?.status).toBe(plugin_interfaces_1.PluginStatus.DISABLED);
    });
    it('dispatches onUnload to a sandboxed plugin’s worker before terminating it', async () => {
        loader.registerBuiltInPlugin(extManifest('sand-plg'), {});
        const plugin = loader.getPlugin('sand-plg');
        // Simulate a sandboxed runtime: non-built-in instance with a live worker host.
        plugin.builtIn = false;
        plugin.status = plugin_interfaces_1.PluginStatus.ENABLED;
        const host = {
            runLifecycle: jest.fn().mockResolvedValue(undefined),
            terminate: jest.fn().mockResolvedValue(undefined),
        };
        loader.sandboxHosts.set('sand-plg', host);
        await loader.unloadPlugin('sand-plg');
        expect(host.runLifecycle.mock.calls.map((c) => c[0])).toEqual(['onDisable', 'onUnload']);
        expect(host.terminate).toHaveBeenCalledTimes(1);
        // onUnload must run BEFORE the worker is terminated — after terminate the hook is unreachable.
        const unloadOrder = host.runLifecycle.mock.invocationCallOrder[1];
        const terminateOrder = host.terminate.mock.invocationCallOrder[0];
        expect(unloadOrder).toBeLessThan(terminateOrder);
    });
    it('still terminates the worker when the sandboxed onUnload throws (best-effort teardown)', async () => {
        loader.registerBuiltInPlugin(extManifest('sand-bad'), {});
        const plugin = loader.getPlugin('sand-bad');
        plugin.builtIn = false;
        plugin.status = plugin_interfaces_1.PluginStatus.ENABLED;
        const host = {
            runLifecycle: jest
                .fn()
                .mockImplementation((method) => method === 'onUnload' ? Promise.reject(new Error('unload wedged')) : Promise.resolve()),
            terminate: jest.fn().mockResolvedValue(undefined),
        };
        loader.sandboxHosts.set('sand-bad', host);
        await expect(loader.unloadPlugin('sand-bad')).resolves.toBeUndefined();
        expect(host.terminate).toHaveBeenCalledTimes(1);
        expect(loader.getPlugin('sand-bad')).toBeUndefined();
    });
});
/**
 * Where the loader looks for plugin code at boot.
 *
 * The package dir and the plugin registry describe the same install, and they used to default from
 * two unrelated strings: with PLUGINS_DIR unset the loader scanned ./plugins while the registry (and
 * every plugin's ctx.storage) lived under <dataDir>/plugins. The scan found nothing and said only
 * "Loaded 0 plugins", while the registry still listed every plugin as installed — and in Docker the
 * install landed in the container layer instead of on the data volume, so a recreate destroyed the
 * code while the config and secrets on the volume survived.
 *
 * These tests boot through the REAL configuration factory from a temp cwd standing in for the image's
 * WORKDIR /app, because the defaults under test are relative paths resolved against the cwd.
 */
describe('PluginLoaderService — boot plugins directory', () => {
    let tmpDir;
    let origCwd;
    const origPluginsDir = process.env.PLUGINS_DIR;
    const loggerOf = (loader) => loader.logger;
    /** Put a loadable plugin package (manifest + main file) at <dir>/<id>, like the installer does. */
    const installAt = (dir, id) => {
        const pluginDir = path.join(dir, id);
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify({ id, name: id, version: '1.0.0', type: 'extension', main: 'index.js' }));
        fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = class {};');
    };
    const boot = () => {
        const config = new config_1.ConfigService((0, configuration_1.default)());
        const storage = new plugin_storage_service_1.PluginStorageService(config);
        const loader = new plugin_loader_service_2.PluginLoaderService(config, new hooks_1.HookManager(), storage, {});
        const warn = jest.spyOn(loggerOf(loader), 'warn').mockImplementation(() => undefined);
        jest.spyOn(loggerOf(loader), 'log').mockImplementation(() => undefined);
        jest.spyOn(loggerOf(loader), 'debug').mockImplementation(() => undefined);
        loader.onModuleInit();
        return { loader, storage, warn };
    };
    const warningsMatching = (warn, action) => warn.mock.calls.filter(([, context]) => context?.action === action);
    beforeEach(() => {
        delete process.env.PLUGINS_DIR;
        // realpath: on macOS os.tmpdir() is a symlink, and process.cwd() reports the resolved path.
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'owa-pluginsdir-')));
        origCwd = process.cwd();
        process.chdir(tmpDir);
    });
    afterEach(() => {
        process.chdir(origCwd);
        if (origPluginsDir === undefined)
            delete process.env.PLUGINS_DIR;
        else
            process.env.PLUGINS_DIR = origPluginsDir;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    // THE regression: with PLUGINS_DIR unset, plugin code sitting where the registry lives must load.
    it('loads plugin code from <dataDir>/plugins when PLUGINS_DIR is unset', () => {
        installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-data');
        const { loader } = boot();
        expect(loader.getPlugin('ext-data')).toBeDefined();
        // ...and the registry is written into that same tree, which is the whole point: an install's code
        // and its persisted entry can never end up on different volumes again.
        expect(fs.existsSync(path.join(tmpDir, 'data', 'plugins', 'registry.json'))).toBe(true);
    });
    it('still loads plugins left at the legacy ./plugins location, and says so', () => {
        installAt(path.join(tmpDir, 'plugins'), 'ext-legacy');
        const { loader, warn } = boot();
        expect(loader.getPlugin('ext-legacy')).toBeDefined();
        const [message] = warningsMatching(warn, 'plugins_legacy_dir')[0];
        // The operator must be able to act on this without reading the source: both paths, and how to
        // make the choice permanent either way.
        expect(message).toContain(path.join('.', 'plugins'));
        expect(message).toContain(path.join('data', 'plugins'));
        expect(message).toContain('PLUGINS_DIR');
    });
    it('loads plugins from both locations while a host is mid-migration', () => {
        installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-new');
        installAt(path.join(tmpDir, 'plugins'), 'ext-legacy');
        const { loader } = boot();
        expect(loader.getPlugin('ext-new')).toBeDefined();
        expect(loader.getPlugin('ext-legacy')).toBeDefined();
    });
    it('keeps the copy in the configured dir when the same plugin exists in both, without marking it ERROR', () => {
        installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-both');
        installAt(path.join(tmpDir, 'plugins'), 'ext-both');
        const { loader, storage } = boot();
        expect(loader.getPlugin('ext-both')).toBeDefined();
        expect(storage.getPluginStatus('ext-both')).toBe(plugin_interfaces_1.PluginStatus.INSTALLED);
    });
    it('honors an explicit PLUGINS_DIR over both the default and the legacy fallback', () => {
        const custom = path.join(tmpDir, 'custom-plugins');
        process.env.PLUGINS_DIR = custom;
        installAt(custom, 'ext-custom');
        installAt(path.join(tmpDir, 'data', 'plugins'), 'ext-data');
        installAt(path.join(tmpDir, 'plugins'), 'ext-legacy');
        const { loader, warn } = boot();
        expect(loader.getPlugin('ext-custom')).toBeDefined();
        expect(loader.getPlugin('ext-data')).toBeUndefined();
        expect(loader.getPlugin('ext-legacy')).toBeUndefined();
        expect(warningsMatching(warn, 'plugins_legacy_dir')).toHaveLength(0);
    });
    it('ignores a legacy directory that holds no loadable plugin package', () => {
        // <dataDir>/plugins/<id> doubles as the plugin's ctx.storage dir, so "a directory exists" says
        // nothing about whether code is there — only a manifest does.
        fs.mkdirSync(path.join(tmpDir, 'plugins', 'ext-storage-only'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'plugins', 'ext-storage-only', 'key-abc.json'), '{}');
        const { warn } = boot();
        expect(warningsMatching(warn, 'plugins_legacy_dir')).toHaveLength(0);
    });
    it('warns when the registry holds installed plugins whose code is not there', () => {
        // A host whose plugin code was destroyed with the container layer: the entry (config, secrets,
        // enabledByOperator) survived on the volume, the code did not.
        const config = new config_1.ConfigService((0, configuration_1.default)());
        const seed = new plugin_storage_service_1.PluginStorageService(config);
        seed.setPluginEntry({
            id: 'ext-gone',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            name: 'Ext Gone',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: {},
            builtIn: false,
            installedAt: new Date(),
            updatedAt: new Date(),
        });
        const { warn } = boot();
        const [message, context] = warningsMatching(warn, 'plugin_registry_without_code')[0];
        expect(message).toContain('ext-gone');
        expect(context?.count).toBe(1);
        expect(context?.pluginsDir).toContain(path.join('data', 'plugins'));
    });
    it('warns when the plugins directory does not exist at all but the registry has entries', () => {
        const custom = path.join(tmpDir, 'never-created');
        process.env.PLUGINS_DIR = custom;
        const seed = new plugin_storage_service_1.PluginStorageService(new config_1.ConfigService((0, configuration_1.default)()));
        seed.setPluginEntry({
            id: 'ext-gone',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            name: 'Ext Gone',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: {},
            builtIn: false,
            installedAt: new Date(),
            updatedAt: new Date(),
        });
        const { warn } = boot();
        const [message] = warningsMatching(warn, 'plugin_registry_without_code')[0];
        expect(message).toContain(custom);
        expect(message).toContain('does not exist');
    });
    it('stays quiet on a genuinely empty install and for built-ins, which never have a package dir', () => {
        const seed = new plugin_storage_service_1.PluginStorageService(new config_1.ConfigService((0, configuration_1.default)()));
        seed.setPluginEntry({
            id: 'whatsapp-web.js',
            type: plugin_interfaces_1.PluginType.ENGINE,
            name: 'whatsapp-web.js',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: {},
            builtIn: true,
            installedAt: new Date(),
            updatedAt: new Date(),
        });
        const { warn } = boot();
        expect(warningsMatching(warn, 'plugin_registry_without_code')).toHaveLength(0);
        expect(warningsMatching(warn, 'plugins_legacy_dir')).toHaveLength(0);
    });
    it("does not report a built-in's storage directory as a stray non-plugin directory", () => {
        // <dataDir>/plugins/<id> is also where ctx.storage writes, so a built-in engine that persists
        // anything gets a manifest-less directory here on every healthy boot. That must not read like a
        // fault, and must not look the same as an installed plugin whose code is gone.
        const seed = new plugin_storage_service_1.PluginStorageService(new config_1.ConfigService((0, configuration_1.default)()));
        seed.setPluginEntry({
            id: 'whatsapp-web.js',
            type: plugin_interfaces_1.PluginType.ENGINE,
            name: 'whatsapp-web.js',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: {},
            builtIn: true,
            installedAt: new Date(),
            updatedAt: new Date(),
        });
        fs.mkdirSync(path.join(tmpDir, 'data', 'plugins', 'whatsapp-web.js'), { recursive: true });
        const { warn } = boot();
        expect(warningsMatching(warn, 'manifest_missing')).toHaveLength(0);
    });
    it('reports an installed plugin whose storage survived but whose code is gone', () => {
        const seed = new plugin_storage_service_1.PluginStorageService(new config_1.ConfigService((0, configuration_1.default)()));
        seed.setPluginEntry({
            id: 'ext-gone',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            name: 'Ext Gone',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: {},
            builtIn: false,
            installedAt: new Date(),
            updatedAt: new Date(),
        });
        const dataOnly = path.join(tmpDir, 'data', 'plugins', 'ext-gone');
        fs.mkdirSync(dataOnly, { recursive: true });
        fs.writeFileSync(path.join(dataOnly, 'key-abc.json'), '{}');
        const { warn } = boot();
        const [message] = warningsMatching(warn, 'plugin_code_missing')[0];
        expect(message).toContain('ext-gone');
        // The state is intact — the operator needs to know reinstalling is safe, not assume data loss.
        expect(message).toMatch(/config|data/i);
    });
});
