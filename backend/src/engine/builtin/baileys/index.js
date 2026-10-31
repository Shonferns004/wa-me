"use strict";
/**
 * Baileys Engine Plugin
 * Built-in engine plugin that wraps the @whiskeysockets/baileys library.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaileysPlugin = void 0;
const plugins_1 = require("../../../core/plugins");
const baileys_adapter_1 = require("../../adapters/baileys.adapter");
class BaileysPlugin {
    messageStore;
    registeredConfig;
    lidMappingStore;
    chatStateStore;
    type = plugins_1.PluginType.ENGINE;
    context;
    // RegisteredConfig (the engine config blob) is also supplied at construction so createEngine
    // has operator config even if enablePlugin fails before onLoad runs (this.context stays unset). The
    // healthy path still prefers context.config (it carries any persisted-override merge).
    constructor(messageStore, registeredConfig, lidMappingStore, chatStateStore) {
        this.messageStore = messageStore;
        this.registeredConfig = registeredConfig;
        this.lidMappingStore = lidMappingStore;
        this.chatStateStore = chatStateStore;
    }
    onLoad(context) {
        this.context = context;
        context.logger.log('Baileys engine plugin loaded');
        return Promise.resolve();
    }
    onEnable(context) {
        context.logger.log('Baileys engine plugin enabled');
        return Promise.resolve();
    }
    onDisable(context) {
        context.logger.log('Baileys engine plugin disabled');
        return Promise.resolve();
    }
    createEngine(config) {
        const sessionId = config.sessionId;
        const dbSessionId = config.dbSessionId;
        const proxyUrl = config.proxyUrl;
        // Baileys' own config namespace, read from the opaque per-engine blob the factory supplies via
        // context.config (the `engine` sub-tree in configuration.ts). Per-call config carries
        // engine-neutral fields (sessionId, proxy) plus authDir, the base the factory hardens and purges,
        // which wins over context.config.
        const engineConfig = (this.context?.config ?? this.registeredConfig ?? {});
        const authDir = config.authDir ?? engineConfig.baileys?.authDir ?? './data/baileys';
        return new baileys_adapter_1.BaileysAdapter({
            sessionId,
            dbSessionId,
            authDir,
            proxyUrl,
            messageStore: this.messageStore,
            lidMappingStore: this.lidMappingStore,
            chatStateStore: this.chatStateStore,
        });
    }
    getFeatures() {
        return [
            'text-messages',
            'typing-indicator',
            'media-messages',
            'location-messages',
            'contact-messages',
            'message-replies',
            'message-forwarding',
            'message-reactions',
            'message-deletion',
            'group-management',
            'read-receipts',
            'channels',
            'status-updates',
            'catalog',
            // No 'labels': Baileys can create, delete and attach labels but has no query for them, so the
            // label and chat-label reads 501 and a client could not read back what it wrote.
        ];
    }
    getEngineLibrary() {
        let version = 'unknown';
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            version = require('@whiskeysockets/baileys/package.json').version;
        }
        catch {
            // Keep 'unknown' if the package metadata can't be resolved at runtime.
        }
        return { name: '@whiskeysockets/baileys', version };
    }
    healthCheck() {
        return Promise.resolve({ healthy: true, message: 'Baileys engine is available' });
    }
}
exports.BaileysPlugin = BaileysPlugin;
exports.default = BaileysPlugin;
