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
// Spread the real fs so every method passes through, but as configurable props the test can spy on
// (the bare `import * as fs` namespace is non-configurable, so jest.spyOn can't redefine its methods).
jest.mock('fs', () => ({ __esModule: true, ...jest.requireActual('fs') }));
// fetchSafeBuffer stays REAL by default (the SSRF redaction test below depends on it); individual
// integrity tests queue a one-shot resolved download instead of hitting the network.
jest.mock('./plugin-download', () => {
    const actual = jest.requireActual('./plugin-download');
    return { ...actual, fetchSafeBuffer: jest.fn(actual.fetchSafeBuffer) };
});
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const crypto_1 = require("crypto");
const adm_zip_1 = __importDefault(require("adm-zip"));
const common_1 = require("@nestjs/common");
const plugins_service_1 = require("./plugins.service");
const plugin_download_1 = require("./plugin-download");
const redact_config_1 = require("./redact-config");
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const plugin_storage_service_1 = require("../../core/plugins/plugin-storage.service");
const plugin_interfaces_1 = require("../../core/plugins/plugin.interfaces");
const hooks_1 = require("../../core/hooks");
const manifest = { id: 'svc-plg', name: 'Svc Plugin', version: '1.0.0', type: 'extension', main: 'index.js' };
function pkg(over = {}) {
    const z = new adm_zip_1.default();
    z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, ...over })));
    z.addFile('index.js', Buffer.from('module.exports = class {};'));
    return z.toBuffer();
}
describe('PluginsService — install / uninstall (real loader + disk)', () => {
    let tmpDir;
    let pluginsDir;
    let loader;
    let service;
    let pluginStorage;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-svc-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        const config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
        pluginStorage = new plugin_storage_service_1.PluginStorageService(config);
        loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), pluginStorage, {});
        service = new plugins_service_1.PluginsService(loader, config);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('installs a valid package — writes the files, loads it, reports builtIn:false', () => {
        const dto = service.install({ buffer: pkg() });
        expect(dto.id).toBe('svc-plg');
        expect(dto.status).toBe('installed');
        expect(dto.builtIn).toBe(false);
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'index.js'))).toBe(true);
        expect(loader.getPlugin('svc-plg')).toBeDefined();
    });
    it('rejects an empty upload', () => {
        expect(() => service.install({ buffer: Buffer.alloc(0) })).toThrow(/no plugin file/i);
    });
    it('installPackage installs like install and refuses an empty upload', async () => {
        await expect(service.installPackage({ buffer: Buffer.alloc(0) })).rejects.toThrow(/no plugin file/i);
        const dto = await service.installPackage({ buffer: pkg() });
        expect(dto.id).toBe('svc-plg');
        expect(loader.getPlugin('svc-plg')).toBeDefined();
    });
    // An uninstall awaits the plugin's takeovers before it removes the files, and an upload that landed in
    // that window wrote a directory the teardown then deleted from under the freshly loaded plugin.
    it('installPackage waits for an uninstall of the same id that is still running', async () => {
        service.install({ buffer: pkg() });
        let finish;
        jest.spyOn(service, 'uninstallInner').mockImplementation(() => new Promise(resolve => {
            finish = () => resolve({ success: true, message: 'ok' });
        }));
        const install = jest.spyOn(service, 'install');
        const uninstalling = service.uninstall('svc-plg');
        const reinstalling = service.installPackage({ buffer: pkg() });
        const outcome = reinstalling.then(() => 'installed', (error) => error.message);
        await new Promise(resolve => setImmediate(resolve));
        expect(install).not.toHaveBeenCalled();
        finish();
        await uninstalling;
        // The mocked uninstall removed nothing, so the install that ran after it finds the plugin and refuses.
        await expect(outcome).resolves.toMatch(/already installed/i);
        expect(install).toHaveBeenCalledTimes(1);
    });
    it('rejects a duplicate install (already installed)', () => {
        service.install({ buffer: pkg() });
        expect(() => service.install({ buffer: pkg() })).toThrow(/already installed/i);
    });
    it('does not leave a directory behind when the package is invalid', () => {
        // Reserved id is rejected by the parser before anything is written.
        expect(() => service.install({ buffer: pkg({ id: 'baileys' }) })).toThrow(/reserved/i);
        expect(fs.existsSync(path.join(pluginsDir, 'baileys'))).toBe(false);
    });
    it('uninstalls a user plugin — removes its files, registry entry, and runtime instance', async () => {
        service.install({ buffer: pkg() });
        const res = await service.uninstall('svc-plg');
        expect(res.success).toBe(true);
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
        expect(loader.getPlugin('svc-plg')).toBeUndefined();
    });
    it('uninstalling an unknown plugin throws NotFound', async () => {
        await expect(service.uninstall('nope')).rejects.toThrow(/not found/i);
    });
    it('updatePackage swaps to the new version and preserves operator config', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        service.updateConfig('svc-plg', { apiKey: 'secret-123' });
        const dto = await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        expect(dto.version).toBe('2.0.0');
        // Read view masks config for a schemaless plugin (fail-closed), but the stored value survived the update.
        expect(dto.config).toEqual({ apiKey: redact_config_1.SECRET_SENTINEL });
        expect(loader.getPlugin('svc-plg')?.config).toEqual({ apiKey: 'secret-123' });
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false); // backup cleaned up
    });
    it('preserves ctx.storage state across an in-place package update', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        const storage = pluginStorage.createPluginStorage('svc-plg');
        await storage.set('cursor', { lastId: 'msg-42' });
        await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        expect(await storage.get('cursor')).toEqual({ lastId: 'msg-42' });
        const stateFile = fs.readdirSync(path.join(pluginsDir, 'svc-plg')).find(name => /^key-.*\.json$/.test(name));
        expect(stateFile).toBeDefined();
        if (process.platform !== 'win32') {
            expect(fs.statSync(path.join(pluginsDir, 'svc-plg', stateFile)).mode & 0o777).toBe(0o600);
        }
    });
    it('has the plugin state in the live directory the moment the update swaps it in', async () => {
        // Boot recovery drops the backup once a live directory exists, so state that is copied after the swap
        // is lost by a crash between the two. Observe the live directory right after the staging rename.
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        await pluginStorage.createPluginStorage('svc-plg').set('cursor', { lastId: 'msg-42' });
        const live = path.join(pluginsDir, 'svc-plg');
        const realRename = fs.renameSync.bind(fs);
        let atSwap;
        const rename = jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
            realRename(from, to);
            if (to === live && String(from).endsWith('.svc-plg.new'))
                atSwap = fs.readdirSync(live);
        });
        await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        rename.mockRestore();
        expect(atSwap).toEqual(expect.arrayContaining([expect.stringMatching(/^key-.*\.json$/)]));
    });
    it('preserves a legacy (pre-encoding) ctx.storage file across an in-place package update', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        const storage = pluginStorage.createPluginStorage('svc-plg');
        fs.writeFileSync(path.join(pluginsDir, 'svc-plg', 'cursor.json'), JSON.stringify({ lastId: 'msg-7' }));
        await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        expect(await storage.get('cursor')).toEqual({ lastId: 'msg-7' });
        // The new package's own manifest is never overwritten by the backed-up one.
        const shipped = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(shipped.version).toBe('2.0.0');
    });
    it('updatePackage rejects a package whose id does not match', async () => {
        service.install({ buffer: pkg() });
        await expect(service.updatePackage('svc-plg', pkg({ id: 'other-plg' }))).rejects.toThrow(/does not match/i);
    });
    it('updatePackage on an unknown plugin throws NotFound', async () => {
        await expect(service.updatePackage('nope', pkg())).rejects.toThrow(/not found/i);
    });
    it('rolls back to the OLD version (loaded, on disk) when the new version fails to enable', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        // Pretend it was enabled so the update tries to re-enable — and that re-enable fails for the new version.
        loader.getPlugin('svc-plg').status = plugin_interfaces_1.PluginStatus.ENABLED;
        const enableSpy = jest.spyOn(loader, 'enablePlugin').mockRejectedValue(new Error('worker failed to enable'));
        await expect(service.updatePackage('svc-plg', pkg({ version: '2.0.0' }))).rejects.toThrow(/Failed to update/i);
        // The rollback must leave the OLD version loaded — not the new, half-enabled (ERROR) instance.
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
        const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('1.0.0');
        enableSpy.mockRestore();
    });
    it('restores the previous version when shutdown begins while an update stops the running plugin', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        pluginStorage.setPluginEnabledByOperator('svc-plg', true);
        loader.getPlugin('svc-plg').status = plugin_interfaces_1.PluginStatus.ENABLED;
        // Hold the update inside unloadPlugin so teardown can begin while the old version is being stopped.
        let entered;
        const unloading = new Promise(resolve => (entered = resolve));
        let release;
        const gate = new Promise(resolve => (release = resolve));
        const realUnload = loader.unloadPlugin.bind(loader);
        jest.spyOn(loader, 'unloadPlugin').mockImplementationOnce(async (pluginId) => {
            entered();
            await gate;
            return realUnload(pluginId);
        });
        const enableSpy = jest.spyOn(loader, 'enablePlugin');
        const updating = service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        await unloading;
        const destroying = loader.onModuleDestroy();
        release();
        await expect(updating).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        await destroying;
        // The new version was never enabled, so it is not kept: the previous one is back, loaded and on disk.
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
        const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('1.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
        // Only the rollback's best-effort re-enable reached enablePlugin, and shutdown refused it.
        expect(enableSpy).toHaveBeenCalledTimes(1);
        await expect(enableSpy.mock.results[0].value).rejects.toThrow(/shutting down/);
        expect(loader.getPlugin('svc-plg')?.status).not.toBe(plugin_interfaces_1.PluginStatus.ENABLED);
        // The operator decision survives, so the next boot brings the previous version back up.
        expect(pluginStorage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(true);
    });
    it('restores the previous version when an update applies after shutdown already disabled the plugin', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        pluginStorage.setPluginEnabledByOperator('svc-plg', true);
        loader.getPlugin('svc-plg').status = plugin_interfaces_1.PluginStatus.ENABLED;
        // A slow download or a queued operation lets teardown disable the plugin before the update applies.
        await loader.onModuleDestroy();
        expect(loader.getPlugin('svc-plg')?.status).not.toBe(plugin_interfaces_1.PluginStatus.ENABLED);
        const unloadSpy = jest.spyOn(loader, 'unloadPlugin');
        await expect(service.updatePackage('svc-plg', pkg({ version: '2.0.0' }))).rejects.toBeInstanceOf(common_1.ServiceUnavailableException);
        // Refused before the swap: the previous version was never stopped and no plugin code ran.
        expect(unloadSpy).not.toHaveBeenCalled();
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
        const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('1.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
        // The next boot enables the previous version, not an untested new one.
        expect(pluginStorage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(true);
    });
    it('still applies an update of a plugin in ERROR once shutdown has begun', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        pluginStorage.setPluginEnabledByOperator('svc-plg', true);
        // For example its restore on boot failed: it is not running, and the update is likely the fix.
        loader.getPlugin('svc-plg').status = plugin_interfaces_1.PluginStatus.ERROR;
        await loader.onModuleDestroy();
        const dto = await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        expect(dto.version).toBe('2.0.0');
        const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('2.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
        expect(pluginStorage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(true);
    });
    it('still applies an update of a plugin the operator switched off once shutdown has begun', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        await loader.onModuleDestroy();
        const dto = await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        // Nothing will ever enable it, so there is nothing to prove and no reason to refuse the update.
        expect(dto.version).toBe('2.0.0');
        const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('2.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
        expect(pluginStorage.getPluginEntry('svc-plg')?.enabledByOperator).toBeFalsy();
    });
    it('cleans up the staging + backup dirs after a successful update (swap happened)', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        const dto = await service.updatePackage('svc-plg', pkg({ version: '2.0.0' }));
        expect(dto.version).toBe('2.0.0');
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('2.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
    });
    it('keeps the old install fully intact when the update fails BEFORE the swap (staging)', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        // A package whose entries collide as file-then-directory makes the staging WRITE fail:
        // 'index.js' lands as a file, then 'index.js/extra.js' needs it to be a directory.
        const z = new adm_zip_1.default();
        z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, version: '2.0.0' })));
        z.addFile('index.js', Buffer.from('module.exports = class {};'));
        z.addFile('index.js/extra.js', Buffer.from('module.exports = class {};'));
        await expect(service.updatePackage('svc-plg', z.toBuffer())).rejects.toThrow(/Failed to stage/i);
        // The old version never stopped being the install: still loaded, still on disk, no leftovers.
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
        const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('1.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
    });
    it('restores the previous version when the swap itself fails mid-way', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        // Let the first swap rename (live → backup) through, then fail the second (staging → live).
        const realRename = fs.renameSync;
        const spy = jest.spyOn(fs, 'renameSync').mockImplementation((a, b) => {
            if (String(a).endsWith('.new'))
                throw new Error('simulated swap failure');
            return realRename(a, b);
        });
        await expect(service.updatePackage('svc-plg', pkg({ version: '2.0.0' }))).rejects.toThrow(/Failed to update plugin/i);
        spy.mockRestore();
        // The failed swap must leave the OLD version loadable: backup restored on disk and reloaded.
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
        const onDisk = JSON.parse(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), 'utf8'));
        expect(onDisk.version).toBe('1.0.0');
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.new'))).toBe(false);
        expect(fs.existsSync(path.join(pluginsDir, '.svc-plg.bak'))).toBe(false);
    });
    it('serializes concurrent lifecycle operations on the same plugin id', async () => {
        service.install({ buffer: pkg() });
        let resolveFirst = () => undefined;
        const firstDone = new Promise(r => (resolveFirst = r));
        let calls = 0;
        jest.spyOn(loader, 'uninstallPlugin').mockImplementation(() => {
            calls++;
            return (calls === 1 ? firstDone : Promise.resolve()).then(() => ({ registryEntryKept: false }));
        });
        const p1 = service.uninstall('svc-plg');
        const p2 = service.uninstall('svc-plg');
        await Promise.resolve();
        await Promise.resolve();
        expect(calls).toBe(1); // the second op is queued behind the first, not run concurrently
        resolveFirst();
        await Promise.all([p1, p2]);
        expect(calls).toBe(2);
    });
    // A literal link-local IP is rejected synchronously by the SSRF guard before any fetch/DNS, so this
    // is fully offline. The download path follows redirects, so the guard always runs (no opt-out flag);
    // the rejected-IP detail must be redacted from the surfaced BadRequestException (recon oracle).
    it('installFromUrl redacts the resolved internal IP when the SSRF guard blocks the URL', async () => {
        const err = await service.installFromUrl('https://169.254.169.254/pkg.zip').catch((e) => e);
        expect(err).toBeInstanceOf(common_1.BadRequestException);
        const message = err.message;
        expect(message).toMatch(/^Failed to download plugin from URL: /);
        expect(message).not.toMatch(/169\.254\.169\.254/);
        expect(message).toBe('Failed to download plugin from URL: Destination address is not allowed');
    });
});
describe('PluginsService — download integrity + install-URL transport rule', () => {
    let tmpDir;
    let pluginsDir;
    let loader;
    let service;
    const fetchMock = plugin_download_1.fetchSafeBuffer;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-dl-integrity-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        const config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
        loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
        service = new plugins_service_1.PluginsService(loader, config);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    /** Queue a one-shot offline download; the mock then falls back to the real (SSRF-guarded) implementation. */
    const serveOnce = (buffer) => {
        fetchMock.mockImplementationOnce(() => Promise.resolve(buffer));
    };
    const sha256 = (buffer) => (0, crypto_1.createHash)('sha256').update(buffer).digest('hex');
    it('installs when the #sha256 fragment matches the downloaded bytes', async () => {
        const buf = pkg();
        serveOnce(buf);
        const dto = await service.installFromUrl(`https://plugins.example/svc-plg.zip#sha256=${sha256(buf)}`);
        expect(dto.id).toBe('svc-plg');
        expect(loader.getPlugin('svc-plg')).toBeDefined();
    });
    it('ignores a ?sha256= query parameter — only the #sha256= fragment pins the digest', async () => {
        const buf = pkg();
        serveOnce(buf);
        const wrong = '0'.repeat(64);
        // The query digest does not match the bytes, yet the install still succeeds on the fragment's
        // verdict: a query param is never an integrity marker (it belongs to the download host).
        const dto = await service.installFromUrl(`https://plugins.example/svc-plg.zip?sha256=${wrong}#sha256=${sha256(buf)}`);
        expect(dto.id).toBe('svc-plg');
        expect(loader.getPlugin('svc-plg')).toBeDefined();
    });
    it('fails closed when the pinned digest does not match (package substituted in transit)', async () => {
        serveOnce(pkg());
        const wrong = '0'.repeat(64);
        await expect(service.installFromUrl(`https://plugins.example/svc-plg.zip#sha256=${wrong}`)).rejects.toThrow(/integrity check failed/i);
        // Nothing was installed from the substituted bytes.
        expect(loader.getPlugin('svc-plg')).toBeUndefined();
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
    });
    it('rejects a malformed integrity marker instead of silently skipping verification', async () => {
        serveOnce(pkg());
        await expect(service.installFromUrl('https://plugins.example/svc-plg.zip#sha256=not-hex')).rejects.toThrow(/integrity check failed/i);
        expect(loader.getPlugin('svc-plg')).toBeUndefined();
    });
    it('rejects conflicting markers (fragment vs query disagree)', async () => {
        const buf = pkg();
        serveOnce(buf);
        const other = '1'.repeat(64);
        await expect(service.installFromUrl(`https://plugins.example/svc-plg.zip?sha256=${sha256(buf)}#sha256=${other}`)).rejects.toThrow(/integrity check failed/i);
    });
    it('installs without a marker (HTTPS + the SSRF guard remain the baseline)', async () => {
        serveOnce(pkg());
        const dto = await service.installFromUrl('https://plugins.example/svc-plg.zip');
        expect(dto.id).toBe('svc-plg');
    });
    it('rejects a plain http URL without a content pin BEFORE any fetch', async () => {
        fetchMock.mockClear();
        await expect(service.installFromUrl('http://plugins.example/svc-plg.zip')).rejects.toThrow(/#sha256=/);
        // Nothing was downloaded and nothing was installed.
        expect(fetchMock).not.toHaveBeenCalled();
        expect(loader.getPlugin('svc-plg')).toBeUndefined();
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
    });
    it('installs over plain http when the #sha256 pin matches the downloaded bytes', async () => {
        const buf = pkg();
        serveOnce(buf);
        const dto = await service.installFromUrl(`http://plugins.example/svc-plg.zip#sha256=${sha256(buf)}`);
        expect(dto.id).toBe('svc-plg');
        expect(loader.getPlugin('svc-plg')).toBeDefined();
    });
    it('fails closed over plain http when the pinned digest does not match', async () => {
        serveOnce(pkg());
        const wrong = '0'.repeat(64);
        await expect(service.installFromUrl(`http://plugins.example/svc-plg.zip#sha256=${wrong}`)).rejects.toThrow(/integrity check failed/i);
        expect(loader.getPlugin('svc-plg')).toBeUndefined();
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
    });
    it('updateFromUrl applies the same transport rule: plain http without a pin is rejected before any fetch', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        fetchMock.mockClear();
        await expect(service.updateFromUrl('svc-plg', 'http://plugins.example/svc-plg.zip')).rejects.toThrow(/#sha256=/);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
    });
    it('updateFromUrl fails closed on a mismatch and leaves the old version intact', async () => {
        service.install({ buffer: pkg({ version: '1.0.0' }) });
        serveOnce(pkg({ version: '2.0.0' }));
        const wrong = '0'.repeat(64);
        await expect(service.updateFromUrl('svc-plg', `https://plugins.example/svc-plg.zip#sha256=${wrong}`)).rejects.toThrow(/integrity check failed/i);
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
    });
});
describe('PluginsService — getConfigUiHtml (sandboxed config editor)', () => {
    let tmpDir;
    let pluginsDir;
    let loader;
    let service;
    const HTML = '<!doctype html><title>cfg</title><script>parent.postMessage({type:"config:get"},"*")</script>';
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-cfgui-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        const config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
        loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
        service = new plugins_service_1.PluginsService(loader, config);
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    function installUi(over = {}, files = {}) {
        const z = new adm_zip_1.default();
        z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, id: 'cfgui-plg', configUi: { entry: 'config/index.html' }, ...over })));
        z.addFile('index.js', Buffer.from('module.exports = class {};'));
        for (const [p, c] of Object.entries(files))
            z.addFile(p, Buffer.from(c));
        service.install({ buffer: z.toBuffer() });
    }
    it('serves the configUi entry HTML for an installed plugin', () => {
        installUi({}, { 'config/index.html': HTML });
        expect(service.getConfigUiHtml('cfgui-plg')).toBe(HTML);
    });
    it('exposes configUi on the DTO so the dashboard can render the iframe', () => {
        installUi({ configUi: { entry: 'config/index.html', height: 480 } }, { 'config/index.html': HTML });
        expect(service.findOne('cfgui-plg').configUi).toEqual({ entry: 'config/index.html', height: 480 });
    });
    it('throws NotFound when the plugin does not exist', () => {
        expect(() => service.getConfigUiHtml('ghost')).toThrow(/not found/i);
    });
    it('throws NotFound when the plugin declares no configUi', () => {
        const z = new adm_zip_1.default();
        z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, id: 'no-ui' })));
        z.addFile('index.js', Buffer.from('module.exports = class {};'));
        service.install({ buffer: z.toBuffer() });
        expect(() => service.getConfigUiHtml('no-ui')).toThrow(/config ui/i);
    });
    it('throws NotFound when the entry file is missing from the package', () => {
        installUi({ configUi: { entry: 'config/missing.html' } }, { 'config/index.html': HTML });
        expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/not found/i);
    });
    it('rejects a configUi entry that escapes the plugin directory (404, not a 500)', () => {
        installUi({ configUi: { entry: '../../../etc/passwd' } }, { 'config/index.html': HTML });
        expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/not found/i);
    });
    it('rejects a non-string configUi entry from an untrusted manifest', () => {
        installUi({ configUi: { entry: 123 } }, { 'config/index.html': HTML });
        expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/config ui/i);
    });
    it('rejects a configUi entry that is a symlink escaping the plugin directory', () => {
        installUi({ configUi: { entry: 'config/escape.html' } }, { 'config/index.html': HTML });
        const outside = path.join(tmpDir, 'outside-secret.txt');
        fs.writeFileSync(outside, 'TOP SECRET');
        fs.symlinkSync(outside, path.join(pluginsDir, 'cfgui-plg', 'config', 'escape.html'));
        expect(() => service.getConfigUiHtml('cfgui-plg')).toThrow(/not found/i);
    });
});
describe('PluginsService — per-session config', () => {
    let tmpDir;
    let pluginsDir;
    let loader;
    let service;
    const schemaManifest = {
        ...manifest,
        id: 'sess-cfg',
        configSchema: {
            type: 'object',
            properties: { apiKey: { type: 'string', secret: true }, lang: { type: 'string' } },
        },
    };
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-sesscfg-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        const config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
        loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
        service = new plugins_service_1.PluginsService(loader, config);
        const z = new adm_zip_1.default();
        z.addFile('manifest.json', Buffer.from(JSON.stringify(schemaManifest)));
        z.addFile('index.js', Buffer.from('module.exports = class {};'));
        service.install({ buffer: z.toBuffer() });
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('stores a per-session override and exposes it (secrets redacted) on the DTO', () => {
        service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: 'A-secret', lang: 'he' });
        const dto = service.findOne('sess-cfg');
        expect(dto.sessionConfig).toEqual({ 'sess-A': { apiKey: '***', lang: 'he' } });
    });
    it('restores the stored per-session secret when the incoming value is the sentinel', () => {
        service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: 'A-secret', lang: 'he' });
        // The dashboard PUTs the masked slice back; the real per-session secret must survive.
        service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: '***', lang: 'en' });
        expect(loader.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toEqual({ apiKey: 'A-secret', lang: 'en' });
    });
    // A session-restricted admin may write a session's override but cannot read its secrets, which come back masked.
    // Echoing the mask must not retarget a stored secret: it belongs to the host it was saved for.
    describe('with a host key the plugin may call', () => {
        const hostManifest = {
            ...manifest,
            id: 'sess-host',
            net: { allowConfigHosts: ['baseUrl'] },
            configSchema: {
                type: 'object',
                properties: { baseUrl: { type: 'string' }, apiKey: { type: 'string', secret: true } },
            },
        };
        const slice = () => loader.getPlugin('sess-host')?.sessionConfig?.['sess-A'];
        beforeEach(() => {
            const z = new adm_zip_1.default();
            z.addFile('manifest.json', Buffer.from(JSON.stringify(hostManifest)));
            z.addFile('index.js', Buffer.from('module.exports = class {};'));
            service.install({ buffer: z.toBuffer() });
            service.updateSessionConfig('sess-host', 'sess-A', { baseUrl: 'https://tenant.example', apiKey: 'TENANT' });
        });
        it('keeps restoring the stored secret while the write names the same host', () => {
            service.updateSessionConfig('sess-host', 'sess-A', { baseUrl: 'https://tenant.example/v2', apiKey: '***' });
            expect(slice()).toEqual({ baseUrl: 'https://tenant.example/v2', apiKey: 'TENANT' });
        });
        it('drops a masked or blank secret in a write that points the host at another origin', () => {
            for (const echoed of ['***', '']) {
                service.updateSessionConfig('sess-host', 'sess-A', { baseUrl: 'https://tenant.example', apiKey: 'TENANT' });
                service.updateSessionConfig('sess-host', 'sess-A', { baseUrl: 'https://attacker.example', apiKey: echoed });
                expect(slice()).toEqual({ baseUrl: 'https://attacker.example' });
            }
        });
        // The override names no host, so it resolves to the base host; a write that names that host moves nothing.
        it('judges a write against the base host when the stored override names none', () => {
            service.updateConfig('sess-host', { baseUrl: 'https://base.example', apiKey: 'BASE' });
            service.updateSessionConfig('sess-host', 'sess-A', { apiKey: 'OWN' });
            service.updateSessionConfig('sess-host', 'sess-A', { baseUrl: 'https://base.example/', apiKey: '***' });
            expect(slice()).toEqual({ baseUrl: 'https://base.example/', apiKey: 'OWN' });
            service.updateSessionConfig('sess-host', 'sess-A', { apiKey: 'OWN' });
            service.updateSessionConfig('sess-host', 'sess-A', { baseUrl: 'https://attacker.example', apiKey: '***' });
            expect(slice()).toEqual({ baseUrl: 'https://attacker.example' });
        });
        it('stores a secret the write brings itself, whatever the host', () => {
            service.updateSessionConfig('sess-host', 'sess-A', { baseUrl: 'https://other.example', apiKey: 'NEW' });
            expect(slice()).toEqual({ baseUrl: 'https://other.example', apiKey: 'NEW' });
        });
    });
    // A write is merged over the stored base config, so a removed secret has to travel as null; an empty
    // string is not a removal.
    it('removes the base secret on an explicit null and keeps it on an empty string', () => {
        service.updateConfig('sess-cfg', { apiKey: 'BASE', lang: 'en' });
        service.updateConfig('sess-cfg', { apiKey: '', lang: 'de' });
        expect(loader.getPlugin('sess-cfg')?.config).toEqual({ apiKey: 'BASE', lang: 'de' });
        expect(service.updateConfig('sess-cfg', { apiKey: null }).success).toBe(true);
        expect(loader.getPlugin('sess-cfg')?.config).toEqual({ apiKey: null, lang: 'de' });
        expect(service.findOne('sess-cfg').config).toEqual({ apiKey: null, lang: 'de' });
    });
    // The override slice replaces the stored one, and a session without its own secret inherits the base.
    it('drops a per-session secret sent as null, so the session inherits the base one', () => {
        service.updateConfig('sess-cfg', { apiKey: 'BASE' });
        service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: 'A-secret', lang: 'he' });
        service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: null, lang: 'he' });
        expect(loader.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toEqual({ lang: 'he' });
    });
    it('keeps the base config and per-session overrides independent', () => {
        service.updateConfig('sess-cfg', { apiKey: 'BASE', lang: 'en' });
        service.updateSessionConfig('sess-cfg', 'sess-A', { apiKey: 'A-secret', lang: 'he' });
        const plugin = loader.getPlugin('sess-cfg');
        expect(plugin?.config).toEqual({ apiKey: 'BASE', lang: 'en' });
        expect(plugin?.sessionConfig?.['sess-A']).toEqual({ apiKey: 'A-secret', lang: 'he' });
    });
    // The route is fenced with @RequireUnscopedKey, so the service signature no longer carries a
    // scope argument. updateSessions is a FULL replacement: each write overwrites the entire active
    // set, so the exact array survives each call (setPluginSessions assigns plugin.activeSessions).
    it('fully replaces the active set on each write (single, wildcard, then cleared)', () => {
        expect(service.updateSessions('sess-cfg', ['sess-A']).activeSessions).toEqual(['sess-A']);
        expect(service.updateSessions('sess-cfg', ['*']).activeSessions).toEqual(['*']);
        expect(service.updateSessions('sess-cfg', []).activeSessions).toEqual([]);
    });
    it('clears the override when an empty slice is written', () => {
        service.updateSessionConfig('sess-cfg', 'sess-A', { lang: 'he' });
        service.updateSessionConfig('sess-cfg', 'sess-A', {});
        expect(loader.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toBeUndefined();
    });
    it('404s for an unknown plugin', () => {
        expect(() => service.updateSessionConfig('ghost', 'sess-A', { lang: 'he' })).toThrow(/not found/i);
    });
    it('rejects per-session config for a global (non-session-scoped) plugin with 400', () => {
        const z = new adm_zip_1.default();
        z.addFile('manifest.json', Buffer.from(JSON.stringify({ ...manifest, id: 'global-plg', sessionScoped: false })));
        z.addFile('index.js', Buffer.from('module.exports = class {};'));
        service.install({ buffer: z.toBuffer() });
        expect(() => service.updateSessionConfig('global-plg', 'sess-A', { lang: 'he' })).toThrow(common_1.BadRequestException);
    });
    // A reload rebuilds the registry entry; it must NOT drop the operator's per-session config or
    // active-session selection. The wipe only surfaces on the SECOND restart (the first still has the
    // pre-wipe in-memory copy), so exercise two reload cycles.
    it('preserves per-session config and active sessions across two restarts', () => {
        const pluginDir = path.join(pluginsDir, 'sess-cfg');
        service.updateSessionConfig('sess-cfg', 'sess-A', { lang: 'he' });
        loader.setPluginSessions('sess-cfg', ['sess-A']);
        const reload = () => {
            const l = new plugin_loader_service_1.PluginLoaderService({
                get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
            }, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService({
                get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
            }), {});
            l.loadPlugin(pluginDir);
            return l;
        };
        const boot2 = reload();
        expect(boot2.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toEqual({ lang: 'he' });
        expect(boot2.getPlugin('sess-cfg')?.activeSessions).toEqual(['sess-A']);
        const boot3 = reload();
        expect(boot3.getPlugin('sess-cfg')?.sessionConfig?.['sess-A']).toEqual({ lang: 'he' });
        expect(boot3.getPlugin('sess-cfg')?.activeSessions).toEqual(['sess-A']);
    });
});
describe('PluginsService i18n passthrough', () => {
    function build(manifestI18n) {
        const plugin = {
            manifest: { id: 'p', name: 'P', version: '1.0.0', type: 'extension', main: 'dist/index.js', i18n: manifestI18n },
            status: 'enabled',
            config: {},
            activeSessions: ['*'],
        };
        const loader = {
            getAllPlugins: () => [plugin],
            getPlugin: () => plugin,
            isBuiltIn: () => false,
        };
        return new plugins_service_1.PluginsService(loader, { get: () => undefined });
    }
    it('surfaces manifest.i18n on the DTO (findOne + findAll)', () => {
        const i18n = { es: { name: 'P-es', config: { k: { title: 'T-es' } } } };
        const svc = build(i18n);
        expect(svc.findOne('p').i18n).toEqual(i18n);
        expect(svc.findAll()[0].i18n).toEqual(i18n);
    });
    it('leaves i18n undefined when the manifest has none', () => {
        const svc = build(undefined);
        expect(svc.findOne('p').i18n).toBeUndefined();
    });
});
describe('isIngressCapable', () => {
    it('is true when the manifest has an ingress route AND the webhook:ingress permission', () => {
        expect((0, plugins_service_1.isIngressCapable)({ ingress: [{ route: 'events' }], permissions: ['webhook:ingress'] })).toBe(true);
    });
    it('is false without an ingress route', () => {
        expect((0, plugins_service_1.isIngressCapable)({ ingress: [], permissions: ['webhook:ingress'] })).toBe(false);
        expect((0, plugins_service_1.isIngressCapable)({ permissions: ['webhook:ingress'] })).toBe(false);
    });
    it('is false without the webhook:ingress permission', () => {
        expect((0, plugins_service_1.isIngressCapable)({ ingress: [{ route: 'events' }], permissions: [] })).toBe(false);
        expect((0, plugins_service_1.isIngressCapable)({ ingress: [{ route: 'events' }] })).toBe(false);
    });
});
describe('PluginsService — disable when the plugin is not loaded', () => {
    let tmpDir;
    let pluginsDir;
    let config;
    const build = () => {
        const storage = new plugin_storage_service_1.PluginStorageService(config);
        const loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), storage, {});
        return { storage, loader, service: new plugins_service_1.PluginsService(loader, config) };
    };
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-disable-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    // Regression: a plugin whose package directory is gone (an interrupted update, or a directory that
    // was never on the data volume) still has a registry entry carrying enabledByOperator — the standing
    // instruction to enable it on every boot. disable() threw NotFound because the loader had nothing to
    // tear down, so the operator could not withdraw that decision by any route: reinstalling the code
    // brought the plugin straight back up.
    it('clears the boot decision for an installed plugin whose code is missing', async () => {
        const first = build();
        first.service.install({ buffer: pkg() });
        first.loader.setOperatorEnabled('svc-plg', true);
        // The code disappears; a restart re-reads the registry but loads nothing.
        fs.rmSync(path.join(pluginsDir, 'svc-plg'), { recursive: true, force: true });
        const restarted = build();
        expect(restarted.loader.getPlugin('svc-plg')).toBeUndefined();
        expect(restarted.storage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(true);
        const res = await restarted.service.disable('svc-plg');
        expect(res.success).toBe(true);
        expect(restarted.storage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(false);
    });
    it('still throws NotFound for an id with no registry entry at all', async () => {
        const { service } = build();
        await expect(service.disable('never-installed')).rejects.toThrow(/not found/i);
    });
});
describe('PluginsService: a plugin the boot restore has not finished with', () => {
    let tmpDir;
    let pluginsDir;
    let config;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-pending-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    // The restore enables outside the per-plugin chain once it outlasts the boot wait. A disable answered
    // "not enabled" would then be overtaken by the enable, and an uninstall would leave a worker running
    // under no map entry, so both wait for the restore instead of racing it.
    it('refuses enable, disable, update and uninstall of it, and leaves every other plugin alone', async () => {
        const storage = new plugin_storage_service_1.PluginStorageService(config);
        const loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), storage, {});
        const service = new plugins_service_1.PluginsService(loader, config);
        service.install({ buffer: pkg() });
        service.install({ buffer: pkg({ id: 'other-plg' }) });
        loader.setOperatorEnabled('svc-plg', true);
        jest.spyOn(loader, 'isRestorePending').mockImplementation(id => id === 'svc-plg');
        for (const attempt of [
            () => service.enable('svc-plg'),
            () => service.disable('svc-plg'),
            () => service.updatePackage('svc-plg', pkg({ version: '2.0.0' })),
            () => service.uninstall('svc-plg'),
        ]) {
            await expect(attempt()).rejects.toThrow(common_1.ConflictException);
            await expect(attempt()).rejects.toThrow(/still being restored/);
        }
        // Nothing changed: the operator's decision stands and the plugin is still installed.
        expect(storage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(true);
        expect(loader.getPlugin('svc-plg')?.manifest.version).toBe('1.0.0');
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(true);
        await expect(service.disable('other-plg')).resolves.toMatchObject({ success: true });
        await expect(service.uninstall('other-plg')).resolves.toMatchObject({ success: true });
    });
    it('takes the same changes again once the restore is done with it', async () => {
        const loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
        const service = new plugins_service_1.PluginsService(loader, config);
        service.install({ buffer: pkg() });
        const pending = jest.spyOn(loader, 'isRestorePending').mockReturnValue(true);
        await expect(service.uninstall('svc-plg')).rejects.toThrow(common_1.ConflictException);
        pending.mockReturnValue(false);
        await expect(service.uninstall('svc-plg')).resolves.toMatchObject({ success: true });
    });
});
describe('PluginsService: disable an engine plugin', () => {
    let tmpDir;
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const build = (status, engineType) => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-engine-'));
        const settings = {
            'plugins.dir': path.join(tmpDir, 'plugins'),
            dataDir: tmpDir,
            'engine.type': engineType,
        };
        const config = { get: (k) => settings[k] };
        const loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
        loader.registerBuiltInPlugin({ id: 'baileys', name: 'Baileys', version: '1.0.0', type: plugin_interfaces_1.PluginType.ENGINE, main: 'index.js' }, {});
        loader.getPlugin('baileys').status = status;
        return { loader, service: new plugins_service_1.PluginsService(loader, config) };
    };
    // The engine factory is pinned to engine.type and ignores plugin status, so a "disabled" engine kept
    // serving and was re-enabled on the next boot while the API reported it disabled.
    it.each([plugin_interfaces_1.PluginStatus.ENABLED, plugin_interfaces_1.PluginStatus.DISABLED])('refuses the active engine plugin in status %s and changes nothing', async (status) => {
        const { loader, service } = build(status, 'baileys');
        const disablePlugin = jest.spyOn(loader, 'disablePlugin');
        const setOperatorEnabled = jest.spyOn(loader, 'setOperatorEnabled');
        const res = await service.disable('baileys');
        expect(res.success).toBe(false);
        expect(res.message).toMatch(/engine\.type/);
        expect(disablePlugin).not.toHaveBeenCalled();
        expect(setOperatorEnabled).not.toHaveBeenCalled();
        expect(loader.getPlugin('baileys').status).toBe(status);
    });
    // An engine other than engine.type runs no sessions, so disabling it is an ordinary request.
    it('answers a loaded engine that is not the active one the way it answers any idle plugin', async () => {
        const { service } = build(plugin_interfaces_1.PluginStatus.DISABLED, 'whatsapp-web.js');
        await expect(service.disable('baileys')).resolves.toEqual({
            success: true,
            message: 'Plugin baileys is not enabled',
        });
    });
});
/**
 * Recovery for a plugin the gateway still has a registry entry for but whose code is gone — the
 * state the loader announces on every boot ("Reinstall it: its config and stored data are kept, unless an
 * uninstall stopped part-way").
 *
 * Under the shipped layout `plugins.dir` IS `<dataDir>/plugins`, so a plugin's package directory and
 * its `ctx.storage` directory are the same path. `ctx.storage` is created eagerly the first time the
 * plugin is enabled, so the directory outlives the package — which is exactly what a container
 * recreate leaves behind when the code lived in the image layer and the data on a volume. Both
 * recovery routes then asked the wrong oracle about it: install read the filesystem (a directory
 * exists, so 409) and uninstall read the runtime map (nothing loaded, so 404), leaving the entry,
 * its config and its secrets unremovable through the API.
 */
describe('PluginsService — recovering a plugin whose code went missing', () => {
    let tmpDir;
    let pluginsDir;
    let config;
    const build = () => {
        const storage = new plugin_storage_service_1.PluginStorageService(config);
        const loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), storage, {});
        return { storage, loader, service: new plugins_service_1.PluginsService(loader, config) };
    };
    /** Install, leave a `ctx.storage` file behind, then strip the package — the orphan state. */
    function orphan() {
        const first = build();
        first.service.install({ buffer: pkg() });
        first.loader.setOperatorEnabled('svc-plg', true);
        first.storage.setPluginConfig('svc-plg', { token: 'keep-me' });
        fs.writeFileSync(path.join(pluginsDir, 'svc-plg', 'key-abc.json'), '{"lastId":"msg-42"}');
        fs.rmSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'));
        fs.rmSync(path.join(pluginsDir, 'svc-plg', 'index.js'));
        const restarted = build();
        expect(restarted.loader.getPlugin('svc-plg')).toBeUndefined();
        expect(restarted.loader.getRegistryEntry('svc-plg')).toBeDefined();
        return restarted;
    }
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-orphan-'));
        pluginsDir = path.join(tmpDir, 'plugins');
        fs.mkdirSync(pluginsDir, { recursive: true });
        config = {
            get: (k) => (k === 'plugins.dir' ? pluginsDir : k === 'dataDir' ? tmpDir : undefined),
        };
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    it('reinstalls over the surviving storage directory, keeping config and stored data', () => {
        const { service, loader, storage } = orphan();
        const dto = service.install({ buffer: pkg() });
        expect(dto.id).toBe('svc-plg');
        expect(loader.getPlugin('svc-plg')).toBeDefined();
        // The two promises the boot warning makes: stored data and config both survive the reinstall.
        expect(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'key-abc.json'), 'utf8')).toContain('msg-42');
        expect(storage.getPluginConfig('svc-plg')).toEqual({ token: 'keep-me' });
        expect(storage.getPluginEntry('svc-plg')?.enabledByOperator).toBe(true);
    });
    it('uninstalls an orphan, taking the registry entry and the directory with it', async () => {
        const { service, storage } = orphan();
        const res = await service.uninstall('svc-plg');
        expect(res.success).toBe(true);
        expect(storage.getPluginEntry('svc-plg')).toBeUndefined();
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg'))).toBe(false);
    });
    it('does not delete surviving stored data when the reinstall itself fails', () => {
        // Narrowing the install guard turns the rollback into a data-loss path: it used to remove a
        // directory install had just created, and would now remove one holding the operator's data.
        const { service, loader } = orphan();
        jest.spyOn(loader, 'loadPlugin').mockImplementation(() => {
            throw new Error('bad package');
        });
        expect(() => service.install({ buffer: pkg() })).toThrow(common_1.BadRequestException);
        expect(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'key-abc.json'), 'utf8')).toContain('msg-42');
    });
    it('still refuses to install over a directory the gateway does not own', () => {
        const { service } = build();
        fs.mkdirSync(path.join(pluginsDir, 'svc-plg'), { recursive: true });
        fs.writeFileSync(path.join(pluginsDir, 'svc-plg', 'operator-notes.txt'), 'not ours');
        // No registry entry: the gateway never installed this, so merging a package into it would
        // silently adopt whatever is already there.
        expect(() => service.install({ buffer: pkg() })).toThrow(common_1.ConflictException);
    });
    it('still refuses a duplicate install of a loaded plugin', () => {
        const { service } = build();
        service.install({ buffer: pkg() });
        expect(() => service.install({ buffer: pkg() })).toThrow(common_1.ConflictException);
    });
    it('refuses a plugin path that is a symlink escaping the plugins directory', () => {
        // `existsSync` follows symlinks, so the unconditional guard this replaced happened to refuse
        // this too. Narrowing it to registry-owned directories must not hand the reinstall a path that
        // resolves outside the plugins dir: every write below goes through the link, and so does the
        // rollback's delete.
        const outside = path.join(tmpDir, 'outside');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, 'manifest.json'), 'victim');
        const { service, storage } = orphan();
        fs.rmSync(path.join(pluginsDir, 'svc-plg'), { recursive: true, force: true });
        fs.symlinkSync(outside, path.join(pluginsDir, 'svc-plg'));
        expect(storage.getPluginEntry('svc-plg')).toBeDefined();
        expect(() => service.install({ buffer: pkg() })).toThrow(common_1.ConflictException);
        expect(fs.readFileSync(path.join(outside, 'manifest.json'), 'utf8')).toBe('victim');
    });
    it('does not delete a file the failed install never got as far as writing', () => {
        // The rollback removes what this install wrote. Removing every entry path instead would reach
        // files the write never reached — the previous version's, still sitting in a directory the
        // reinstall was supposed to leave intact.
        const { service } = orphan();
        fs.writeFileSync(path.join(pluginsDir, 'svc-plg', 'index.js'), 'previous version');
        // Fail the very first write, so the install has written nothing: every entry path still holds
        // whatever was there before, and the rollback must leave all of it alone.
        const write = jest.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
            throw new Error('disk full');
        });
        expect(() => service.install({ buffer: pkg() })).toThrow(common_1.BadRequestException);
        expect(fs.readFileSync(path.join(pluginsDir, 'svc-plg', 'index.js'), 'utf8')).toBe('previous version');
        write.mockRestore();
    });
    it('answers a conflict, not a crash, when a package entry path is occupied by a directory', () => {
        // The write fails with EISDIR, and the rollback's `rmSync(..., { force: true })` fails the same
        // way — `force` suppresses ENOENT, not EISDIR — so without care the second throw escapes the
        // catch entirely and the route answers 500 where it used to answer 409.
        const { service } = orphan();
        fs.mkdirSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'), { recursive: true });
        expect(() => service.install({ buffer: pkg() })).toThrow(common_1.ConflictException);
    });
    it('still throws NotFound when uninstalling an id the gateway has never seen', async () => {
        const { service } = build();
        await expect(service.uninstall('never-installed')).rejects.toThrow(common_1.NotFoundException);
    });
    it('refuses to uninstall a built-in whose code is not loaded', async () => {
        const { service, storage } = build();
        storage.setPluginEntry({
            id: 'whatsapp-web.js',
            type: plugin_interfaces_1.PluginType.ENGINE,
            name: 'WhatsApp Web',
            version: '1.0.0',
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: {},
            builtIn: true,
            installedAt: new Date(),
            updatedAt: new Date(),
        });
        // Reaching the loader's built-in check is the point: this used to 404 as "unknown id", which
        // docs/06 already described as a 400.
        await expect(service.uninstall('whatsapp-web.js')).rejects.toThrow(common_1.BadRequestException);
        expect(storage.getPluginEntry('whatsapp-web.js')).toBeDefined();
    });
    it('merges the new package over the old files rather than replacing the directory', () => {
        // Accepted residual, pinned here so it is a decision rather than a surprise: the directory also
        // holds ctx.storage under the shipped layout, so a reinstall cannot clear it first. A file the
        // previous package version shipped and the new one dropped therefore stays on disk. It is inert
        // — nothing loads a file the manifest does not point at — but it is not cleaned up.
        const first = build();
        first.service.install({ buffer: pkg() });
        fs.writeFileSync(path.join(pluginsDir, 'svc-plg', 'legacy.js'), 'module.exports = {};');
        fs.rmSync(path.join(pluginsDir, 'svc-plg', 'manifest.json'));
        build().service.install({ buffer: pkg({ version: '2.0.0' }) });
        expect(fs.existsSync(path.join(pluginsDir, 'svc-plg', 'legacy.js'))).toBe(true);
    });
});
describe('PluginsService remote catalog', () => {
    const fetchMock = plugin_download_1.fetchSafeBuffer;
    const service = () => {
        const config = {
            get: (k) => (k === 'plugins.catalogUrl' ? 'https://catalog.example/plugins.json' : undefined),
        };
        return new plugins_service_1.PluginsService({ getAllPlugins: () => [] }, config);
    };
    const serveOnce = (json) => {
        fetchMock.mockImplementationOnce(() => Promise.resolve(Buffer.from(json)));
    };
    it('keeps unknown extra fields and every optional field of the right type', async () => {
        serveOnce('[{"id":"a","name":"A","version":"1.0.0","description":"d","keywords":["x"],"stars":5,"download":"https://x/a.zip"}]');
        await expect(service().getCatalog()).resolves.toMatchObject([{ id: 'a', stars: 5, keywords: ['x'] }]);
    });
    it('accepts null in optional fields', async () => {
        serveOnce('[{"id":"a","name":"A","version":"1.0.0","homepage":null,"keywords":null}]');
        const [entry] = await service().getCatalog();
        expect(entry).toMatchObject({ id: 'a', installed: false });
        expect(entry).not.toHaveProperty('homepage');
        expect(entry).not.toHaveProperty('keywords');
    });
    it('annotates a well-formed catalog', async () => {
        serveOnce('[{"id":"a","name":"A","version":"1.0.0"}]');
        await expect(service().getCatalog()).resolves.toEqual([
            { id: 'a', name: 'A', version: '1.0.0', installed: false, installedVersion: null, updateAvailable: false },
        ]);
    });
    it.each([
        '[null]',
        '[{"id":"a","name":"A","version":"1.0.0"},5]',
        '[[]]',
        '[{"id":"a","name":{},"version":"1.0.0"}]',
        '[{"id":"a","name":"A","version":"1.0.0","description":7}]',
        '[{"id":"a","name":"A"}]',
        '[{"id":"","name":"A","version":"1.0.0"}]',
        '[{"id":"a","name":"A","version":"1.0.0","keywords":"x"}]',
    ])('answers 400, not 500, for a catalog with a malformed entry (%s)', async (json) => {
        serveOnce(json);
        const err = await service()
            .getCatalog()
            .catch((e) => e);
        expect(err).toBeInstanceOf(common_1.BadRequestException);
        expect(err.message).toMatch(/Invalid plugin catalog JSON/);
    });
});
