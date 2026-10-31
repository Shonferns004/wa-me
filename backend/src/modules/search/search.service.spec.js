"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const search_service_1 = require("./search.service");
const search_provider_registry_1 = require("./search-provider.registry");
const search_constants_1 = require("./search.constants");
function mkProvider(id, search) {
    return {
        id,
        label: id,
        health: jest.fn().mockResolvedValue({ ok: true }),
        search,
    };
}
const emptyResults = { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' };
describe('SearchService', () => {
    it('throws 501 (NotImplementedException) when no provider is active', async () => {
        const svc = new search_service_1.SearchService(new search_provider_registry_1.SearchProviderRegistry());
        await expect(svc.search({ q: 'x' })).rejects.toBeInstanceOf(common_1.NotImplementedException);
    });
    it('delegates to the active provider with sessionIds injected', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        await svc.search({ q: 'x' }, ['s1', 's2']);
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ q: 'x', sessionIds: ['s1', 's2'] }));
    });
    it('does not let a caller override sessionIds', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        // A smuggled `sessionIds` in the query body must be overwritten by the authoritative caller scope.
        await svc.search({ q: 'x', sessionIds: ['sneaky'] }, ['s1']);
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ sessionIds: ['s1'] }));
    });
    it('injects the caller chat scope and does not let a caller override chatIds either', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        // The lid-expanded allowlist arrives from ChatScopeService via the controller; a smuggled
        // `chatIds` must be overwritten exactly like sessionIds.
        await svc.search({ q: 'x', chatIds: ['sneaky'] }, undefined, ['111@c.us', '111@lid']);
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ chatIds: ['111@c.us', '111@lid'] }));
    });
    describe('chat and sender filters', () => {
        const lidAware = () => ({
            candidatesFor: jest.fn((id) => Promise.resolve(id === '628123@c.us' ? ['628123@c.us', '628123@s.whatsapp.net', '999@lid'] : [id])),
        });
        it('hands the provider every stored form of the ids, expanded by the host', async () => {
            const reg = new search_provider_registry_1.SearchProviderRegistry();
            const search = jest.fn().mockResolvedValue(emptyResults);
            reg.register(mkProvider('builtin-fts', search));
            const svc = new search_service_1.SearchService(reg, lidAware());
            await svc.search({ q: 'x', chatId: '628123@c.us', from: '628555@c.us' });
            expect(search).toHaveBeenCalledWith(expect.objectContaining({
                chatId: '628123@c.us',
                chatIdAliases: ['628123@c.us', '628123@s.whatsapp.net', '999@lid'],
                from: '628555@c.us',
                // With the bare digits an earlier version stored as the account's own sender.
                fromAliases: ['628555@c.us', '628555'],
            }));
        });
        it('expands nothing when the query names neither a chat nor a sender', async () => {
            const reg = new search_provider_registry_1.SearchProviderRegistry();
            const search = jest.fn().mockResolvedValue(emptyResults);
            reg.register(mkProvider('builtin-fts', search));
            const chatScope = lidAware();
            const svc = new search_service_1.SearchService(reg, chatScope);
            await svc.search({ q: 'x' });
            expect(chatScope.candidatesFor).not.toHaveBeenCalled();
            expect(search).toHaveBeenCalledWith(expect.objectContaining({ chatIdAliases: undefined, fromAliases: undefined }));
        });
        it('does not let a caller supply the expanded lists', async () => {
            const reg = new search_provider_registry_1.SearchProviderRegistry();
            const search = jest.fn().mockResolvedValue(emptyResults);
            reg.register(mkProvider('builtin-fts', search));
            const svc = new search_service_1.SearchService(reg, lidAware());
            await svc.search({ q: 'x', chatId: '628123@c.us', chatIdAliases: ['sneaky@c.us'], fromAliases: ['sneaky@c.us'] });
            const [query] = search.mock.calls[0];
            expect(query.chatIdAliases).not.toContain('sneaky@c.us');
            expect(query.fromAliases).toBeUndefined();
        });
        it('leaves the filters literal when no lid table is available', async () => {
            const reg = new search_provider_registry_1.SearchProviderRegistry();
            const search = jest.fn().mockResolvedValue(emptyResults);
            reg.register(mkProvider('builtin-fts', search));
            await new search_service_1.SearchService(reg).search({ q: 'x', chatId: '628123@c.us' });
            expect(search).toHaveBeenCalledWith(expect.objectContaining({ chatId: '628123@c.us', chatIdAliases: undefined }));
        });
    });
    it('refuses a query of more than SEARCH_TERMS_MAX words before any provider runs it', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
        await expect(svc.search({ q: words(search_constants_1.SEARCH_TERMS_MAX + 1) })).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(search).not.toHaveBeenCalled();
        await svc.search({ q: words(search_constants_1.SEARCH_TERMS_MAX) });
        // A word said many times is one word.
        await svc.search({ q: Array.from({ length: 300 }, () => 'hello').join(' ') });
        expect(search).toHaveBeenCalledTimes(2);
    });
    it('counts the words inside a token the way the index does, so punctuation cannot hide them', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        const joined = (n, sep) => Array.from({ length: n }, () => 'a').join(sep);
        for (const sep of ['.', '-', '_', '@', '\u1CF2']) {
            await expect(svc.search({ q: joined(search_constants_1.SEARCH_TERMS_MAX + 1, sep) })).rejects.toBeInstanceOf(common_1.BadRequestException);
        }
        expect(search).not.toHaveBeenCalled();
        await svc.search({ q: joined(search_constants_1.SEARCH_TERMS_MAX, '.') });
        expect(search).toHaveBeenCalledTimes(1);
    });
    it('clamps an excessive limit to SEARCH_LIMIT_MAX before it reaches any provider', async () => {
        // Without the host-side clamp a plugin provider would receive the raw caller value (9999) and
        // could pressure host heap by returning an oversized page. The built-in already rejected this in
        // its own SQL; the clamp extends the same bound to every provider.
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        await svc.search({ q: 'x', limit: 9999 });
        const received = search.mock.calls[0][0].limit;
        expect(received).toBe(search_constants_1.SEARCH_LIMIT_MAX);
        expect(received).toBeLessThan(9999);
    });
    it('clamps an excessive offset to SEARCH_OFFSET_MAX before it reaches any provider', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        await svc.search({ q: 'x', offset: 99_999_999 });
        const received = search.mock.calls[0][0].offset;
        expect(received).toBe(search_constants_1.SEARCH_OFFSET_MAX);
        expect(received).toBeLessThan(99_999_999);
    });
    it('applies the default limit when the caller omits it', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        await svc.search({ q: 'x' });
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: search_constants_1.SEARCH_DEFAULT_LIMIT }));
    });
    it('passes in-bounds limit/offset through unchanged', async () => {
        const reg = new search_provider_registry_1.SearchProviderRegistry();
        const search = jest.fn().mockResolvedValue(emptyResults);
        reg.register(mkProvider('builtin-fts', search));
        const svc = new search_service_1.SearchService(reg);
        await svc.search({ q: 'x', limit: 10, offset: 20 });
        expect(search).toHaveBeenCalledWith(expect.objectContaining({ limit: 10, offset: 20 }));
    });
});
