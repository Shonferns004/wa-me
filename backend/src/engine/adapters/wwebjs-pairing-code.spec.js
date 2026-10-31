"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
/**
 * WhatsApp Web reloads the QR page while UNPAIRED, so a requestPairingCode can land mid-navigation and
 * either reject with "Execution context was destroyed" or hang until Puppeteer's protocol timeout.
 * The call now bounds each attempt and retries the navigation/timeout shapes while still at QR_READY,
 * so the dashboard gets a code instead of sitting on "Creating pairing code..." forever.
 */
function makeLifecycle(requestPairingCode) {
    const host = {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
        config: { sessionId: 'sess', sessionDataPath: './data' },
    };
    const lc = new wwebjs_lifecycle_1.WwebjsLifecycle(host);
    lc.status = whatsapp_engine_interface_1.EngineStatus.QR_READY;
    lc.client = { requestPairingCode };
    return lc;
}
describe('requestPairingCode retries a mid-navigation page', () => {
    afterEach(() => jest.useRealTimers());
    it('rejects before the QR stage without touching the client', async () => {
        const requestPairingCode = jest.fn();
        const lc = makeLifecycle(requestPairingCode);
        lc.status = whatsapp_engine_interface_1.EngineStatus.INITIALIZING;
        await expect(lc.requestPairingCode('628111')).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(requestPairingCode).not.toHaveBeenCalled();
    });
    it('retries a navigation-destroyed context and returns the code once the page reboots', async () => {
        jest.useFakeTimers();
        const requestPairingCode = jest
            .fn()
            .mockRejectedValueOnce(new Error('Execution context was destroyed, most likely because of a navigation.'))
            .mockResolvedValueOnce('WXYZ1234');
        const lc = makeLifecycle(requestPairingCode);
        const pending = lc.requestPairingCode('628111');
        await jest.advanceTimersByTimeAsync(wwebjs_lifecycle_1.PAIRING_CODE_RETRY_DELAY_MS + 10);
        await expect(pending).resolves.toBe('WXYZ1234');
        expect(requestPairingCode).toHaveBeenCalledTimes(2);
    });
    // An exhausted budget is a transport failure, not a broken gateway: it answers 503 so a caller
    // knows the request is worth retrying, and carries the last attempt's reason as the detail.
    it('bounds a hanging attempt and gives up after the attempt budget', async () => {
        jest.useFakeTimers();
        const requestPairingCode = jest.fn().mockImplementation(() => new Promise(() => undefined)); // never settles
        const lc = makeLifecycle(requestPairingCode);
        const pending = lc.requestPairingCode('628111');
        pending.catch(() => undefined); // the rejection is asserted below; avoid an unhandled rejection warning
        const total = wwebjs_lifecycle_1.PAIRING_CODE_MAX_ATTEMPTS * wwebjs_lifecycle_1.PAIRING_CODE_ATTEMPT_TIMEOUT_MS +
            (wwebjs_lifecycle_1.PAIRING_CODE_MAX_ATTEMPTS - 1) * wwebjs_lifecycle_1.PAIRING_CODE_RETRY_DELAY_MS +
            50;
        await jest.advanceTimersByTimeAsync(total);
        await expect(pending).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        await expect(pending).rejects.toThrow(/attempt timed out/i);
        expect(requestPairingCode).toHaveBeenCalledTimes(wwebjs_lifecycle_1.PAIRING_CODE_MAX_ATTEMPTS);
    });
    it('answers 503 for an exhausted budget', async () => {
        jest.useFakeTimers();
        const requestPairingCode = jest.fn().mockImplementation(() => new Promise(() => undefined));
        const lc = makeLifecycle(requestPairingCode);
        const pending = lc.requestPairingCode('628111');
        const failure = pending.catch((err) => err);
        await jest.advanceTimersByTimeAsync(wwebjs_lifecycle_1.PAIRING_CODE_MAX_ATTEMPTS * wwebjs_lifecycle_1.PAIRING_CODE_ATTEMPT_TIMEOUT_MS +
            (wwebjs_lifecycle_1.PAIRING_CODE_MAX_ATTEMPTS - 1) * wwebjs_lifecycle_1.PAIRING_CODE_RETRY_DELAY_MS +
            50);
        expect((await failure).getStatus()).toBe(503);
    });
    it('propagates a non-navigation failure on the first attempt (no wasted retries)', async () => {
        const requestPairingCode = jest.fn().mockRejectedValue(new Error('phone number is not registered on WhatsApp'));
        const lc = makeLifecycle(requestPairingCode);
        await expect(lc.requestPairingCode('628111')).rejects.toThrow(/not registered/);
        expect(requestPairingCode).toHaveBeenCalledTimes(1);
    });
    it('stops retrying when the session leaves the QR stage between attempts', async () => {
        jest.useFakeTimers();
        const requestPairingCode = jest
            .fn()
            .mockRejectedValue(new Error('Execution context was destroyed, most likely because of a navigation.'));
        const lc = makeLifecycle(requestPairingCode);
        const pending = lc.requestPairingCode('628111');
        pending.catch(() => undefined);
        lc.status = whatsapp_engine_interface_1.EngineStatus.READY; // linked while the first retry delay is pending
        await jest.advanceTimersByTimeAsync(wwebjs_lifecycle_1.PAIRING_CODE_RETRY_DELAY_MS + 10);
        await expect(pending).rejects.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(requestPairingCode).toHaveBeenCalledTimes(1);
    });
});
