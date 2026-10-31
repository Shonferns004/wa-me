"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin_host_services_1 = require("./plugin-host-services");
const search_provider_registry_1 = require("../../modules/search/search-provider.registry");
const hostServices = (get) => new plugin_host_services_1.PluginHostServices({ get });
describe('PluginHostServices', () => {
    describe('getSearchRegistryPort', () => {
        it('returns the registry when ModuleRef has it', () => {
            const registry = new search_provider_registry_1.SearchProviderRegistry();
            expect(hostServices(jest.fn().mockReturnValue(registry)).getSearchRegistryPort()).toBe(registry);
        });
        it('returns undefined when ModuleRef has no registry (search disabled)', () => {
            // SEARCH_ENABLED=false omits SearchModule entirely, so the lookup throws rather than missing.
            // Callers no-op on undefined; letting it propagate would break plugin enable for everyone.
            const get = jest.fn().mockImplementation(() => {
                throw new Error('not found');
            });
            expect(hostServices(get).getSearchRegistryPort()).toBeUndefined();
        });
    });
});
