"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const profile_controller_1 = require("./profile.controller");
const engine_refused_error_1 = require("../../common/errors/engine-refused.error");
describe('ProfileController', () => {
    const build = (service) => {
        const controller = new profile_controller_1.ProfileController(service);
        return { controller, service };
    };
    it('DELETE picture delegates and returns its own message', async () => {
        const { controller, service } = build({ deleteProfilePicture: jest.fn().mockResolvedValue(undefined) });
        await expect(controller.deletePicture('s1')).resolves.toEqual({
            success: true,
            message: 'Profile picture removed',
        });
        expect(service.deleteProfilePicture).toHaveBeenCalledWith('s1');
    });
    // A refusal must reach the caller. Answering the success envelope anyway would report a picture
    // as removed while it is still on the account.
    it('DELETE picture propagates a refusal rather than answering success', async () => {
        const { controller } = build({
            deleteProfilePicture: jest.fn().mockRejectedValue(new engine_refused_error_1.EngineRefusedError('refused')),
        });
        await expect(controller.deletePicture('s1')).rejects.toBeInstanceOf(engine_refused_error_1.EngineRefusedError);
    });
    it('PUT name delegates and returns the success envelope', async () => {
        const { controller, service } = build({ setProfileName: jest.fn().mockResolvedValue(undefined) });
        await expect(controller.setName('s1', { name: 'New Name' })).resolves.toEqual({
            success: true,
            message: 'Profile name updated',
        });
        expect(service.setProfileName).toHaveBeenCalledWith('s1', 'New Name');
    });
    it('PUT status delegates and returns the success envelope', async () => {
        const { controller, service } = build({ setProfileStatus: jest.fn().mockResolvedValue(undefined) });
        await expect(controller.setStatus('s1', { status: 'busy' })).resolves.toEqual({
            success: true,
            message: 'Profile status updated',
        });
        expect(service.setProfileStatus).toHaveBeenCalledWith('s1', 'busy');
    });
    it('PUT picture forwards the media body unchanged and returns the success envelope', async () => {
        const { controller, service } = build({ setProfilePicture: jest.fn().mockResolvedValue(undefined) });
        const dto = { base64: 'QUJD', mimetype: 'image/png' };
        await expect(controller.setPicture('s1', dto)).resolves.toEqual({
            success: true,
            message: 'Profile picture updated',
        });
        expect(service.setProfilePicture).toHaveBeenCalledWith('s1', dto);
    });
});
