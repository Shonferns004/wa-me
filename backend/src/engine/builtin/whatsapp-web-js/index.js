"use strict";
/**
 * WhatsApp-web.js Engine Plugin
 * Built-in engine plugin that wraps the whatsapp-web.js library
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsAppWebJsPlugin = void 0;
const plugins_1 = require("../../../core/plugins");
const whatsapp_web_js_adapter_1 = require("../../adapters/whatsapp-web-js.adapter");
class WhatsAppWebJsPlugin {
    registeredConfig;
    lidMappingStore;
    type = plugins_1.PluginType.ENGINE;
    context;
    // The engine config blob is also supplied at construction so createEngine has operator
    // config even if enablePlugin fails before onLoad runs (which would leave this.context unset).
    // The healthy path still prefers context.config (it carries any persisted-override merge).
    constructor(registeredConfig, 
    // Shared lid<->phone table, threaded to the adapter so it can persist learned phone->lid pairs
    // (mirrors how BaileysPlugin receives it; #583 R3).
    lidMappingStore) {
        this.registeredConfig = registeredConfig;
        this.lidMappingStore = lidMappingStore;
    }
    onLoad(context) {
        this.context = context;
        context.logger.log('WhatsApp-web.js engine plugin loaded');
        return Promise.resolve();
    }
    onEnable(context) {
        context.logger.log('WhatsApp-web.js engine plugin enabled');
        return Promise.resolve();
    }
    onDisable(context) {
        context.logger.log('WhatsApp-web.js engine plugin disabled');
        return Promise.resolve();
    }
    createEngine(config) {
        const sessionId = config.sessionId;
        const proxyUrl = config.proxyUrl;
        const proxyType = config.proxyType;
        // Browser config is this engine's OWN namespace, read from the opaque per-engine blob the
        // factory supplies via context.config (the `engine` sub-tree in configuration.ts). The
        // per-call config carries engine-neutral fields (sessionId, proxy) plus sessionDataPath, the base
        // the factory hardens and purges, which wins over context.config.
        const engineConfig = (this.context?.config ?? this.registeredConfig ?? {});
        const puppeteer = engineConfig.puppeteer ?? {};
        const sessionDataPath = config.sessionDataPath ?? engineConfig.sessionDataPath ?? './data/sessions';
        const headless = puppeteer.headless ?? true;
        // No default here: the adapter owns the fallback flag list (DEFAULT_PUPPETEER_ARGS), so a persisted
        // plugin config whose `puppeteer` object has no `args` still launches with the documented flags.
        const puppeteerArgs = puppeteer.args;
        const executablePath = puppeteer.executablePath;
        const protocolTimeoutMs = puppeteer.protocolTimeoutMs;
        return new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({
            sessionId,
            sessionDataPath,
            puppeteer: {
                headless,
                args: puppeteerArgs,
                executablePath,
                protocolTimeoutMs,
            },
            proxy: proxyUrl
                ? {
                    url: proxyUrl,
                    type: proxyType ?? 'http',
                }
                : undefined,
            lidMappingStore: this.lidMappingStore,
        });
    }
    getFeatures() {
        return [
            'text-messages',
            'media-messages',
            'location-messages',
            'contact-messages',
            'group-management',
            'message-reactions',
            'message-replies',
            'message-forwarding',
            'message-deletion',
            'read-receipts',
            'typing-indicator',
            'labels',
            'channels',
            'status-updates',
            // No 'catalog': whatsapp-web.js has no catalog/product API, so the adapter 501s those methods —
            // advertising the feature here would promise clients a capability the engine cannot deliver.
        ];
    }
    getEngineLibrary() {
        // The actual whatsapp-web.js library version (e.g. 1.34.7), surfaced so operators can see which
        // engine version is really running — distinct from this adapter plugin's manifest version (1.0.0).
        let version = 'unknown';
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            version = require('whatsapp-web.js/package.json').version;
        }
        catch {
            // Keep 'unknown' if the package metadata can't be resolved at runtime.
        }
        return { name: 'whatsapp-web.js', version };
    }
    healthCheck() {
        return Promise.resolve({ healthy: true, message: 'WhatsApp-web.js engine is available' });
    }
}
exports.WhatsAppWebJsPlugin = WhatsAppWebJsPlugin;
exports.default = WhatsAppWebJsPlugin;
