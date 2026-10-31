"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CatalogService = void 0;
const common_1 = require("@nestjs/common");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const send_pacing_service_1 = require("../message/send-pacing.service");
const hooks_1 = require("../../core/hooks");
let CatalogService = class CatalogService {
    engines;
    pacing;
    hookManager;
    // HookManager comes from the @Global() HooksModule, so no module import is needed.
    constructor(engines, pacing, hookManager) {
        this.engines = engines;
        this.pacing = pacing;
        this.hookManager = hookManager;
    }
    async getCatalog(sessionId) {
        const engine = this.engines.require(sessionId, () => new common_1.NotFoundException(`Session ${sessionId} not found or not connected`));
        return engine.getCatalog();
    }
    async getProducts(sessionId, page = 1, limit = 20) {
        const engine = this.engines.require(sessionId, () => new common_1.NotFoundException(`Session ${sessionId} not found or not connected`));
        return engine.getProducts({ page, limit });
    }
    async getProduct(sessionId, productId) {
        const engine = this.engines.require(sessionId, () => new common_1.NotFoundException(`Session ${sessionId} not found or not connected`));
        return engine.getProduct(productId);
    }
    /**
     * Sending a product is a real outbound chat message, not a catalog read. It does NOT go through
     * MessageService, so this method runs the two pre-send steps every chat send gets: pacing, then the
     * `message:sending` plugin gate (input `{ chatId, productId, body }`, type `product`). A plugin may
     * rewrite `productId` or `body`; a rewritten `chatId` is ignored, because `chatId` is the value the
     * API key's chat scope was checked against. No PENDING row is written up front. On Baileys the
     * own-send echo (MessageProjector.handleOwnSendEcho) persists the OUTGOING row afterwards and fires
     * `message:sent` and `message:persisted`, so the send is counted into the pacing daily cap once
     * that row lands. Until then its pacing admission is held: for as long as the engine call runs, and for
     * the hold window after it returns.
     */
    async sendProduct(sessionId, chatId, productId, body) {
        const settle = await this.pacing.assertSendAllowed(sessionId, chatId, { untilSettled: true });
        let engineAsked = false;
        try {
            const gated = await (0, hooks_1.applySendingGate)(this.hookManager, sessionId, 'product', 
            // The DTO lets a JSON null through as "no body". Normalised here, so the checks below only ever
            // judge what a plugin handed back, never the caller's own input.
            { chatId, productId, body: body ?? undefined }, 'CatalogService');
            const gatedProductId = gated.productId;
            const gatedBody = gated.body;
            if (typeof gatedProductId !== 'string' || gatedProductId === '') {
                throw new common_1.BadRequestException('A message:sending handler returned an invalid productId');
            }
            if (gatedBody !== undefined && typeof gatedBody !== 'string') {
                throw new common_1.BadRequestException('A message:sending handler returned an invalid body');
            }
            const engine = this.engines.require(sessionId, () => new common_1.NotFoundException(`Session ${sessionId} not found or not connected`));
            engineAsked = true;
            const result = await this.recordedSend(sessionId, () => engine.sendProduct(chatId, gatedProductId, gatedBody));
            settle?.(true);
            return result;
        }
        catch (error) {
            // No row is written here, so a send that provably never went out gives its pacing admission back.
            // One whose outcome is unknown stays held for a window from now: its own-send echo may still write
            // the row.
            settle?.(engineAsked && !(0, send_pacing_service_1.sentNothing)(error));
            throw error;
        }
    }
    /**
     * Report the engine send's outcome to the pacing breaker, as every other send path does. The pacing
     * check and the session lookup stay outside, so a policy 429 or a 404 never feeds the breaker.
     */
    async recordedSend(sessionId, send) {
        try {
            const result = await send();
            this.pacing.recordSendSuccess(sessionId);
            return result;
        }
        catch (error) {
            if ((0, send_pacing_service_1.countsTowardSendBreaker)(error)) {
                this.pacing.recordSendFailure(sessionId);
            }
            throw error;
        }
    }
};
exports.CatalogService = CatalogService;
exports.CatalogService = CatalogService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [engine_registry_service_1.EngineRegistry,
        send_pacing_service_1.SendPacingService,
        hooks_1.HookManager])
], CatalogService);
