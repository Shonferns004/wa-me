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
const hooks_1 = require("../hooks");
const plugin_interfaces_1 = require("./plugin.interfaces");
const plugin_worker_host_1 = require("./sandbox/plugin-worker-host");
const worker_thread_channel_1 = require("./sandbox/worker-thread-channel");
// A config saved while a sandboxed plugin is still enabling must reach the plugin's worker: outside a hook
// the worker answers ctx.config from the base config it was last handed, so a save that is never handed
// over leaves the plugin running on the config it had before the save, until the next save.
const BOOTSTRAP = path.resolve(__dirname, 'sandbox', 'worker-bootstrap.js');
const TS_NODE_OPTS = JSON.stringify({
    module: 'commonjs',
    moduleResolution: 'node',
    resolvePackageJsonExports: false,
    ignoreDeprecations: '6.0',
});
// The plugin keeps its context and reports ctx.config.mode from its health check, which runs outside any
// hook, so it reads the worker's base config.
const PLUGIN_SOURCE = `module.exports = class {
  async onEnable(ctx) {
    this.ctx = ctx;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  healthCheck() {
    return { healthy: true, message: String(this.ctx.config.mode) };
  }
};
`;
class RealWorkerLoader extends plugin_loader_service_1.PluginLoaderService {
    onEnableStarted;
    createSandboxHost(capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, onSearchProviderRegister, onWorkerExit, onUnresponsive) {
        const host = new plugin_worker_host_1.PluginWorkerHost(new worker_thread_channel_1.WorkerThreadChannel({
            workerEntry: BOOTSTRAP,
            execArgv: [],
            env: { ...process.env, TS_NODE_COMPILER_OPTIONS: TS_NODE_OPTS },
        }), capDispatcher, onHookSubscribe, onWebhookSubscribe, onLog, runWithHookGuard, 32, onSearchProviderRegister, onWorkerExit, 30000, 5000, onUnresponsive);
        const runLifecycle = host.runLifecycle.bind(host);
        host.runLifecycle = (method, timeoutMs) => {
            const running = runLifecycle(method, timeoutMs);
            if (method === 'onEnable')
                this.onEnableStarted?.();
            return running;
        };
        return host;
    }
}
describe('PluginLoaderService: a config saved while a sandboxed plugin is enabling', () => {
    jest.setTimeout(30000);
    let tmp;
    let loader;
    beforeEach(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-config-during-enable-'));
        fs.mkdirSync(path.join(tmp, 'p1'));
        fs.writeFileSync(path.join(tmp, 'p1', 'index.cjs'), PLUGIN_SOURCE);
        let stored = { mode: 'old' };
        const pluginStorage = {
            createPluginStorage: jest.fn().mockReturnValue({}),
            getPluginConfig: jest.fn(() => stored),
            setPluginConfig: jest.fn((_id, config) => {
                stored = config;
            }),
            getPluginEntry: jest.fn().mockReturnValue(undefined),
            setPluginEntry: jest.fn(),
            setPluginStatus: jest.fn(),
        };
        const configService = { get: jest.fn().mockReturnValue(undefined) };
        const moduleRef = { get: jest.fn().mockReturnValue(undefined) };
        loader = new RealWorkerLoader(configService, new hooks_1.HookManager(), pluginStorage, moduleRef);
        const plugin = {
            manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.cjs' },
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: { mode: 'old' },
            instance: null,
            builtIn: false,
            packageDir: path.join(tmp, 'p1'),
        };
        loader.plugins.set('p1', plugin);
    });
    afterEach(async () => {
        await loader.disablePlugin('p1').catch(() => undefined);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    it('is handed to the worker once the enable completes', async () => {
        const onEnableStarted = new Promise(resolve => (loader.onEnableStarted = resolve));
        const enabling = loader.enablePlugin('p1');
        await onEnableStarted;
        // The operator saves the config while onEnable is still running in the worker.
        loader.updatePluginConfig('p1', { mode: 'new' });
        await enabling;
        expect(loader.getPlugin('p1')?.status).toBe(plugin_interfaces_1.PluginStatus.ENABLED);
        expect(loader.getPlugin('p1')?.config).toEqual({ mode: 'new' });
        await expect(loader.checkPluginHealth('p1')).resolves.toMatchObject({ message: 'new' });
    });
    it('is handed to the worker when saved after the enable completed', async () => {
        await loader.enablePlugin('p1');
        loader.updatePluginConfig('p1', { mode: 'new' });
        await expect(loader.checkPluginHealth('p1')).resolves.toMatchObject({ message: 'new' });
    });
});
/** Records every call the loader makes on its worker host, in order; onEnable settles when the test says so. */
class RecordingLoader extends plugin_loader_service_1.PluginLoaderService {
    calls = [];
    pushed = [];
    settleOnEnable = () => undefined;
    onEnableStarted;
    createSandboxHost() {
        const host = {
            load: jest.fn(() => Promise.resolve(void this.calls.push('load'))),
            runLifecycle: jest.fn((method) => {
                this.calls.push(`lifecycle:${method}`);
                if (method !== 'onEnable')
                    return Promise.resolve();
                return new Promise((resolve, reject) => {
                    this.settleOnEnable = error => (error ? reject(error) : resolve());
                    this.onEnableStarted?.();
                });
            }),
            sendConfigChange: jest.fn((config) => {
                this.calls.push('config-change');
                this.pushed.push(config);
            }),
            terminate: jest.fn(() => Promise.resolve(void this.calls.push('terminate'))),
        };
        return host;
    }
}
describe('PluginLoaderService: the config push after a sandboxed enable', () => {
    const makeLoader = () => {
        const pluginStorage = {
            createPluginStorage: jest.fn().mockReturnValue({}),
            getPluginConfig: jest.fn().mockReturnValue({}),
            setPluginConfig: jest.fn(),
            getPluginEntry: jest.fn().mockReturnValue(undefined),
            setPluginStatus: jest.fn(),
        };
        const loader = new RecordingLoader({ get: jest.fn().mockReturnValue(undefined) }, new hooks_1.HookManager(), pluginStorage, { get: jest.fn().mockReturnValue(undefined) });
        const plugin = {
            manifest: { id: 'p1', name: 'P1', version: '1.0.0', type: plugin_interfaces_1.PluginType.EXTENSION, main: 'index.cjs' },
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: { mode: 'old' },
            instance: null,
            builtIn: false,
            packageDir: path.join(os.tmpdir(), 'p1'),
        };
        loader.plugins.set('p1', plugin);
        return loader;
    };
    // Wrapped: an async function returning the enable promise itself would wait for the enable to settle.
    const startEnable = async (loader) => {
        const started = new Promise(resolve => (loader.onEnableStarted = resolve));
        const enabling = loader.enablePlugin('p1');
        await started;
        return { enabling };
    };
    it('sends a config saved during onEnable only after onEnable finished', async () => {
        const loader = makeLoader();
        const { enabling } = await startEnable(loader);
        loader.updatePluginConfig('p1', { mode: 'new' });
        expect(loader.calls).not.toContain('config-change');
        loader.settleOnEnable();
        await enabling;
        expect(loader.calls).toEqual(['load', 'lifecycle:onLoad', 'lifecycle:onEnable', 'config-change']);
        expect(loader.pushed).toEqual([{ mode: 'new' }]);
    });
    it('sends one push carrying the last of several saves made during onEnable', async () => {
        const loader = makeLoader();
        const { enabling } = await startEnable(loader);
        loader.updatePluginConfig('p1', { mode: 'mid' });
        loader.updatePluginConfig('p1', { other: 1 });
        loader.settleOnEnable();
        await enabling;
        expect(loader.pushed).toEqual([{ mode: 'mid', other: 1 }]);
    });
    it('sends nothing when no config was saved during the enable', async () => {
        const loader = makeLoader();
        const { enabling } = await startEnable(loader);
        loader.settleOnEnable();
        await enabling;
        expect(loader.calls).not.toContain('config-change');
    });
    it('sends nothing when the enable fails', async () => {
        const loader = makeLoader();
        const { enabling } = await startEnable(loader);
        loader.updatePluginConfig('p1', { mode: 'new' });
        loader.settleOnEnable(new Error('onEnable failed'));
        await expect(enabling).rejects.toThrow('onEnable failed');
        expect(loader.calls).not.toContain('config-change');
        expect(loader.getPlugin('p1')?.status).toBe(plugin_interfaces_1.PluginStatus.ERROR);
    });
});
