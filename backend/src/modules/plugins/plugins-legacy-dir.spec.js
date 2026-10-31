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
const adm_zip_1 = __importDefault(require("adm-zip"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const plugin_storage_service_1 = require("../../core/plugins/plugin-storage.service");
const hooks_1 = require("../../core/hooks");
const plugin_interfaces_1 = require("../../core/plugins/plugin.interfaces");
const plugins_service_1 = require("./plugins.service");
/**
 * The service half of the same defect: a package the loader found in the legacy plugins directory
 * had its config UI read, and its in-place update staged, under the CONFIGURED directory — where it
 * is not. The config UI answered 404; the update renamed a directory that did not exist, after
 * unloadPlugin had already dropped the plugin from the runtime.
 */
const manifest = {
    id: 'legacy-plg',
    name: 'Legacy Plugin',
    version: '1.0.0',
    type: plugin_interfaces_1.PluginType.EXTENSION,
    main: 'index.js',
    configUi: { entry: 'ui.html' },
};
const zipOf = (files) => {
    const z = new adm_zip_1.default();
    for (const [name, content] of Object.entries(files))
        z.addFile(name, Buffer.from(content));
    return z.toBuffer();
};
describe('PluginsService — a plugin loaded from the legacy plugins directory', () => {
    let tmpDir;
    let configuredDir;
    let legacyDir;
    let loader;
    let service;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-legacy-svc-'));
        configuredDir = path.join(tmpDir, 'data', 'plugins');
        legacyDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(configuredDir, { recursive: true });
        const pkg = path.join(legacyDir, manifest.id);
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');
        fs.writeFileSync(path.join(pkg, 'ui.html'), '<p>legacy config ui</p>');
        const config = {
            get: (k) => ({ dataDir: path.join(tmpDir, 'data'), 'plugins.dir': configuredDir, 'plugins.legacyDir': legacyDir })[k],
        };
        loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {
            the: 'unused',
        });
        loader.onModuleInit();
        service = new plugins_service_1.PluginsService(loader, config);
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('serves its config UI from the tree it was loaded from', () => {
        expect(service.getConfigUiHtml(manifest.id)).toContain('legacy config ui');
    });
    it('updates in place, leaving the new version where the old one was', async () => {
        const next = { ...manifest, version: '2.0.0' };
        await service.updatePackage(manifest.id, zipOf({
            'manifest.json': JSON.stringify(next),
            'index.js': 'module.exports = class {};',
            'ui.html': '<p>v2 config ui</p>',
        }));
        const onDisk = JSON.parse(fs.readFileSync(path.join(legacyDir, manifest.id, 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('2.0.0');
        // The update must not have materialised a second copy under the configured root, which would
        // then win the next boot's duplicate-id skip and shadow the tree that was actually updated.
        expect(fs.existsSync(path.join(configuredDir, manifest.id))).toBe(false);
        expect(loader.getPlugin(manifest.id)?.manifest.version).toBe('2.0.0');
    });
});
