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
const scope_binding_service_1 = require("../../modules/integration/scope-binding.service");
// The integration instance projection applies to the running plugin even when registry.json cannot be written:
// the database rows are authoritative and boot reconciliation rebuilds the file, while a teardown that changed
// nothing in memory would leave a deleted instance firing, or its config slice for the survivor on its scope.
describe('the instance projection while registry.json cannot be written', () => {
    let tmp;
    let pluginsRoot;
    let loader;
    let plugin;
    let siblings;
    let svc;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-projection-unwritable-'));
        pluginsRoot = path.join(tmp, 'plugins');
        const values = { dataDir: tmp, 'plugins.dir': pluginsRoot };
        const configService = { get: jest.fn((key) => values[key]) };
        const storage = new plugin_storage_service_1.PluginStorageService(configService);
        storage.setPluginEntry({
            id: 'p1',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            name: 'P1',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.ENABLED,
            config: {},
            builtIn: false,
            installedAt: new Date(),
            updatedAt: new Date(),
            activeSessions: ['s1'],
            sessionConfig: { s1: { apiKey: 'tenant-A' } },
        });
        loader = new plugin_loader_service_1.PluginLoaderService(configService, new hooks_1.HookManager(), storage, {
            get: jest.fn().mockReturnValue({ unregister: jest.fn() }),
        });
        plugin = {
            manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.js' },
            status: plugin_interfaces_1.PluginStatus.ENABLED,
            config: {},
            instance: null,
            builtIn: false,
            activeSessions: ['s1'],
            sessionConfig: { s1: { apiKey: 'tenant-A' } },
        };
        loader.plugins.set('p1', plugin);
        siblings = [];
        const instances = { list: jest.fn(() => Promise.resolve(siblings)) };
        const audit = { logWarn: jest.fn().mockResolvedValue(undefined) };
        svc = new scope_binding_service_1.ScopeBindingService(instances, loader, audit, {});
        fs.chmodSync(pluginsRoot, 0o500);
    });
    afterEach(() => {
        fs.chmodSync(pluginsRoot, 0o700);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    it('a deleted instance stops receiving its session', async () => {
        await svc.applyScopeBinding('p1', 's1', {}, false);
        expect(plugin.activeSessions).not.toContain('s1');
    });
    it("a surviving sibling is not handed the retired instance's credentials", async () => {
        siblings = [{ pluginId: 'p1', instanceId: 'B', sessionScope: 's1', enabled: true }];
        await svc.applyScopeBinding('p1', 's1', {}, false);
        expect(plugin.sessionConfig?.s1).toBeUndefined();
    });
    it('the boot reconcile still binds an enabled instance in memory', async () => {
        await svc.applyScopeBinding('p1', 's2', { baseUrl: 'https://tenant-b' }, true, { additive: true });
        expect(plugin.activeSessions).toContain('s2');
        expect(plugin.sessionConfig?.s2).toEqual({ baseUrl: 'https://tenant-b' });
    });
});
