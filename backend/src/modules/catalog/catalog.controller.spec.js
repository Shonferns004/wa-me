"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const catalog_controller_1 = require("./catalog.controller");
const engine_status_responses_1 = require("../../common/openapi/engine-status-responses");
/**
 * The controller is a thin map from route params/DTOs onto CatalogService's positional arguments.
 * What is worth pinning here is the wiring itself (which field lands in which argument slot).
 */
describe('CatalogController', () => {
    const service = {
        getCatalog: jest.fn(),
        getProducts: jest.fn(),
        getProduct: jest.fn(),
        sendProduct: jest.fn(),
    };
    const controller = new catalog_controller_1.CatalogController(service);
    beforeEach(() => jest.clearAllMocks());
    it('getCatalog forwards the session id', async () => {
        const catalog = { id: 'cat-1' };
        service.getCatalog.mockResolvedValue(catalog);
        await expect(controller.getCatalog('s1')).resolves.toBe(catalog);
        expect(service.getCatalog).toHaveBeenCalledWith('s1');
    });
    it('getProducts forwards the parsed page window, not the query object', async () => {
        const page = { products: [], pagination: { page: 2, limit: 10, total: 0, totalPages: 0 } };
        service.getProducts.mockResolvedValue(page);
        await expect(controller.getProducts('s1', { page: 2, limit: 10 })).resolves.toBe(page);
        expect(service.getProducts).toHaveBeenCalledWith('s1', 2, 10);
    });
    it('getProduct forwards the product id from the route', async () => {
        const product = { id: 'prod-1' };
        service.getProduct.mockResolvedValue(product);
        await expect(controller.getProduct('s1', 'prod-1')).resolves.toBe(product);
        expect(service.getProduct).toHaveBeenCalledWith('s1', 'prod-1');
    });
    it('sendProduct maps the DTO onto the service’s positional arguments', async () => {
        const sent = { id: 'wamid.product', timestamp: 1_706_868_000 };
        service.sendProduct.mockResolvedValue(sent);
        const dto = { chatId: '628123@c.us', productId: 'prod-1', body: 'Back in stock!' };
        await expect(controller.sendProduct('s1', dto)).resolves.toBe(sent);
        expect(service.sendProduct).toHaveBeenCalledWith('s1', '628123@c.us', 'prod-1', 'Back in stock!');
    });
    const declared = (handler) => (Reflect.getMetadata('swagger/apiResponse', Object.getOwnPropertyDescriptor(catalog_controller_1.CatalogController.prototype, handler)?.value) ?? {});
    // For some accounts WhatsApp never answers the catalog query, so the 503 must not promise that a
    // retry clears it.
    it.each(['getCatalog', 'getProducts', 'getProduct', 'sendProduct'])('does not tell %s callers a catalog timeout clears on retry', handler => {
        expect(declared(handler)['503']?.description).not.toMatch(/retry shortly/);
    });
    // CatalogService.sendProduct resolves the engine with a NotFoundException, so an unstarted session
    // answers 404 here too, not only a missing product.
    it('documents the unstarted-session 404 on send-product', () => {
        expect(declared('sendProduct')['404']?.description).toContain(engine_status_responses_1.SESSION_NOT_STARTED_404);
    });
});
