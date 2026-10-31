"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WwebjsCatalog = void 0;
const engine_not_supported_error_1 = require("../../common/errors/engine-not-supported.error");
/**
 * Catalog operations extracted from WhatsAppWebJsAdapter: whatsapp-web.js has no Catalog API at all
 * (no Client.getCatalog/getProducts/getProduct symbol in index.d.ts), so these are honest 501s.
 * The adapter keeps the public methods as thin forwarders and injects the shared host surface
 * (./wwebjs-host) via closures, so the delegate never touches lifecycle state directly.
 */
class WwebjsCatalog {
    host;
    constructor(host) {
        this.host = host;
    }
    /* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unused-vars */
    async getCatalog() {
        this.host.ensureReady();
        throw new engine_not_supported_error_1.EngineNotSupportedError('getCatalog');
    }
    async getProducts(_options) {
        this.host.ensureReady();
        throw new engine_not_supported_error_1.EngineNotSupportedError('getProducts');
    }
    async getProduct(_productId) {
        this.host.ensureReady();
        throw new engine_not_supported_error_1.EngineNotSupportedError('getProduct');
    }
    async sendProduct(_chatId, _productId, _body) {
        this.host.ensureReady();
        throw new engine_not_supported_error_1.EngineNotSupportedError('sendProduct');
    }
    async sendCatalog(_chatId, _body) {
        this.host.ensureReady();
        throw new engine_not_supported_error_1.EngineNotSupportedError('sendCatalog');
    }
}
exports.WwebjsCatalog = WwebjsCatalog;
