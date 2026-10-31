"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_web_js_1 = require("whatsapp-web.js");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const wwebjs_backport_check_1 = require("./wwebjs-backport-check");
const engine_patch_status_1 = require("./engine-patch-status");
jest.mock('./wwebjs-backport-check', () => ({ backportProblem: jest.fn() }));
jest.mock('./engine-patch-status', () => ({
    unappliedPatches: jest.fn().mockReturnValue([]),
    unappliedPatchesMessage: jest.fn(),
}));
jest.mock('./wwebjs-running-build', () => ({ reportRunningWebBuild: jest.fn() }));
jest.mock('./wwebjs-call-hook-check', () => ({ reportMissingCallHook: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./chromium-profile-hygiene', () => ({
    killOrphanedChromiumProcesses: jest.fn().mockResolvedValue(undefined),
    removeStaleSingletonFiles: jest.fn().mockResolvedValue(undefined),
}));
const problem = wwebjs_backport_check_1.backportProblem;
const unapplied = engine_patch_status_1.unappliedPatches;
const unappliedText = engine_patch_status_1.unappliedPatchesMessage;
/**
 * An install whose patches did not land fails later with errors that name no cause, so the engine says
 * so at the start, where the operator is looking at the logs. The checks are pure functions with their
 * own specs; this is the call that makes them reach anyone.
 */
describe('the patch diagnostics at whatsapp-web.js start', () => {
    let clientInitSpy;
    let logger;
    const initialize = async () => {
        const host = {
            logger,
            config: { sessionId: 'sess', sessionDataPath: './data/sessions' },
            getCallbacks: () => ({}),
            scheduleReadyReconcile: jest.fn(),
            clearReadyReconcile: jest.fn(),
            startOnboardingWatcher: jest.fn(),
            clearOnboardingWatcher: jest.fn(),
            clearLiveCalls: jest.fn(),
            clearLocalAuth: jest.fn().mockResolvedValue(undefined),
            attachDomainEvents: jest.fn(),
        };
        await new wwebjs_lifecycle_1.WwebjsLifecycle(host).initialize();
    };
    beforeEach(() => {
        logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
        problem.mockReset().mockReturnValue(undefined);
        unapplied.mockReset().mockReturnValue([]);
        unappliedText.mockReset().mockReturnValue('patch text');
        clientInitSpy = jest
            .spyOn(whatsapp_web_js_1.Client.prototype, 'initialize')
            .mockResolvedValue(undefined);
    });
    afterEach(() => {
        clientInitSpy.mockRestore();
    });
    it('logs the message-id backport problem as an error', async () => {
        problem.mockReturnValue('the backport is missing');
        await initialize();
        expect(logger.error).toHaveBeenCalledWith('the backport is missing');
    });
    it('logs the patches that did not land as an error', async () => {
        unapplied.mockReturnValue(['status']);
        unappliedText.mockReturnValue('the status patch is not applied');
        await initialize();
        expect(unappliedText).toHaveBeenCalledWith('wwebjs', ['status']);
        expect(logger.error).toHaveBeenCalledWith('the status patch is not applied');
    });
    it('says nothing when every patch landed', async () => {
        await initialize();
        expect(logger.error).not.toHaveBeenCalled();
    });
});
