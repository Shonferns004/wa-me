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
// A built-in engine's config is its env-derived blob, and the engine manifests declare no configSchema, so
// GET /plugins masks every value. PUT /plugins/:id/config takes a mask as "unchanged". Sending back what GET
// returned, with one key set, must persist only that key: the env-derived keys have to stay live, so a later
// .env change (a new Chromium path on a new image) still reaches the engine after a restart.
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const plugins_service_1 = require("./plugins.service");
const redact_config_1 = require("./redact-config");
const plugin_loader_service_1 = require("../../core/plugins/plugin-loader.service");
const plugin_storage_service_1 = require("../../core/plugins/plugin-storage.service");
const plugin_interfaces_1 = require("../../core/plugins/plugin.interfaces");
const hooks_1 = require("../../core/hooks");
const engine = { id: 'whatsapp-web.js', name: 'WhatsApp Web.js Engine', version: '1.0.0', type: plugin_interfaces_1.PluginType.ENGINE };
describe('PUT /plugins/:id/config on a built-in engine with the masked config sent back', () => {
    let tmpDir;
    let config;
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-echo-'));
        config = {
            get: (k) => (k === 'dataDir' ? tmpDir : k === 'plugins.dir' ? path.join(tmpDir, 'plugins') : undefined),
        };
    });
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
    const boot = (envConfig) => {
        const loader = new plugin_loader_service_1.PluginLoaderService(config, new hooks_1.HookManager(), new plugin_storage_service_1.PluginStorageService(config), {});
        loader.registerBuiltInPlugin({ ...engine, main: 'index.js' }, {}, envConfig);
        return { loader, service: new plugins_service_1.PluginsService(loader, config) };
    };
    it('persists only the key the request set, so the env-derived keys follow the next .env', () => {
        const first = boot({ puppeteer: { executablePath: '/old/chromium' }, sessionDataPath: './data/sessions' });
        const shown = first.service.findOne('whatsapp-web.js').config;
        expect(shown.puppeteer).toBe(redact_config_1.SECRET_SENTINEL);
        const res = first.service.updateConfig('whatsapp-web.js', { ...shown, operatorKey: 'set' });
        expect(res.success).toBe(true);
        const second = boot({ puppeteer: { executablePath: '/new/chromium' }, sessionDataPath: './data/sessions' });
        expect(second.loader.getPlugin('whatsapp-web.js')?.config).toEqual({
            puppeteer: { executablePath: '/new/chromium' },
            sessionDataPath: './data/sessions',
            operatorKey: 'set',
        });
    });
    it('keeps a key the operator stored earlier when its mask is sent back', () => {
        const first = boot({ puppeteer: { executablePath: '/old/chromium' } });
        first.service.updateConfig('whatsapp-web.js', { puppeteer: { executablePath: '/pinned/chromium' } });
        const shown = first.service.findOne('whatsapp-web.js').config;
        expect(first.service.updateConfig('whatsapp-web.js', { ...shown, operatorKey: 'set' }).success).toBe(true);
        const second = boot({ puppeteer: { executablePath: '/new/chromium' } });
        expect(second.loader.getPlugin('whatsapp-web.js')?.config).toEqual({
            puppeteer: { executablePath: '/pinned/chromium' },
            operatorKey: 'set',
        });
    });
    it('keeps the stored secret of a plugin with a schema when its mask is sent back', () => {
        const pluginsDir = path.join(tmpDir, 'plugins');
        const dir = path.join(pluginsDir, 'relay');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
            id: 'relay',
            name: 'Relay',
            version: '1.0.0',
            type: 'extension',
            main: 'index.js',
            configSchema: {
                type: 'object',
                properties: { apiKey: { type: 'string', secret: true }, lang: { type: 'string', default: 'en' } },
            },
        }));
        fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = class {};');
        const { loader, service } = boot({});
        loader.loadPlugin(dir);
        service.updateConfig('relay', { apiKey: 'sk-live' });
        const shown = service.findOne('relay').config;
        expect(shown).toEqual({ apiKey: redact_config_1.SECRET_SENTINEL, lang: 'en' });
        expect(service.updateConfig('relay', { ...shown, lang: 'de' }).success).toBe(true);
        expect(loader.getPlugin('relay')?.config).toEqual({ apiKey: 'sk-live', lang: 'de' });
        expect(loader.getRegistryEntry('relay')?.config).toEqual({ apiKey: 'sk-live', lang: 'de' });
    });
});
