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
const plugin_interfaces_1 = require("../../core/plugins/plugin.interfaces");
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
// An uninstall that fails after it stored the emptied registry entry has already erased the operator's config,
// secrets, session activation and enable decision, and stopped the plugin. It answers 400, and the audit log must
// still say what it changed. A refusal that changed nothing leaves no row.
describe('Audit trail of an uninstall that fails part-way', () => {
    let tmp;
    let configService;
    let releaseTakeovers;
    let storage;
    let loader;
    let logInfo;
    let controller;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-uninstall-partial-'));
        const packagesRoot = path.join(tmp, 'packages');
        fs.mkdirSync(packagesRoot, { recursive: true });
        const values = { dataDir: path.join(tmp, 'data'), 'plugins.dir': packagesRoot };
        configService = { get: jest.fn((key) => values[key]) };
        storage = new plugin_storage_service_1.PluginStorageService(configService);
        releaseTakeovers = jest.fn().mockResolvedValue(undefined);
        loader = new plugin_loader_service_1.PluginLoaderService(configService, new hooks_1.HookManager(), storage, {
            get: jest.fn().mockReturnValue({ unregister: jest.fn(), releaseTakeovers }),
        });
        const service = new plugins_service_1.PluginsService(loader, configService);
        logInfo = jest.fn().mockResolvedValue(null);
        controller = new plugins_controller_1.PluginsController(service, { logInfo });
        service.install({ buffer: pkg() });
        storage.setPluginConfig('p1', { token: 'operator-secret' });
        storage.setPluginSessions('p1', ['s1']);
        storage.setPluginEnabledByOperator('p1', true);
    });
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
    it('records the uninstall as partial when the takeover release fails after the entry was emptied', async () => {
        // The conversation store cannot answer (a database outage) once the plugin is unloaded.
        releaseTakeovers.mockRejectedValue(new Error('SQLITE_BUSY: database is locked'));
        const failure = await controller.uninstall('p1').catch((error) => error);
        // The answer itself is the 400 it always was.
        expect(failure).toBeInstanceOf(common_1.BadRequestException);
        expect(failure.getResponse()).toEqual({
            statusCode: 400,
            message: 'SQLITE_BUSY: database is locked',
            error: 'Bad Request',
        });
        const onDisk = new plugin_storage_service_1.PluginStorageService(configService).getPluginEntry('p1');
        expect(loader.getPlugin('p1')).toBeUndefined();
        expect(onDisk?.config).toEqual({});
        expect(onDisk?.enabledByOperator).toBe(false);
        expect(logInfo).toHaveBeenCalledTimes(1);
        expect(logInfo).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.PLUGIN_UNINSTALLED, {
            sessionId: undefined,
            metadata: { pluginId: 'p1', partial: true, error: 'SQLITE_BUSY: database is locked' },
        });
    });
    it('records a repeat that completes as an ordinary uninstall', async () => {
        releaseTakeovers.mockRejectedValueOnce(new Error('SQLITE_BUSY: database is locked'));
        await expect(controller.uninstall('p1')).rejects.toThrow(common_1.BadRequestException);
        await expect(controller.uninstall('p1')).resolves.toEqual({
            success: true,
            message: 'Plugin p1 uninstalled successfully',
        });
        expect(logInfo).toHaveBeenLastCalledWith(audit_log_entity_1.AuditAction.PLUGIN_UNINSTALLED, {
            sessionId: undefined,
            metadata: { pluginId: 'p1' },
        });
    });
    it('leaves no row for the refusal of a built-in, which changes nothing', async () => {
        const builtIn = { id: 'core', name: 'Core', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.js' };
        loader.registerBuiltInPlugin(builtIn, {}, {});
        await expect(controller.uninstall('core')).rejects.toThrow(common_1.BadRequestException);
        expect(loader.getPlugin('core')).toBeDefined();
        expect(logInfo).not.toHaveBeenCalled();
    });
});
