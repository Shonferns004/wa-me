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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const adm_zip_1 = __importDefault(require("adm-zip"));
const common_1 = require("@nestjs/common");
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const plugin_storage_service_1 = require("../../core/plugins/plugin-storage.service");
const hooks_1 = require("../../core/hooks");
const plugin_uninstaller_1 = require("../../core/plugins/plugin-uninstaller");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const plugins_controller_1 = require("./plugins.controller");
const plugins_service_1 = require("./plugins.service");
const manifest = { id: 'p1', name: 'P1', version: '1.0.0', type: 'extension', main: 'index.js' };
function pkg() {
    const zip = new adm_zip_1.default();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
    zip.addFile('index.js', Buffer.from('module.exports = class {};'));
    return zip.toBuffer();
}
/** What an uninstall must not leave for a reinstall of the id to inherit, or for a restart to restore. */
const operatorSettings = (entry) => ({
    config: entry?.config,
    activeSessions: entry?.activeSessions,
    sessionConfig: entry?.sessionConfig,
    enabledByOperator: entry?.enabledByOperator,
});
const emptied = { config: {}, activeSessions: undefined, sessionConfig: undefined, enabledByOperator: false };
// An uninstall empties the plugin's registry entry before it removes anything and drops the entry last. A registry
// that cannot take the first write refuses the uninstall with nothing changed. One that fails only the last write
// leaves an emptied entry: the answer and the audit trail say the plugin was uninstalled, and neither a reinstall of
// the id nor a restart gets the old config, session activation or enable decision back.
describe('Uninstall when registry.json cannot be written', () => {
    let tmp;
    let registryRoot;
    let packageDir;
    let configService;
    let onRelease;
    /** One gateway process over the same directories; a second call is a restart. */
    const boot = () => {
        const storage = new plugin_storage_service_1.PluginStorageService(configService);
        const port = {
            unregister: jest.fn(),
            releaseTakeovers: jest.fn(() => {
                onRelease();
                return Promise.resolve();
            }),
        };
        const loader = new plugin_loader_service_1.PluginLoaderService(configService, new hooks_1.HookManager(), storage, {
            get: jest.fn().mockReturnValue(port),
        });
        const service = new plugins_service_1.PluginsService(loader, configService);
        const logInfo = jest.fn().mockResolvedValue(null);
        const controller = new plugins_controller_1.PluginsController(service, { logInfo });
        return { storage, loader, service, controller, logInfo };
    };
    let gateway;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-uninstall-unwritable-'));
        registryRoot = path.join(tmp, 'data', 'plugins');
        // PLUGINS_DIR outside the data directory: the package tree stays writable when the data volume does not.
        const packagesRoot = path.join(tmp, 'packages');
        fs.mkdirSync(packagesRoot, { recursive: true });
        packageDir = path.join(packagesRoot, 'p1');
        const values = { dataDir: path.join(tmp, 'data'), 'plugins.dir': packagesRoot };
        configService = { get: jest.fn((key) => values[key]) };
        onRelease = () => undefined;
        gateway = boot();
        gateway.service.install({ buffer: pkg() });
        const mustPersist = { mustPersist: true };
        gateway.storage.setPluginConfig('p1', { token: 'old-secret' }, mustPersist);
        gateway.storage.setPluginSessions('p1', ['s1'], mustPersist);
        gateway.storage.setPluginSessionConfig('p1', { s1: { token: 'tenant-secret' } }, mustPersist);
        gateway.storage.setPluginEnabledByOperator('p1', true);
    });
    afterEach(() => {
        fs.chmodSync(registryRoot, 0o700);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    const onDisk = () => new plugin_storage_service_1.PluginStorageService(configService).getPluginEntry('p1');
    it('refuses the uninstall before removing anything when the registry cannot be written from the start', async () => {
        // The data volume's plugin directory stops accepting writes (an ownership change).
        fs.chmodSync(registryRoot, 0o500);
        await expect(gateway.controller.uninstall('p1')).rejects.toThrow(common_1.InternalServerErrorException);
        expect(gateway.loader.getPlugin('p1')).toBeDefined();
        expect(fs.existsSync(packageDir)).toBe(true);
        expect(onDisk()?.config).toEqual({ token: 'old-secret' });
        expect(onDisk()?.enabledByOperator).toBe(true);
        expect(gateway.logInfo).not.toHaveBeenCalled();
    });
    it('answers done when only the final delete fails, and a reinstall in the same process starts fresh', async () => {
        // The registry stops accepting writes while the plugin is being removed.
        onRelease = () => fs.chmodSync(registryRoot, 0o500);
        const result = await gateway.controller.uninstall('p1');
        expect(gateway.loader.getPlugin('p1')).toBeUndefined();
        expect(fs.existsSync(packageDir)).toBe(false);
        expect(result.success).toBe(true);
        expect(result.message).toMatch(/keeps its entry, emptied of config, sessions and the enable decision/);
        // The plugin is no longer listed, so the answer names the call that removes the entry.
        expect(result.message).toMatch(/until DELETE \/api\/plugins\/p1 is repeated once the registry is writable$/);
        expect(gateway.logInfo).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.PLUGIN_UNINSTALLED, {
            sessionId: undefined,
            metadata: { pluginId: 'p1' },
        });
        expect(operatorSettings(gateway.storage.getPluginEntry('p1'))).toEqual(emptied);
        expect(operatorSettings(onDisk())).toEqual(emptied);
        fs.chmodSync(registryRoot, 0o700);
        onRelease = () => undefined;
        gateway.service.install({ buffer: pkg() });
        expect(operatorSettings(gateway.storage.getPluginEntry('p1'))).toEqual(emptied);
        expect(operatorSettings(onDisk())).toEqual(emptied);
    });
    it('leaves nothing for a restart to re-enable or hand to a reinstall', async () => {
        onRelease = () => fs.chmodSync(registryRoot, 0o500);
        await gateway.controller.uninstall('p1');
        onRelease = () => undefined;
        const restarted = boot();
        restarted.loader.onModuleInit();
        expect(restarted.loader.getPlugin('p1')).toBeUndefined();
        // What the boot restore reads to decide whether to enable a loaded plugin.
        expect(operatorSettings(restarted.loader.getRegistryEntry('p1'))).toEqual(emptied);
        fs.chmodSync(registryRoot, 0o700);
        restarted.service.install({ buffer: pkg() });
        expect(operatorSettings(restarted.storage.getPluginEntry('p1'))).toEqual(emptied);
        expect(operatorSettings(onDisk())).toEqual(emptied);
    });
    it('refuses config and session writes that arrive while the uninstall is unloading the plugin', async () => {
        onRelease = () => fs.chmodSync(registryRoot, 0o500);
        // The unload awaits the plugin's own hooks with the plugin still loaded; every write lands in that window.
        const lifecycle = gateway.loader
            .lifecycle;
        const unload = lifecycle.unloadPlugin.bind(lifecycle);
        const outcomes = [];
        const attempt = (write) => {
            try {
                outcomes.push(write());
            }
            catch (error) {
                outcomes.push(error);
            }
        };
        jest.spyOn(lifecycle, 'unloadPlugin').mockImplementation(async (id) => {
            const { controller, loader } = gateway;
            attempt(() => controller.updateConfig('p1', { config: { token: 'saved-during-uninstall' } }));
            attempt(() => controller.updateSessionConfig('p1', 's2', { config: { token: 'tenant-2' } }));
            attempt(() => controller.updateSessions('p1', { sessions: ['s2'] }));
            // The integration fabric projects instance config through the loader directly, best effort.
            attempt(() => loader.updatePluginConfig('p1', { token: 'instance-secret' }));
            attempt(() => loader.setPluginSessionConfig('p1', 's3', { token: 'instance-3' }));
            attempt(() => loader.setPluginSessions('p1', ['*']));
            return unload(id);
        });
        const result = await gateway.controller.uninstall('p1');
        expect(outcomes.slice(0, 3).map(o => o instanceof common_1.ConflictException)).toEqual([true, true, true]);
        expect(outcomes.slice(3).map(o => o instanceof plugin_uninstaller_1.PluginUninstallingError)).toEqual([true, true, true]);
        expect(result.message).toMatch(/keeps its entry, emptied of config, sessions and the enable decision/);
        // Only the uninstall is audited: no refused write left a row.
        expect(gateway.logInfo).toHaveBeenCalledTimes(1);
        expect(gateway.logInfo).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.PLUGIN_UNINSTALLED, expect.anything());
        expect(operatorSettings(gateway.storage.getPluginEntry('p1'))).toEqual(emptied);
        expect(operatorSettings(onDisk())).toEqual(emptied);
        // What a reinstall of the id inherits after a restart.
        onRelease = () => undefined;
        fs.chmodSync(registryRoot, 0o700);
        const restarted = boot();
        restarted.loader.onModuleInit();
        restarted.service.install({ buffer: pkg() });
        expect(restarted.loader.getPlugin('p1')?.config).toEqual({});
        expect(operatorSettings(restarted.storage.getPluginEntry('p1'))).toEqual(emptied);
    });
    it('takes config and session writes again once an uninstall leaves the plugin loaded', async () => {
        const lifecycle = gateway.loader
            .lifecycle;
        jest.spyOn(lifecycle, 'unloadPlugin').mockRejectedValueOnce(new Error('onUnload failed'));
        await expect(gateway.controller.uninstall('p1')).rejects.toThrow('onUnload failed');
        expect(gateway.loader.getPlugin('p1')).toBeDefined();
        expect(gateway.controller.updateConfig('p1', { config: { token: 'new-secret' } }).success).toBe(true);
        expect(onDisk()?.config).toEqual({ token: 'new-secret' });
    });
    it('removes the leftover entry when the uninstall is repeated with a writable registry', async () => {
        onRelease = () => fs.chmodSync(registryRoot, 0o500);
        await gateway.controller.uninstall('p1');
        onRelease = () => undefined;
        fs.chmodSync(registryRoot, 0o700);
        await expect(gateway.controller.uninstall('p1')).resolves.toEqual({
            success: true,
            message: 'Plugin p1 uninstalled successfully',
        });
        expect(gateway.storage.getPluginEntry('p1')).toBeUndefined();
        expect(onDisk()).toBeUndefined();
    });
});
