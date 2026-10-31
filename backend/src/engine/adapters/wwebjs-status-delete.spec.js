"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_status_1 = require("./wwebjs-status");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const logger_service_1 = require("../../common/services/logger.service");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
/**
 * Client.revokeStatusMessage refuses a status that is not the account's own with a bare page-side
 * string (Client.js revokeStatusMessage), which Puppeteer rejects with as-is. GET /status lists
 * contacts' statuses, so their ids reach DELETE /status/:id, and the refusal answered 500.
 */
const REFUSAL = 'Invalid usage! Can only revoke the message its from own status broadcast';
function makeStatus(outcome) {
    const client = { revokeStatusMessage: jest.fn().mockRejectedValue(outcome) };
    const reportIfPageTransportError = jest.fn();
    const host = {
        ensureReady: jest.fn(),
        getClient: () => client,
        isPageTransportError: (error) => wwebjs_lifecycle_1.WwebjsLifecycle.prototype.isPageTransportError.call({}, error),
        reportIfPageTransportError,
        logger: (0, logger_service_1.createLogger)('wwebjs-status-delete.spec'),
    };
    return { status: new wwebjs_status_1.WwebjsStatus(host), reportIfPageTransportError };
}
describe('deleteStatus on whatsapp-web.js', () => {
    it("answers the library's refusal of a foreign status with a 403", async () => {
        await expect(makeStatus(REFUSAL).status.deleteStatus('false_status@broadcast_ABC_628111@c.us')).rejects.toThrow(engine_refused_error_1.EngineRefusedError);
    });
    it('still answers a dead page with a 503, even as a bare string', async () => {
        const { status, reportIfPageTransportError } = makeStatus('Protocol error: Target closed');
        await expect(status.deleteStatus('x')).rejects.toThrow(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).toHaveBeenCalled();
    });
    it('propagates any other failure unchanged', async () => {
        const other = new Error('Invalid usage! as an Error is not the library refusal');
        await expect(makeStatus(other).status.deleteStatus('x')).rejects.toBe(other);
        await expect(makeStatus('something else').status.deleteStatus('x')).rejects.toBe('something else');
    });
});
