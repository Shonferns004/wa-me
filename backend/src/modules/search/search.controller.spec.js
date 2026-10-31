"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const search_controller_1 = require("./search.controller");
describe('SearchController', () => {
    const search = jest.fn();
    const idsForFilter = jest.fn();
    const ctrl = new search_controller_1.SearchController({ search }, {
        idsForFilter,
    });
    const ok = { hits: [], total: 0, tookMs: 1, provider: 'builtin-fts' };
    beforeEach(() => {
        search.mockReset();
        idsForFilter.mockReset().mockResolvedValue(undefined);
    });
    it('throws 400 when q is empty', async () => {
        const dto = { q: '' };
        await expect(ctrl.search(dto, undefined)).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    it('throws 400 when q is only whitespace', async () => {
        // @IsNotEmpty() on the DTO passes for '   ' (non-empty), so the controller's own trim guard is
        // what rejects whitespace-only q — this test pins that guard in place.
        const dto = { q: '   ' };
        await expect(ctrl.search(dto, undefined)).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(search).not.toHaveBeenCalled();
    });
    it('returns results and forwards the key allowedSessions as callerSessionIds', async () => {
        search.mockResolvedValue(ok);
        const apiKey = { allowedSessions: ['s1', 's2'] };
        const dto = { q: 'hello', limit: 5 };
        const res = await ctrl.search(dto, apiKey);
        expect(search).toHaveBeenCalledWith(dto, ['s1', 's2'], undefined);
        expect(res).toBe(ok);
    });
    it('forwards the key expanded chat scope as callerChatIds', async () => {
        search.mockResolvedValue(ok);
        idsForFilter.mockResolvedValue(['111@c.us', '111@s.whatsapp.net', '111@lid']);
        const apiKey = { allowedChats: ['111@c.us'] };
        await ctrl.search({ q: 'hello' }, apiKey);
        expect(idsForFilter).toHaveBeenCalledWith(apiKey);
        expect(search).toHaveBeenCalledWith({ q: 'hello' }, undefined, ['111@c.us', '111@s.whatsapp.net', '111@lid']);
    });
    it('passes undefined (no scope) for an unrestricted key (null allowedSessions)', async () => {
        search.mockResolvedValue(ok);
        // A null/empty allowlist (e.g. ADMIN) sees all sessions — mirrors GET /webhooks behavior.
        const apiKey = { allowedSessions: null };
        const dto = { q: 'hello' };
        await ctrl.search(dto, apiKey);
        expect(search).toHaveBeenCalledWith(dto, undefined, undefined);
    });
    it('derives callerSessionIds only from the key, never from the query (anti-smuggling)', async () => {
        search.mockResolvedValue(ok);
        // `sessionIds` is not a field on SearchQueryDto, so it cannot be expressed in the query at all;
        // the global ValidationPipe (forbidNonWhitelisted) would reject it, and SearchService clobbers
        // any sessionIds at the provider boundary. The controller itself derives scope solely from the
        // key, even when a sessionIds value reaches it.
        const dto = { q: 'hello', sessionIds: ['sneaky'] };
        const apiKey = { allowedSessions: ['s1'] };
        await ctrl.search(dto, apiKey);
        expect(search).toHaveBeenCalledWith(dto, ['s1'], undefined);
    });
    it('propagates 501 (NotImplementedException) from the service when no provider is active', async () => {
        search.mockRejectedValue(new common_1.NotImplementedException('none'));
        await expect(ctrl.search({ q: 'x' }, undefined)).rejects.toBeInstanceOf(common_1.NotImplementedException);
    });
    it('publishes limit and offset as integer query parameters', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        const params = Reflect.getMetadata(swagger_1.DECORATORS.API_PARAMETERS, search_controller_1.SearchController.prototype.search);
        const typeOf = (name) => params.find(p => p.name === name)?.type;
        expect(typeOf('limit')).toBe('integer');
        expect(typeOf('offset')).toBe('integer');
    });
});
