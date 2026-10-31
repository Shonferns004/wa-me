"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const engine_patch_status_1 = require("./engine-patch-status");
const wwebjs_call_hook_check_1 = require("./wwebjs-call-hook-check");
jest.mock('./engine-patch-status', () => ({
    unappliedPatches: jest.fn().mockReturnValue([]),
    unappliedPatchesMessage: jest.fn().mockReturnValue(''),
}));
jest.mock('./wwebjs-call-hook-check', () => ({ reportMissingCallHook: jest.fn().mockResolvedValue(undefined) }));
const patches = engine_patch_status_1.unappliedPatches;
const report = wwebjs_call_hook_check_1.reportMissingCallHook;
/**
 * The call-hook diagnostic is only meaningful once the page evaluate that installs the hook has
 * finished. The ready-sync patch is what guarantees that: without it a session can be promoted to
 * READY while the attach is still in flight, so the probe would read a hook that has simply not been
 * installed YET and warn about a fault that does not exist.
 */
function makeLifecycle() {
    const host = {
        logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
        config: { sessionId: 'sess', sessionDataPath: './data' },
        clearReadyReconcile: jest.fn(),
        startOnboardingWatcher: jest.fn(),
        getCallbacks: () => ({}),
    };
    const lc = new wwebjs_lifecycle_1.WwebjsLifecycle(host);
    lc.status = whatsapp_engine_interface_1.EngineStatus.INITIALIZING;
    lc.client = { info: { wid: { user: '628111' }, pushname: 'Me' } };
    return lc;
}
describe('the call-hook diagnostic is gated on the ready-sync patch', () => {
    beforeEach(() => {
        patches.mockReset().mockReturnValue([]);
        report.mockReset().mockResolvedValue(undefined);
    });
    it('runs the probe on a tree where the patch is applied', () => {
        const lc = makeLifecycle();
        lc.markReadyFromClientInfo();
        expect(lc.status).toBe(whatsapp_engine_interface_1.EngineStatus.READY);
        expect(report).toHaveBeenCalledTimes(1);
    });
    it('skips the probe when the ready-sync patch is missing', () => {
        patches.mockReturnValue(['patch-wwebjs-ready-sync']);
        const lc = makeLifecycle();
        lc.markReadyFromClientInfo();
        expect(lc.status).toBe(whatsapp_engine_interface_1.EngineStatus.READY); // the promotion itself is never affected
        expect(report).not.toHaveBeenCalled();
    });
    it('still runs the probe when some other whatsapp-web.js patch is missing', () => {
        // Only the patch that decides WHEN ready fires can make the probe lie; an unrelated one does not.
        patches.mockReturnValue(['patch-wwebjs-media-id']);
        const lc = makeLifecycle();
        lc.markReadyFromClientInfo();
        expect(report).toHaveBeenCalledTimes(1);
    });
});
