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
// A plugin whose package is on disk but fails the load validation (here: it needs a newer OpenWA) is
// logged as plugin_load_failed with the reason. The boot must not also report it as a plugin whose code
// is missing and tell the operator to reinstall it: the code is there, and a reinstall is refused for the
// same reason.
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const plugin_package_scanner_1 = require("./plugin-package-scanner");
const plugin_storage_service_1 = require("./plugin-storage.service");
const plugin_interfaces_1 = require("./plugin.interfaces");
describe('boot scan of a plugin package that fails its load validation', () => {
    let tmpDir;
    let pluginsDir;
    let config;
    let storage;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-scan-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        config = { get: (k) => (k === 'dataDir' ? tmpDir : undefined) };
        storage = new plugin_storage_service_1.PluginStorageService(config);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const placePackage = (folder, id) => {
        const dir = path.join(pluginsDir, folder);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id,
            name: 'Needs Newer',
            version: '1.0.0',
            type: 'extension',
            main: 'index.js',
            minOpenWAVersion: '99.0.0',
        }));
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
    };
    // Installed and configured on an earlier boot, when the floor was met.
    const installed = (id) => storage.setPluginEntry({
        id,
        type: plugin_interfaces_1.PluginType.EXTENSION,
        name: id,
        version: '1.0.0',
        status: plugin_interfaces_1.PluginStatus.INSTALLED,
        config: { greeting: 'hi' },
        builtIn: false,
        installedAt: new Date(),
        updatedAt: new Date(),
    });
    const scan = () => {
        const logger = { log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
        new plugin_package_scanner_1.PluginPackageScanner(logger, config, storage, pluginsDir, null, new Map()).scanAtBoot();
        const actions = (mock) => mock.mock.calls.map(call => call[call.length - 1]?.action);
        const missingCode = logger.warn.mock.calls.filter(call => call[call.length - 1]?.action === 'plugin_registry_without_code');
        return { errors: actions(logger.error), missingCode };
    };
    it('reports the load failure only, not code missing from the plugins directory', () => {
        placePackage('needs-newer', 'needs-newer');
        installed('needs-newer');
        const { errors, missingCode } = scan();
        expect(errors).toContain('plugin_load_failed');
        expect(missingCode).toHaveLength(0);
    });
    it('recognizes the failed package by its manifest id when its folder is named otherwise', () => {
        placePackage('hand-placed-copy', 'needs-newer');
        installed('needs-newer');
        const { errors, missingCode } = scan();
        expect(errors).toContain('plugin_load_failed');
        expect(missingCode).toHaveLength(0);
    });
    it('still reports a plugin whose code is really missing, and only that one', () => {
        placePackage('needs-newer', 'needs-newer');
        installed('needs-newer');
        installed('code-gone');
        const { missingCode } = scan();
        expect(missingCode).toHaveLength(1);
        const [message, context] = missingCode[0];
        expect(message).toContain('code-gone');
        expect(message).not.toContain('needs-newer');
        expect(context.count).toBe(1);
    });
});
