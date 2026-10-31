"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EngineNotSupportedError = void 0;
const common_1 = require("@nestjs/common");
/**
 * Thrown by an engine adapter when a method is part of the {@link IWhatsAppEngine}
 * contract but the active engine cannot implement it (e.g. the Baileys engine has no live
 * per-chat history read, so getChatHistory is unavailable there).
 *
 * Extends NestJS `NotImplementedException` so it maps to **HTTP 501** through NestJS's
 * built-in exception handler — no custom global filter required. Mirrors how
 * {@link EngineNotReadyError} maps to 409.
 */
class EngineNotSupportedError extends common_1.NotImplementedException {
    constructor(method) {
        super(`Operation not supported by the active engine: ${method}`);
    }
}
exports.EngineNotSupportedError = EngineNotSupportedError;
