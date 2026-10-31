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
const plugin_loader_service_1 = require("./plugin-loader.service");
const plugin_storage_service_1 = require("./plugin-storage.service");
const hooks_1 = require("../hooks");
const plugin_interfaces_1 = require("./plugin.interfaces");
// #856 — an operator's enable decision must survive a restart.
//
// Before this, `ensureRegistryEntry` rewrote the persisted status to INSTALLED on every load, so every
// restart silently turned off every extension plugin and destroyed the only record that it had been on.
// The intent is now persisted separately from the runtime status, and restored at bootstrap.
//
// The intent is written ONLY by the operator-facing enable/disable in PluginsService, never by the
// loader — which is what keeps the shutdown teardown (onModuleDestroy disables every enabled plugin)
// from wiping it on the way out. The last test here guards exactly that.
const manifest = {
    id: 'ext-test',
    name: 'Ext Test',
    version: '1.0.0',
    type: plugin_interfaces_1.PluginType.EXTENSION,
    main: 'index.js',
};
describe('PluginLoaderService — restoring the operator enable decision across a restart (#856)', () => {
    let tmpDir;
    let config;
    let storage;
    let loader;
    let pluginDir;
    const makeLoader = (s) => new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), s, {});
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-restore-'));
        config = { get: (k) => (k === 'dataDir' ? tmpDir : undefined) };
        storage = new plugin_storage_service_1.PluginStorageService(config);
        loader = makeLoader(storage);
        // A plugin on disk needs its manifest AND its declared main file to load (boot validates both,
        // like install); the code itself runs in the sandbox worker, so a stub main file suffices here.
        pluginDir = path.join(tmpDir, 'plugins', manifest.id);
        fs.mkdirSync(pluginDir, { recursive: true });
        fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(pluginDir, 'index.js'), 'module.exports = class {};');
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('carries the operator enable decision across a reload, even though the runtime status resets', () => {
        loader.loadPlugin(pluginDir);
        storage.setPluginEnabledByOperator(manifest.id, true);
        // Restart: fresh storage re-reads registry.json, fresh loader re-loads the plugin directory.
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        makeLoader(storage2).loadPlugin(pluginDir);
        const entry = storage2.getPluginEntry(manifest.id);
        // The runtime still comes up INSTALLED — enabling runs the lifecycle and must stay an explicit step.
        expect(entry?.status).toBe(plugin_interfaces_1.PluginStatus.INSTALLED);
        // ...but the operator's intent is intact, which is what bootstrap acts on.
        expect(entry?.enabledByOperator).toBe(true);
    });
    it('adopts a pre-#856 entry that is still recorded as ENABLED, so an upgrade does not lose the decision', () => {
        // A registry written by an older build: status ENABLED (the operator enabled it after the last
        // boot, so nothing has overwritten it yet) and no enabledByOperator field at all.
        loader.loadPlugin(pluginDir);
        const entry = storage.getPluginEntry(manifest.id);
        delete entry.enabledByOperator;
        entry.status = plugin_interfaces_1.PluginStatus.ENABLED;
        storage.setPluginEntry(entry);
        // First boot on the new build.
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        makeLoader(storage2).loadPlugin(pluginDir);
        expect(storage2.getPluginEntry(manifest.id)?.enabledByOperator).toBe(true);
    });
    it('leaves a plugin the operator never enabled alone', () => {
        loader.loadPlugin(pluginDir);
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        makeLoader(storage2).loadPlugin(pluginDir);
        expect(storage2.getPluginEntry(manifest.id)?.enabledByOperator).toBeFalsy();
    });
    it('enables the plugins the operator had enabled, at bootstrap', async () => {
        loader.loadPlugin(pluginDir);
        storage.setPluginEnabledByOperator(manifest.id, true);
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = makeLoader(storage2);
        loader2.loadPlugin(pluginDir);
        // Stub the real enable: the lifecycle spawns a sandbox worker, which is not what this asserts.
        const enable = jest.spyOn(loader2, 'enablePlugin').mockResolvedValue(undefined);
        await loader2.onApplicationBootstrap();
        expect(enable).toHaveBeenCalledWith(manifest.id);
    });
    it('does not enable a plugin the operator had not enabled', async () => {
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = makeLoader(storage2);
        loader2.loadPlugin(pluginDir);
        const enable = jest.spyOn(loader2, 'enablePlugin').mockResolvedValue(undefined);
        await loader2.onApplicationBootstrap();
        expect(enable).not.toHaveBeenCalled();
    });
    it('holds the plugins it will restore from module init, before bootstrap starts the restore', async () => {
        // The BullMQ workers start between module init and bootstrap; a queued ingress job they take there has
        // to find its plugin restoring rather than dispatch into a loader with no worker for it.
        const idle = { ...manifest, id: 'ext-idle', name: 'Ext Idle' };
        const idleDir = path.join(tmpDir, 'plugins', idle.id);
        fs.mkdirSync(idleDir, { recursive: true });
        fs.writeFileSync(path.join(idleDir, 'manifest.json'), JSON.stringify(idle));
        fs.writeFileSync(path.join(idleDir, 'index.js'), 'module.exports = class {};');
        loader.loadPlugin(pluginDir);
        storage.setPluginEnabledByOperator(manifest.id, true);
        // A restart: the boot scan reads the plugins directory, as the real boot does.
        const bootConfig = {
            get: (k) => ({ dataDir: tmpDir, 'plugins.dir': path.join(tmpDir, 'plugins') })[k],
        };
        const loader2 = new plugin_loader_service_1.PluginLoaderService(bootConfig, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(bootConfig), {});
        const enable = jest.spyOn(loader2, 'enablePlugin').mockResolvedValue(undefined);
        loader2.onModuleInit();
        expect(loader2.getPlugin(idle.id)).toBeDefined();
        expect(enable).not.toHaveBeenCalled();
        expect(loader2.isRestorePending(manifest.id)).toBe(true);
        expect(loader2.isRestorePending(idle.id)).toBe(false);
        await loader2.onApplicationBootstrap();
        expect(enable).toHaveBeenCalledTimes(1);
        expect(enable).toHaveBeenCalledWith(manifest.id);
        expect(loader2.restorePendingIds()).toEqual([]);
    });
    it('keeps booting when one plugin fails to come back, and still restores the others', async () => {
        const second = { ...manifest, id: 'ext-two', name: 'Ext Two' };
        const secondDir = path.join(tmpDir, 'plugins', second.id);
        fs.mkdirSync(secondDir, { recursive: true });
        fs.writeFileSync(path.join(secondDir, 'manifest.json'), JSON.stringify(second));
        fs.writeFileSync(path.join(secondDir, 'index.js'), 'module.exports = class {};');
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = makeLoader(storage2);
        loader2.loadPlugin(pluginDir);
        loader2.loadPlugin(secondDir);
        storage2.setPluginEnabledByOperator(manifest.id, true);
        storage2.setPluginEnabledByOperator(second.id, true);
        const enable = jest
            .spyOn(loader2, 'enablePlugin')
            .mockImplementation((id) => (id === manifest.id ? Promise.reject(new Error('boom')) : Promise.resolve()));
        // A plugin that cannot come back must never hold up the gateway.
        await expect(loader2.onApplicationBootstrap()).resolves.toBeUndefined();
        expect(enable).toHaveBeenCalledWith(second.id);
    });
    it('stops restoring plugins once shutdown teardown begins', async () => {
        const second = { ...manifest, id: 'ext-two', name: 'Ext Two' };
        const secondDir = path.join(tmpDir, 'plugins', second.id);
        fs.mkdirSync(secondDir, { recursive: true });
        fs.writeFileSync(path.join(secondDir, 'manifest.json'), JSON.stringify(second));
        fs.writeFileSync(path.join(secondDir, 'index.js'), 'module.exports = class {};');
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        const loader2 = makeLoader(storage2);
        loader2.loadPlugin(pluginDir);
        loader2.loadPlugin(secondDir);
        storage2.setPluginEnabledByOperator(manifest.id, true);
        storage2.setPluginEnabledByOperator(second.id, true);
        const log = jest
            .spyOn(loader2.logger, 'log')
            .mockImplementation(() => undefined);
        // The gateway starts shutting down while the first plugin is being restored.
        let destroying;
        const enable = jest.spyOn(loader2, 'enablePlugin').mockImplementation(() => {
            destroying = loader2.onModuleDestroy();
            return Promise.resolve();
        });
        await loader2.onApplicationBootstrap();
        await destroying;
        expect(enable).toHaveBeenCalledTimes(1);
        expect(enable).not.toHaveBeenCalledWith(second.id);
        // The skipped plugins are reported, so an operator can tell the restore was cut short.
        expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped at 1 of 2'), expect.objectContaining({ action: 'plugin_restore_aborted' }));
    });
    it('stops restoring plugins once the gateway starts draining, before its own module is destroyed', async () => {
        const second = { ...manifest, id: 'ext-two', name: 'Ext Two' };
        const secondDir = path.join(tmpDir, 'plugins', second.id);
        fs.mkdirSync(secondDir, { recursive: true });
        fs.writeFileSync(path.join(secondDir, 'manifest.json'), JSON.stringify(second));
        fs.writeFileSync(path.join(secondDir, 'index.js'), 'module.exports = class {};');
        const storage2 = new plugin_storage_service_1.PluginStorageService(config);
        // The drain flag flips at the signal; PluginsModule is destroyed last, long after.
        let draining = false;
        const shutdown = { isShuttingDown: () => draining };
        const loader2 = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), storage2, {}, undefined, shutdown);
        loader2.loadPlugin(pluginDir);
        loader2.loadPlugin(secondDir);
        storage2.setPluginEnabledByOperator(manifest.id, true);
        storage2.setPluginEnabledByOperator(second.id, true);
        const enable = jest.spyOn(loader2, 'enablePlugin').mockImplementation(() => {
            draining = true;
            return Promise.resolve();
        });
        await loader2.onApplicationBootstrap();
        expect(enable).toHaveBeenCalledTimes(1);
    });
    describe('a plugin that takes a long time to come back', () => {
        const second = { ...manifest, id: 'ext-two', name: 'Ext Two' };
        let loader2;
        let releaseFirst;
        let enable;
        beforeEach(() => {
            jest.useFakeTimers();
            const secondDir = path.join(tmpDir, 'plugins', second.id);
            fs.mkdirSync(secondDir, { recursive: true });
            fs.writeFileSync(path.join(secondDir, 'manifest.json'), JSON.stringify(second));
            fs.writeFileSync(path.join(secondDir, 'index.js'), 'module.exports = class {};');
            const storage2 = new plugin_storage_service_1.PluginStorageService(config);
            loader2 = makeLoader(storage2);
            loader2.loadPlugin(pluginDir);
            loader2.loadPlugin(secondDir);
            storage2.setPluginEnabledByOperator(manifest.id, true);
            storage2.setPluginEnabledByOperator(second.id, true);
            // The first plugin's enable hangs (a backend that is down) until the test lets it go.
            enable = jest.spyOn(loader2, 'enablePlugin').mockImplementation((id) => id === manifest.id
                ? new Promise(resolve => {
                    releaseFirst = resolve;
                })
                : Promise.resolve());
        });
        afterEach(() => {
            jest.useRealTimers();
        });
        it('does not hold the gateway back past the restore budget, and finishes restoring the rest afterwards', async () => {
            const warn = jest
                .spyOn(loader2.logger, 'warn')
                .mockImplementation(() => undefined);
            const booted = loader2.onApplicationBootstrap();
            await jest.advanceTimersByTimeAsync(plugin_loader_service_1.PLUGIN_RESTORE_BOOT_BUDGET_MS);
            await expect(booted).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('remaining plugins come up in the background'), expect.objectContaining({ action: 'plugin_restore_deferred' }));
            // The first plugin is still being enabled, so the second has not started: order is kept.
            expect(enable).toHaveBeenCalledTimes(1);
            releaseFirst();
            await jest.advanceTimersByTimeAsync(0);
            expect(enable).toHaveBeenCalledWith(second.id);
        });
        it('returns as soon as every plugin is back, without waiting out the budget', async () => {
            const booted = loader2.onApplicationBootstrap();
            releaseFirst();
            await expect(booted).resolves.toBeUndefined();
            expect(enable).toHaveBeenCalledTimes(2);
            // No timer is left running for the budget.
            expect(jest.getTimerCount()).toBe(0);
        });
        it('stops the background restore when the gateway shuts down', async () => {
            const booted = loader2.onApplicationBootstrap();
            await jest.advanceTimersByTimeAsync(plugin_loader_service_1.PLUGIN_RESTORE_BOOT_BUDGET_MS);
            await booted;
            await loader2.onModuleDestroy();
            releaseFirst();
            await jest.advanceTimersByTimeAsync(0);
            expect(enable).toHaveBeenCalledTimes(1);
        });
        it('keeps a plugin pending from the start of the restore until its own enable settles', async () => {
            const booted = loader2.onApplicationBootstrap();
            await jest.advanceTimersByTimeAsync(plugin_loader_service_1.PLUGIN_RESTORE_BOOT_BUDGET_MS);
            await booted;
            // The first is being enabled and the second is queued behind it: neither takes a lifecycle change yet.
            expect(loader2.isRestorePending(manifest.id)).toBe(true);
            expect(loader2.isRestorePending(second.id)).toBe(true);
            expect(loader2.isRestorePending('never-queued')).toBe(false);
            expect(loader2.restorePendingIds().sort()).toEqual([manifest.id, second.id].sort());
            releaseFirst();
            await jest.advanceTimersByTimeAsync(0);
            expect(loader2.isRestorePending(manifest.id)).toBe(false);
            expect(loader2.isRestorePending(second.id)).toBe(false);
            expect(loader2.restorePendingIds()).toEqual([]);
        });
        // The restore ending clears every id, so only a plugin that finished while a later one is still being
        // enabled shows whether it is handed back at once or held until the whole restore is over.
        it('hands a plugin back as soon as its own enable settles, while a later one is still being restored', async () => {
            let releaseSecond = () => undefined;
            enable.mockImplementation((id) => new Promise(resolve => {
                if (id === manifest.id)
                    releaseFirst = resolve;
                else
                    releaseSecond = resolve;
            }));
            const booted = loader2.onApplicationBootstrap();
            await jest.advanceTimersByTimeAsync(plugin_loader_service_1.PLUGIN_RESTORE_BOOT_BUDGET_MS);
            await booted;
            releaseFirst();
            await jest.advanceTimersByTimeAsync(0);
            expect(enable).toHaveBeenCalledWith(second.id);
            expect(loader2.isRestorePending(manifest.id)).toBe(false);
            expect(loader2.isRestorePending(second.id)).toBe(true);
            releaseSecond();
            await jest.advanceTimersByTimeAsync(0);
            expect(loader2.isRestorePending(second.id)).toBe(false);
        });
        it('stops holding a plugin whose restore failed', async () => {
            enable.mockImplementation((id) => id === manifest.id ? Promise.reject(new Error('backend down')) : Promise.resolve());
            jest
                .spyOn(loader2.logger, 'error')
                .mockImplementation(() => undefined);
            await loader2.onApplicationBootstrap();
            expect(loader2.isRestorePending(manifest.id)).toBe(false);
            expect(loader2.isRestorePending(second.id)).toBe(false);
        });
        it('lets go of the plugins it never reached when the gateway shuts down', async () => {
            const booted = loader2.onApplicationBootstrap();
            await jest.advanceTimersByTimeAsync(plugin_loader_service_1.PLUGIN_RESTORE_BOOT_BUDGET_MS);
            await booted;
            await loader2.onModuleDestroy();
            releaseFirst();
            await jest.advanceTimersByTimeAsync(0);
            expect(loader2.isRestorePending(manifest.id)).toBe(false);
            expect(loader2.isRestorePending(second.id)).toBe(false);
        });
    });
    it('does not treat the shutdown teardown as the operator disabling the plugin', async () => {
        // The regression that makes this whole design fragile: onModuleDestroy disables every enabled
        // plugin on the way out. If teardown cleared the intent, one graceful restart would erase it and
        // the plugin would never come back — exactly the bug being fixed, just relocated.
        loader.loadPlugin(pluginDir);
        storage.setPluginEnabledByOperator(manifest.id, true);
        const plugin = loader.getPlugin(manifest.id);
        plugin.status = plugin_interfaces_1.PluginStatus.ENABLED;
        jest.spyOn(loader, 'disablePlugin').mockResolvedValue(undefined);
        await loader.onModuleDestroy();
        expect(storage.getPluginEntry(manifest.id)?.enabledByOperator).toBe(true);
    });
});
