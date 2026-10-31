"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const search_provider_registry_1 = require("./search-provider.registry");
function mk(id) {
    return { id, label: id, search: jest.fn(), health: jest.fn() };
}
describe('SearchProviderRegistry', () => {
    it('returns null when nothing is registered', () => {
        expect(new search_provider_registry_1.SearchProviderRegistry().active()).toBeNull();
    });
    it('auto-selects the first registered provider as active', () => {
        const r = new search_provider_registry_1.SearchProviderRegistry();
        r.register(mk('a'));
        expect(r.active()?.id).toBe('a');
    });
    it('setActive selects among registered providers; register idempotent; unregister clears active', () => {
        const r = new search_provider_registry_1.SearchProviderRegistry();
        r.register(mk('a'));
        r.register(mk('b'));
        r.setActive('b');
        expect(r.active()?.id).toBe('b');
        // A plugin re-enable registers the same id again: no duplicate, and the active choice stands.
        r.register(mk('a'));
        expect(r.active()?.id).toBe('b');
        expect(r.list()).toHaveLength(2);
        expect(() => r.setActive('zz')).toThrow(/unknown search provider/);
        r.unregister('b');
        expect(r.active()?.id).toBe('a');
        r.unregister('a');
        expect(r.active()).toBeNull();
    });
    it('list returns all registered providers', () => {
        const r = new search_provider_registry_1.SearchProviderRegistry();
        r.register(mk('a'));
        r.register(mk('b'));
        expect(r
            .list()
            .map(p => p.id)
            .sort()).toEqual(['a', 'b']);
    });
});
