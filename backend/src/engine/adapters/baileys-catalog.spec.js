"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const baileys_catalog_1 = require("./baileys-catalog");
const boom_1 = require("@hapi/boom");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const never = () => new Promise(() => undefined);
function build(sock, budgetMs) {
    const logger = { warn: jest.fn() };
    const host = {
        ensureReady: () => undefined,
        getSocket: () => sock,
        normalizedSelfJid: () => '628177@s.whatsapp.net',
        logger: logger,
    };
    return { catalog: new baileys_catalog_1.BaileysCatalog(host, budgetMs), logger };
}
const product = (id) => ({
    id,
    name: `product ${id}`,
    price: 1000,
    currency: 'IDR',
    imageUrls: { requested: 'https://example.test/i.jpg' },
    url: 'https://example.test/p',
    availability: 'in stock',
    retailerId: `r-${id}`,
});
describe('BaileysCatalog deadline', () => {
    it('rejects getCatalog when WhatsApp never answers the collections query', async () => {
        const { catalog } = build({ getCollections: jest.fn(never) }, 20);
        await expect(catalog.getCatalog()).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
    it('rejects getProducts when WhatsApp never answers the catalog query', async () => {
        const { catalog } = build({ getCatalog: jest.fn(never) }, 20);
        await expect(catalog.getProducts()).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
    });
    it('spends ONE budget across the whole page walk, not one per page', async () => {
        // Each page costs ~30ms against a 70ms budget: a per-call deadline would let the walk run
        // forever, a shared one must give up on the third page.
        const getCatalog = jest.fn(() => new Promise(resolve => {
            setTimeout(() => resolve({ products: [product('a')], nextPageCursor: `c${getCatalog.mock.calls.length}` }), 30);
        }));
        const { catalog } = build({ getCatalog }, 70);
        await expect(catalog.getProducts()).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        expect(getCatalog.mock.calls.length).toBeLessThanOrEqual(3);
    });
    it('stops walking when the server repeats a cursor instead of advancing', async () => {
        const getCatalog = jest.fn(({ cursor }) => Promise.resolve({ products: [product(cursor ?? 'first')], nextPageCursor: 'stuck' }));
        const { catalog } = build({ getCatalog }, 500);
        const page = await catalog.getProducts();
        expect(getCatalog).toHaveBeenCalledTimes(2);
        expect(page.pagination.total).toBe(2);
    });
    it('logs the expiry so the operator can see why the request failed', async () => {
        const { catalog, logger } = build({ getCollections: jest.fn(never) }, 20);
        await expect(catalog.getCatalog()).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        expect(logger.warn).toHaveBeenCalledTimes(1);
    });
});
describe('BaileysCatalog answers within the deadline', () => {
    it('still reports a genuinely empty catalog as null, not an error', async () => {
        const { catalog } = build({ getCollections: jest.fn().mockResolvedValue({ collections: [] }) }, 500);
        await expect(catalog.getCatalog()).resolves.toBeNull();
    });
    it('still reports a genuinely empty product list as an empty page, not an error', async () => {
        const { catalog } = build({ getCatalog: jest.fn().mockResolvedValue({ products: [], nextPageCursor: undefined }) }, 500);
        await expect(catalog.getProducts()).resolves.toEqual({
            products: [],
            pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
        });
    });
    it('maps a populated catalog unchanged', async () => {
        const { catalog } = build({
            getCollections: jest.fn().mockResolvedValue({
                collections: [{ id: 'col-1', name: 'Default', products: [product('a'), product('b')] }],
            }),
        }, 500);
        await expect(catalog.getCatalog()).resolves.toEqual({
            id: 'col-1',
            name: 'Default',
            productCount: 2,
            url: 'https://wa.me/c/628177',
        });
    });
});
describe('BaileysCatalog server refusals', () => {
    // assertNodeErrorFree turns an <error code="..."> answer into a Boom carrying the numeric code.
    const refusal = (code) => new boom_1.Boom('refused', { data: code });
    it('maps a refused collections query to EngineRefusedError instead of a raw Boom', async () => {
        const { catalog } = build({ getCollections: jest.fn().mockRejectedValue(refusal(403)) }, 500);
        await expect(catalog.getCatalog()).rejects.toBeInstanceOf(engine_refused_error_1.EngineRefusedError);
    });
    it('reads item-not-found as an account with no catalog, as the routes document', async () => {
        const { catalog } = build({
            getCollections: jest.fn().mockRejectedValue(refusal(404)),
            getCatalog: jest.fn().mockRejectedValue(refusal(404)),
        }, 500);
        await expect(catalog.getCatalog()).resolves.toBeNull();
        await expect(catalog.getProduct('a')).resolves.toBeNull();
        await expect(catalog.getProducts()).resolves.toMatchObject({ products: [], pagination: { total: 0 } });
    });
    it('fails a walk that hits item-not-found after the first page instead of truncating it', async () => {
        const getCatalog = jest
            .fn()
            .mockResolvedValueOnce({ products: [product('a')], nextPageCursor: 'c1' })
            .mockRejectedValueOnce(refusal(404));
        const { catalog } = build({ getCatalog }, 500);
        await expect(catalog.getProducts()).rejects.toBeInstanceOf(engine_refused_error_1.EngineRefusedError);
    });
    it('leaves a dropped connection unmapped', async () => {
        const closed = new boom_1.Boom('Connection Closed', { statusCode: 428 });
        const { catalog } = build({ getCatalog: jest.fn().mockRejectedValue(closed) }, 500);
        await expect(catalog.getProducts()).rejects.toBe(closed);
    });
});
