"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const search_provider_registration_util_1 = require("./search-provider-registration.util");
const search_provider_registry_1 = require("../../modules/search/search-provider.registry");
const mkTransport = () => ({ dispatchSearch: jest.fn(), healthCheck: jest.fn() });
const deps = (overrides = {}) => ({
    pluginId: 'meili',
    label: 'Meilisearch (plugin)',
    transport: mkTransport(),
    timeoutMs: 10000,
    registry: new search_provider_registry_1.SearchProviderRegistry(),
    mode: 'auto',
    hasPermission: true,
    warn: jest.fn(),
    ...overrides,
});
const builtin = () => ({ id: 'builtin-fts', label: 'b', search: jest.fn(), health: jest.fn() });
describe('registerPluginSearchProvider', () => {
    it('auto mode registers and activates the plugin, superseding builtin-fts', () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register(builtin());
        expect(registry.active()?.id).toBe('builtin-fts');
        (0, search_provider_registration_util_1.registerPluginSearchProvider)(deps({ registry }));
        expect(registry.list().map(p => p.id)).toContain('plugin:meili');
        expect(registry.active()?.id).toBe('plugin:meili');
    });
    it('denies a plugin that never declared the search:provide permission, even in auto mode', () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register(builtin());
        const warn = jest.fn();
        (0, search_provider_registration_util_1.registerPluginSearchProvider)(deps({ registry, hasPermission: false, warn }));
        expect(registry.list().map(p => p.id)).not.toContain('plugin:meili');
        expect(registry.active()?.id).toBe('builtin-fts');
        expect(warn).toHaveBeenCalledTimes(1);
    });
    it('builtin-fts mode registers the plugin but leaves builtin active', () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register(builtin());
        (0, search_provider_registration_util_1.registerPluginSearchProvider)(deps({ registry, mode: 'builtin-fts' }));
        expect(registry.list().map(p => p.id)).toContain('plugin:meili');
        expect(registry.active()?.id).toBe('builtin-fts');
    });
    it('none mode skips registration entirely', () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        (0, search_provider_registration_util_1.registerPluginSearchProvider)(deps({ registry, mode: 'none' }));
        expect(registry.list().map(p => p.id)).not.toContain('plugin:meili');
        expect(registry.active()).toBeNull();
    });
    it('undefined registry (search module not loaded) skips without throwing', () => {
        expect(() => (0, search_provider_registration_util_1.registerPluginSearchProvider)(deps({ registry: undefined }))).not.toThrow();
    });
});
describe('unregisterPluginSearchProvider', () => {
    it('removes the plugin:<id> provider and falls back', () => {
        const registry = new search_provider_registry_1.SearchProviderRegistry();
        registry.register(builtin());
        (0, search_provider_registration_util_1.registerPluginSearchProvider)(deps({ registry })); // active = plugin:meili
        (0, search_provider_registration_util_1.unregisterPluginSearchProvider)(registry, 'meili');
        expect(registry.list().map(p => p.id)).not.toContain('plugin:meili');
        expect(registry.active()?.id).toBe('builtin-fts');
    });
    it('is a no-op when the registry is absent', () => {
        expect(() => (0, search_provider_registration_util_1.unregisterPluginSearchProvider)(undefined, 'meili')).not.toThrow();
    });
});
