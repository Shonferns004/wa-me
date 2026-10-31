"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const engine_refused_error_1 = require("./engine-refused.error");
// A WhatsApp-side refusal (editing someone else's message, a settings write without admin rights)
// thrown as a generic Error surfaces as HTTP 500. EngineRefusedError extends ForbiddenException so
// NestJS maps it to 403 through the built-in handler (no global filter) — same mapping discipline
// as CallNotFoundError.
describe('EngineRefusedError', () => {
    it('is a ForbiddenException -> HTTP 403 without a custom global filter', () => {
        const err = new engine_refused_error_1.EngineRefusedError('admin rights required');
        expect(err).toBeInstanceOf(common_1.ForbiddenException);
        expect(err.getStatus()).toBe(403);
    });
    it('carries the refusal detail as the message', () => {
        expect(new engine_refused_error_1.EngineRefusedError("only the account's own messages can be edited").message).toBe("only the account's own messages can be edited");
    });
});
