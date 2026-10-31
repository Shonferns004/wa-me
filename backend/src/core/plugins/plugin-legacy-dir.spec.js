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
/**
 * The loader scans the legacy plugins directory in addition to the configured one, so a host that
 * has not migrated keeps its plugins. What it did not record was WHICH directory each package came
 * from, and every later write against the package assumed the configured one — so a plugin loaded
 * from the legacy tree could be listed and reported as loaded, but not enabled, uninstalled or
 * updated. Nothing here had test coverage, which is why all four went unnoticed.
 */
const manifest = {
    id: 'legacy-plg',
    name: 'Legacy Plugin',
    version: '1.0.0',
    type: plugin_interfaces_1.PluginType.EXTENSION,
    main: 'index.js',
};
describe('PluginLoaderService — a plugin loaded from the legacy plugins directory', () => {
    let tmpDir;
    let configuredDir;
    let legacyDir;
    let config;
    let storage;
    let loader;
    /** Records what enableSandboxed asked the worker to require, and requires it for real. */
    const loadedMainPaths = [];
    class LoaderWithFakeSandbox extends plugin_loader_service_1.PluginLoaderService {
        createSandboxHost() {
            return {
                load: (mainPath) => {
                    loadedMainPaths.push(mainPath);
                    // Exactly what sandbox/worker-bootstrap.ts does on a 'load' message. A path in the wrong
                    // tree fails here with MODULE_NOT_FOUND, which is the defect's observable outcome.
                    // eslint-disable-next-line @typescript-eslint/no-require-imports
                    require(mainPath);
                    return Promise.resolve();
                },
                runLifecycle: () => Promise.resolve(),
                terminate: () => Promise.resolve(),
            };
        }
    }
    const makeLoader = () => new LoaderWithFakeSandbox(config, new hooks_1.HookManager(), storage, {});
    beforeEach(() => {
        loadedMainPaths.length = 0;
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-legacy-dir-'));
        configuredDir = path.join(tmpDir, 'data', 'plugins');
        legacyDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(configuredDir, { recursive: true });
        // The package sits ONLY in the legacy tree — the shape of a host whose plugins predate the move.
        const pkg = path.join(legacyDir, manifest.id);
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(manifest));
        fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');
        config = {
            get: (k) => ({ dataDir: path.join(tmpDir, 'data'), 'plugins.dir': configuredDir, 'plugins.legacyDir': legacyDir })[k],
        };
        storage = new plugin_storage_service_1.PluginStorageService(config);
        loader = makeLoader();
        loader.onModuleInit();
    });
    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    it('is loaded from the legacy directory in the first place', () => {
        expect(loader.getPlugin(manifest.id)).toBeDefined();
    });
    it('enables, requiring its entry from the tree it was loaded from', async () => {
        await loader.enablePlugin(manifest.id);
        expect(loader.getPlugin(manifest.id)?.status).toBe(plugin_interfaces_1.PluginStatus.ENABLED);
        expect(loadedMainPaths).toEqual([path.join(legacyDir, manifest.id, 'index.js')]);
    });
    it('uninstalls the package itself, so it does not come back on the next boot', async () => {
        await loader.uninstallPlugin(manifest.id);
        expect(fs.existsSync(path.join(legacyDir, manifest.id))).toBe(false);
        // The real proof: a fresh loader over the same directories must find nothing to load. Deleting
        // the wrong tree left the package in place and the plugin reappeared, having reported success.
        const next = makeLoader();
        next.onModuleInit();
        expect(next.getPlugin(manifest.id)).toBeUndefined();
    });
    it('uninstalls a legacy package that failed to load, so it does not load once the fault is fixed', async () => {
        // A package the boot scan could not load has no runtime record, so no recorded directory; the
        // loader must hand the uninstaller the legacy root or only the configured tree is cleaned.
        const broken = path.join(legacyDir, 'broken-plg');
        fs.mkdirSync(broken, { recursive: true });
        fs.writeFileSync(path.join(broken, 'manifest.json'), '{ not json');
        const fresh = makeLoader();
        fresh.onModuleInit();
        expect(fresh.getPlugin('broken-plg')).toBeUndefined();
        await fresh.uninstallPlugin('broken-plg');
        expect(fs.existsSync(broken)).toBe(false);
    });
    it('resolves its package directory to the legacy tree', () => {
        expect(loader.getPluginPackageDir(manifest.id)).toBe(path.resolve(legacyDir, manifest.id));
    });
    // The counterpart: nothing above may change where an ordinary plugin resolves to, and an id that
    // is not loaded still falls back to the configured directory, which is what a fresh install wants.
    it('leaves a plugin in the configured directory, and an unknown id, resolving as before', () => {
        const other = { ...manifest, id: 'configured-plg' };
        const pkg = path.join(configuredDir, other.id);
        fs.mkdirSync(pkg, { recursive: true });
        fs.writeFileSync(path.join(pkg, 'manifest.json'), JSON.stringify(other));
        fs.writeFileSync(path.join(pkg, 'index.js'), 'module.exports = class {};');
        const fresh = makeLoader();
        fresh.onModuleInit();
        expect(fresh.getPluginPackageDir(other.id)).toBe(path.resolve(configuredDir, other.id));
        expect(fresh.getPluginPackageDir('never-installed')).toBe(path.join(configuredDir, 'never-installed'));
    });
});
