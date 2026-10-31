"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const call_controller_1 = require("./call.controller");
const call_not_found_error_1 = require("../../common/errors/call-not-found.error");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
describe('CallController', () => {
    const build = (service) => {
        const controller = new call_controller_1.CallController(service);
        return { controller, service };
    };
    it('POST link returns the generated link', async () => {
        const { controller, service } = build({
            createCallLink: jest.fn().mockResolvedValue('https://call.whatsapp.com/video/TOKEN'),
        });
        await expect(controller.createLink('s1', { type: 'video', startTime: 1_800_000_000_000 })).resolves.toEqual({
            link: 'https://call.whatsapp.com/video/TOKEN',
        });
        expect(service.createCallLink).toHaveBeenCalledWith('s1', 'video', 1_800_000_000_000);
    });
    // A refusal must reach the caller as a refusal. Returning `{ link: '' }` would be a 200 carrying
    // nothing, which reads as success and hands the caller a link that does not exist.
    it('propagates a WhatsApp-side refusal rather than answering with an empty link', async () => {
        const { controller } = build({
            createCallLink: jest.fn().mockRejectedValue(new engine_refused_error_1.EngineRefusedError('WhatsApp did not return a call link')),
        });
        await expect(controller.createLink('s1', { type: 'audio', startTime: 1_800_000_000_000 })).rejects.toBeInstanceOf(engine_refused_error_1.EngineRefusedError);
    });
    // The mint is not idempotent, so an unconfirmed link_create answers 500 on both engines: a
    // retryable 503 would invite a replay that creates a second link.
    it('POST link declares no retryable 503', () => {
        const responses = (Reflect.getMetadata('swagger/apiResponse', Object.getOwnPropertyDescriptor(call_controller_1.CallController.prototype, 'createLink')?.value) ?? {});
        expect(Object.keys(responses)).not.toContain('503');
    });
    it('POST :callId/reject returns the success envelope', async () => {
        const { controller, service } = build({ rejectCall: jest.fn().mockResolvedValue(undefined) });
        await expect(controller.reject('s1', 'CALL1')).resolves.toEqual({ success: true });
        expect(service.rejectCall).toHaveBeenCalledWith('s1', 'CALL1');
    });
    it('propagates a service rejection (session not started -> 400)', async () => {
        const { controller } = build({
            rejectCall: jest.fn().mockRejectedValue(new common_1.BadRequestException('Session is not started')),
        });
        await expect(controller.reject('s1', 'CALL1')).rejects.toThrow(common_1.BadRequestException);
    });
    it('propagates a service rejection (unknown/expired call id -> 404)', async () => {
        const { controller } = build({
            rejectCall: jest.fn().mockRejectedValue(new call_not_found_error_1.CallNotFoundError('CALL1')),
        });
        await expect(controller.reject('s1', 'CALL1')).rejects.toBeInstanceOf(call_not_found_error_1.CallNotFoundError);
    });
});
