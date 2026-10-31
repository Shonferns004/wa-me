"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginHostServices = void 0;
const plugin_host_ports_1 = require("./plugin-host-ports");
/**
 * Resolves the host services a plugin capability reaches, at call time rather than at module load.
 *
 * Every lookup is a non-strict `ModuleRef.get` against a core-owned port token from
 * plugin-host-ports.ts, and the deferral is load-bearing: constructor injection would close the
 * provider cycle
 * `PluginLoaderService -> SessionService -> SessionEngineLifecycle -> EngineFactory -> PluginLoaderService`.
 * Resolving the PORT tokens rather than the feature-module service classes also means this file
 * names no feature module at all — no static import edge, and no lazy `require` either. The module
 * that owns each service registers the token adapter, so the binding lives with the service while
 * core/plugins depends only on its own tokens.
 *
 * Keeping the lookups in one place means the loader never has to carry that reasoning, nor name the
 * five ports it was resolving. Everything below is a resolution detail; nothing here decides policy.
 */
class PluginHostServices {
    moduleRef;
    constructor(moduleRef) {
        this.moduleRef = moduleRef;
    }
    getMessagePort() {
        return this.moduleRef.get(plugin_host_ports_1.PLUGIN_MESSAGE_PORT, { strict: false });
    }
    getSessionPort() {
        return this.moduleRef.get(plugin_host_ports_1.PLUGIN_SESSION_PORT, { strict: false });
    }
    getConversationMappingPort() {
        return this.moduleRef.get(plugin_host_ports_1.PLUGIN_CONVERSATION_MAPPING_PORT, { strict: false });
    }
    getPluginInstancePort() {
        return this.moduleRef.get(plugin_host_ports_1.PLUGIN_INSTANCE_PORT, {
            strict: false,
        });
    }
    /**
     * Search is conditionally loaded (`SEARCH_ENABLED=false` omits SearchModule), so the port adapter
     * may not be registered at all. Returns undefined in that case so callers can no-op rather than throw.
     */
    getSearchRegistryPort() {
        try {
            return this.moduleRef.get(plugin_host_ports_1.PLUGIN_SEARCH_REGISTRY_PORT, { strict: false });
        }
        catch {
            return undefined;
        }
    }
}
exports.PluginHostServices = PluginHostServices;
