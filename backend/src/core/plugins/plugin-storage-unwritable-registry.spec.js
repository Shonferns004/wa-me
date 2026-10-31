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
const plugin_storage_service_1 = require("./plugin-storage.service");
const plugin_package_scanner_1 = require("./plugin-package-scanner");
const plugin_interfaces_1 = require("./plugin.interfaces");
const logger_service_1 = require("../../common/services/logger.service");
// Operator-facing registry writes fail loudly and leave the entry as it was; the boot scan and runtime status
// writes stay best-effort, so a read-only or full data volume still loads every plugin.
describe('PluginStorageService with a registry it cannot write', () => {
    let tmp;
    let pluginsRoot;
    let configService;
    let storage;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-readonly-'));
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
            builtIn: false,
            installedAt: new Date(),
            updatedAt: new Date(0),
            enabledByOperator: true,
        });
    });
    afterEach(() => {
        fs.chmodSync(pluginsRoot, 0o700);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    it('throws on a write that must be stored and keeps the entry as it was', () => {
        fs.chmodSync(pluginsRoot, 0o500);
        const before = { ...storage.getPluginEntry('p1') };
        const mustPersist = { mustPersist: true };
        expect(() => storage.setPluginConfig('p1', { apiKey: 'rotated' }, mustPersist)).toThrow(plugin_storage_service_1.PluginRegistryWriteError);
        expect(() => storage.setPluginEnabledByOperator('p1', false)).toThrow(plugin_storage_service_1.PluginRegistryWriteError);
        expect(() => storage.setPluginSessions('p1', ['*'], mustPersist)).toThrow(plugin_storage_service_1.PluginRegistryWriteError);
        expect(() => storage.setPluginSessionConfig('p1', { s1: { apiKey: 'x' } }, mustPersist)).toThrow(plugin_storage_service_1.PluginRegistryWriteError);
        expect(() => storage.deletePluginEntry('p1')).toThrow(plugin_storage_service_1.PluginRegistryWriteError);
        expect(() => storage.clearOperatorSettings('p1', mustPersist)).toThrow(plugin_storage_service_1.PluginRegistryWriteError);
        expect(storage.getPluginEntry('p1')).toEqual(before);
        expect(storage.getPluginEntry('p1')).not.toHaveProperty('activeSessions', ['*']);
    });
    it('applies a best-effort write in memory, so a later successful write stores it', () => {
        fs.chmodSync(pluginsRoot, 0o500);
        expect(() => storage.setPluginSessions('p1', ['s2'])).not.toThrow();
        expect(storage.getPluginSessions('p1')).toEqual(['s2']);
        fs.chmodSync(pluginsRoot, 0o700);
        storage.setPluginStatus('p1', plugin_interfaces_1.PluginStatus.ERROR);
        expect(new plugin_storage_service_1.PluginStorageService(configService).getPluginSessions('p1')).toEqual(['s2']);
    });
    it('keeps a runtime status write best-effort', () => {
        fs.chmodSync(pluginsRoot, 0o500);
        expect(() => storage.setPluginStatus('p1', plugin_interfaces_1.PluginStatus.ERROR)).not.toThrow();
        expect(storage.getPluginStatus('p1')).toBe(plugin_interfaces_1.PluginStatus.ERROR);
    });
    it('still loads plugins at boot, a stale entry prune included', () => {
        const pkg = path.join(pluginsRoot, 'p1');
        fs.mkdirSync(pkg);
        fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify({ id: 'p1', name: 'P1', version: '1.0.0', type: 'extension', main: 'index.js' }));
        fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');
        // A leftover directory of a removed bundled plugin, whose registry entry the scan prunes.
        fs.mkdirSync(path.join(pluginsRoot, 'auto-reply'));
        storage.setPluginEntry({ ...storage.getPluginEntry('p1'), id: 'auto-reply', name: 'Auto reply' });
        fs.chmodSync(pluginsRoot, 0o500);
        const plugins = new Map();
        const scanner = new plugin_package_scanner_1.PluginPackageScanner((0, logger_service_1.createLogger)('test'), configService, storage, pluginsRoot, null, plugins);
        expect(() => scanner.scanAtBoot()).not.toThrow();
        expect(plugins.get('p1')?.status).toBe(plugin_interfaces_1.PluginStatus.INSTALLED);
    });
});
