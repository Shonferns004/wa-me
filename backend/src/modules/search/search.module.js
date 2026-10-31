"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SearchModule = void 0;
exports.bootstrapSearchProviders = bootstrapSearchProviders;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const search_controller_1 = require("./search.controller");
const search_service_1 = require("./search.service");
const search_provider_registry_1 = require("./search-provider.registry");
const builtin_fts_provider_1 = require("./providers/builtin-fts.provider");
const plugin_host_ports_1 = require("../../core/plugins/plugin-host-ports");
/**
 * Wires the global search feature: the route (SearchController), the service layer (SearchService),
 * the provider registry, and the built-in DB-native FTS provider. The `SEARCH_BOOTSTRAP` factory runs
 * at DI time via `bootstrapSearchProviders` to register `builtin-fts` and make it the active provider.
 *
 * `SEARCH_PROVIDER=none` is honored by leaving the registry empty: the module (and route) stay loaded
 * but `SearchService.search()` throws NotImplementedException → /search returns 501. This is distinct
 * from `SEARCH_ENABLED=false`, which omits the module entirely (route 404).
 *
 * The module is imported by AppModule only when `SEARCH_ENABLED !== 'false'`. Plugin providers
 * register themselves through the same registry; in `auto` mode the most recently registered plugin
 * supersedes builtin (no health gating).
 *
 * Global and exporting SearchService so the agent-tool registry (MessageSearch) can inject it as an
 * optional dependency: importing this module there would load search even when SEARCH_ENABLED=false
 * asks for it to be absent.
 */
function bootstrapSearchProviders(registry, builtin, cfg) {
    const provider = cfg.get('search.provider', 'auto');
    // `none` keeps the route mounted but registers no provider, so registry.active() is null and
    // SearchService.search() throws NotImplementedException → /search returns 501 (not live results).
    if (provider === 'none')
        return registry;
    registry.register(builtin);
    // register() auto-promotes the first provider to active; the explicit setActive is belt-and-braces
    // for `builtin-fts` (a no-op for `auto`, which register() already activated).
    if (provider === 'builtin-fts') {
        registry.setActive('builtin-fts');
    }
    return registry;
}
let SearchModule = class SearchModule {
};
exports.SearchModule = SearchModule;
exports.SearchModule = SearchModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        imports: [config_1.ConfigModule],
        controllers: [search_controller_1.SearchController],
        providers: [
            search_provider_registry_1.SearchProviderRegistry,
            search_service_1.SearchService,
            builtin_fts_provider_1.BuiltInFtsProvider,
            {
                provide: 'SEARCH_BOOTSTRAP',
                inject: [search_provider_registry_1.SearchProviderRegistry, builtin_fts_provider_1.BuiltInFtsProvider, config_1.ConfigService],
                useFactory: bootstrapSearchProviders,
            },
            // Binds the core-owned plugin capability port to this module's registry; resolved lazily by the
            // plugin runtime (PluginHostServices), which no-ops when this whole module is omitted
            // (SEARCH_ENABLED=false).
            // An alias, not a factory, so lifecycle hooks are not dispatched twice on the same instance.
            { provide: plugin_host_ports_1.PLUGIN_SEARCH_REGISTRY_PORT, useExisting: search_provider_registry_1.SearchProviderRegistry },
        ],
        exports: [search_service_1.SearchService],
    })
], SearchModule);
