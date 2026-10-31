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
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const plugin_storage_service_1 = require("../../core/plugins/plugin-storage.service");
const hooks_1 = require("../../core/hooks");
const plugin_interfaces_1 = require("../../core/plugins/plugin.interfaces");
const plugins_service_1 = require("./plugins.service");
const common_1 = require("@nestjs/common");
// A config save the gateway could not write to registry.json must not be reported as saved: the change
// lives only in memory and is gone after the next restart, while the operator was told it was stored.
describe('PluginsService.updateConfig when registry.json cannot be written', () => {
    let tmp;
    let pluginsRoot;
    let configService;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-unpersisted-'));
        pluginsRoot = path.join(tmp, 'plugins');
        const values = { dataDir: tmp, 'plugins.dir': pluginsRoot };
        configService = { get: jest.fn((key) => values[key]) };
    });
    afterEach(() => {
        fs.chmodSync(pluginsRoot, 0o700);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    it('reports the failure instead of success', () => {
        const storage = new plugin_storage_service_1.PluginStorageService(configService);
        storage.setPluginEntry({
            id: 'p1',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            name: 'P1',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: { apiKey: 'old' },
            builtIn: false,
            installedAt: new Date(),
            updatedAt: new Date(),
        });
        const loader = new plugin_loader_service_1.PluginLoaderService(configService, new hooks_1.HookManager(), storage, {
            get: jest.fn(),
        });
        const plugin = {
            manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.js' },
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: { apiKey: 'old' },
            instance: null,
            builtIn: false,
        };
        loader.plugins.set('p1', plugin);
        const service = new plugins_service_1.PluginsService(loader, configService);
        // The data volume stops accepting writes (full disk, read-only remount, wrong owner).
        fs.chmodSync(pluginsRoot, 0o500);
        const result = service.updateConfig('p1', { apiKey: 'rotated' });
        // What a restart would load: the registry on disk.
        expect(new plugin_storage_service_1.PluginStorageService(configService).getPluginConfig('p1')).toEqual({ apiKey: 'old' });
        expect(result.success).toBe(false);
    });
});
// The other operator-facing plugin writes: each one the registry cannot store is answered as not applied, and the
// running state stays what a restart would load.
describe('PluginsService plugin changes when registry.json cannot be written', () => {
    let tmp;
    let pluginsRoot;
    let configService;
    let storage;
    let loader;
    let service;
    let plugin;
    const onDisk = () => new plugin_storage_service_1.PluginStorageService(configService);
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-unwritable-'));
        pluginsRoot = path.join(tmp, 'plugins');
        const values = { dataDir: tmp, 'plugins.dir': pluginsRoot };
        configService = { get: jest.fn((key) => values[key]) };
        storage = new plugin_storage_service_1.PluginStorageService(configService);
        storage.setPluginEntry({
            id: 'p1',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            name: 'P1',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: { apiKey: 'old' },
            builtIn: true,
            installedAt: new Date(),
            updatedAt: new Date(),
            activeSessions: ['s1'],
            enabledByOperator: false,
        });
        // One stand-in for every host port the paths below reach (search registry, conversation store).
        const port = { unregister: jest.fn(), releaseTakeovers: jest.fn().mockResolvedValue(undefined) };
        loader = new plugin_loader_service_1.PluginLoaderService(configService, new hooks_1.HookManager(), storage, {
            get: jest.fn().mockReturnValue(port),
        });
        // An in-process plugin with nothing to run, so an enable completes without a worker.
        plugin = {
            manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.js' },
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: { apiKey: 'old' },
            instance: {},
            builtIn: true,
            activeSessions: ['s1'],
        };
        loader.plugins.set('p1', plugin);
        service = new plugins_service_1.PluginsService(loader, configService);
        // The plugin's storage directory exists already, as it does for any plugin enabled before.
        fs.mkdirSync(path.join(pluginsRoot, 'p1'));
        fs.chmodSync(pluginsRoot, 0o500);
    });
    afterEach(() => {
        fs.chmodSync(pluginsRoot, 0o700);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    it('keeps the running config when the save is refused', () => {
        expect(service.updateConfig('p1', { apiKey: 'rotated' }).success).toBe(false);
        expect(plugin.config).toEqual({ apiKey: 'old' });
        expect(storage.getPluginConfig('p1')).toEqual({ apiKey: 'old' });
    });
    it('refuses a per-session config it cannot store', () => {
        expect(service.updateSessionConfig('p1', 's1', { apiKey: 'tenant' }).success).toBe(false);
        expect(plugin.sessionConfig).toBeUndefined();
        expect(onDisk().getPluginSessionConfig('p1')).toBeNull();
    });
    it('answers an activation it cannot store as a server error, not a client error', () => {
        expect(() => service.updateSessions('p1', ['*'])).toThrow(common_1.InternalServerErrorException);
        expect(plugin.activeSessions).toEqual(['s1']);
        expect(onDisk().getPluginSessions('p1')).toEqual(['s1']);
    });
    it('does not leave a plugin running whose enable decision it cannot store', async () => {
        const result = await service.enable('p1');
        expect(result.success).toBe(false);
        expect(plugin.status).toBe(plugin_interfaces_1.PluginStatus.DISABLED);
        expect(onDisk().getPluginEntry('p1')?.enabledByOperator).toBe(false);
    });
    it('keeps a running plugin running when its disable decision cannot be stored', async () => {
        plugin.status = plugin_interfaces_1.PluginStatus.ENABLED;
        storage.getPluginEntry('p1').enabledByOperator = true;
        const result = await service.disable('p1');
        expect(result.success).toBe(false);
        expect(result.message).toContain('the change was not applied');
        expect(plugin.status).toBe(plugin_interfaces_1.PluginStatus.ENABLED);
        expect(onDisk().getPluginEntry('p1')?.enabledByOperator).toBe(false);
    });
    it('reports a disable decision it cannot store for a plugin that is not loaded', async () => {
        loader.plugins.delete('p1');
        storage.getPluginEntry('p1').enabledByOperator = true;
        await expect(service.disable('p1')).resolves.toMatchObject({ success: false });
        expect(storage.getPluginEntry('p1')?.enabledByOperator).toBe(true);
    });
    it('refuses an uninstall it cannot store before removing anything', async () => {
        plugin.builtIn = false;
        storage.getPluginEntry('p1').builtIn = false;
        await expect(service.uninstall('p1')).rejects.toThrow(common_1.InternalServerErrorException);
        expect(loader.getPlugin('p1')).toBe(plugin);
        expect(fs.existsSync(path.join(pluginsRoot, 'p1'))).toBe(true);
        expect(storage.getPluginEntry('p1')?.config).toEqual({ apiKey: 'old' });
        expect(onDisk().getPluginEntry('p1')?.config).toEqual({ apiKey: 'old' });
    });
});
