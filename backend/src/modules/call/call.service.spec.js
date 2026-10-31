"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const call_service_1 = require("./call.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const call_not_found_error_1 = require("../../common/errors/call-not-found.error");
describe('CallService', () => {
    const makeService = (engine) => {
        const engines = new engine_registry_service_1.EngineRegistry();
        if (engine)
            engines.set('s1', engine);
        return new call_service_1.CallService(engines);
    };
    it('throws 400 "Session is not started" when the engine is missing (guard preserved)', () => {
        // The guard throws synchronously; the controller method is `async`, so this still surfaces
        // as a rejected promise -> 400 at the HTTP layer (same shape as GroupService).
        const svc = makeService(undefined);
        expect(() => svc.rejectCall('s1', 'CALL1')).toThrow(common_1.BadRequestException);
        expect(() => svc.rejectCall('s1', 'CALL1')).toThrow('Session is not started');
    });
    it('delegates rejectCall to the engine when the session is started', async () => {
        const rejectCall = jest.fn().mockResolvedValue(undefined);
        const svc = makeService({ rejectCall });
        await svc.rejectCall('s1', 'CALL1');
        expect(rejectCall).toHaveBeenCalledWith('CALL1');
    });
    it('delegates createCallLink to the engine with the type and epoch-ms startTime', async () => {
        const createCallLink = jest.fn().mockResolvedValue('https://call.whatsapp.com/voice/L');
        const svc = makeService({ createCallLink });
        await expect(svc.createCallLink('s1', 'audio', 1_800_000_000_000)).resolves.toBe('https://call.whatsapp.com/voice/L');
        expect(createCallLink).toHaveBeenCalledWith('audio', 1_800_000_000_000);
    });
    it('guards createCallLink with the same 400 when the engine is missing', () => {
        expect(() => makeService(undefined).createCallLink('s1', 'video', 1)).toThrow('Session is not started');
    });
    it('propagates the engine not-found error (unknown/expired call id -> 404)', async () => {
        const rejectCall = jest.fn().mockRejectedValue(new call_not_found_error_1.CallNotFoundError('CALL1'));
        const svc = makeService({ rejectCall });
        await expect(svc.rejectCall('s1', 'CALL1')).rejects.toBeInstanceOf(call_not_found_error_1.CallNotFoundError);
    });
});
