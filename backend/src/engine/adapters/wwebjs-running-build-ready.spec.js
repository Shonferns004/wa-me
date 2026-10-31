"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const whatsapp_web_js_1 = require("whatsapp-web.js");
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const wa_web_version_1 = require("../wa-web-version");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const wwebjs_running_build_1 = require("./wwebjs-running-build");
const wwebjs_call_hook_check_1 = require("./wwebjs-call-hook-check");
const engine_patch_status_1 = require("./engine-patch-status");
jest.mock('../wa-web-version', () => ({ resolveWebVersionPin: jest.fn() }));
jest.mock('./wwebjs-running-build', () => ({ reportRunningWebBuild: jest.fn() }));
jest.mock('./wwebjs-call-hook-check', () => ({ reportMissingCallHook: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./engine-patch-status', () => ({
    unappliedPatches: jest.fn().mockReturnValue([]),
    unappliedPatchesMessage: jest.fn().mockReturnValue(''),
}));
jest.mock('./chromium-profile-hygiene', () => ({
    killOrphanedChromiumProcesses: jest.fn().mockResolvedValue(undefined),
    removeStaleSingletonFiles: jest.fn().mockResolvedValue(undefined),
}));
const resolvePin = wa_web_version_1.resolveWebVersionPin;
const report = wwebjs_running_build_1.reportRunningWebBuild;
const callHookReport = wwebjs_call_hook_check_1.reportMissingCallHook;
const patches = engine_patch_status_1.unappliedPatches;
const pinFor = (webVersion) => ({
    webVersion,
    webVersionCache: { type: 'remote', remotePath: `https://example.invalid/${webVersion}.html` },
});
/**
 * The running-build probe compares the page against the pin THIS init requested, and it is a
 * diagnostic: READY must never wait on it or depend on how it settles.
 */
describe('the running-build probe at READY', () => {
    let clientInitSpy;
    let onReady;
    const page = { evaluate: jest.fn() };
    /** A lifecycle taken through a real initialize() (the browser launch stubbed), then to READY. */
    const initializedLifecycle = async () => {
        const host = {
            logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
            config: { sessionId: 'sess', sessionDataPath: './data/sessions' },
            getCallbacks: () => ({ onReady }),
            scheduleReadyReconcile: jest.fn(),
            clearReadyReconcile: jest.fn(),
            startOnboardingWatcher: jest.fn(),
            clearOnboardingWatcher: jest.fn(),
            clearLiveCalls: jest.fn(),
            clearLocalAuth: jest.fn().mockResolvedValue(undefined),
            attachDomainEvents: jest.fn(),
        };
        const lc = new wwebjs_lifecycle_1.WwebjsLifecycle(host);
        await lc.initialize();
        return lc;
    };
    const promoteToReady = (lc) => {
        lc.client.pupPage = page;
        lc.markReadyFromClientInfo();
    };
    beforeEach(() => {
        onReady = jest.fn();
        resolvePin.mockReset();
        report.mockReset().mockResolvedValue(undefined);
        callHookReport.mockClear();
        patches.mockReset().mockReturnValue([]);
        clientInitSpy = jest
            .spyOn(whatsapp_web_js_1.Client.prototype, 'initialize')
            .mockResolvedValue(undefined);
    });
    afterEach(() => {
        clientInitSpy.mockRestore();
    });
    it('hands the probe the page, the session and the pin this init requested', async () => {
        resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
        const lc = await initializedLifecycle();
        promoteToReady(lc);
        expect(report).toHaveBeenCalledTimes(1);
        expect(report).toHaveBeenCalledWith(page, expect.anything(), 'sess', '2.3000.1047787617-alpha');
    });
    it('hands the probe no pin when this init requested none', async () => {
        resolvePin.mockResolvedValue(undefined);
        const lc = await initializedLifecycle();
        promoteToReady(lc);
        expect(report).toHaveBeenCalledWith(page, expect.anything(), 'sess', undefined);
    });
    // A pin from an earlier init must never be compared against the page a later, unpinned init loads.
    it('replaces the pin on every init, including with none', async () => {
        resolvePin.mockResolvedValueOnce(pinFor('2.3000.1047787617-alpha')).mockResolvedValueOnce(undefined);
        const lc = await initializedLifecycle();
        await lc.initialize();
        promoteToReady(lc);
        expect(report).toHaveBeenCalledWith(page, expect.anything(), 'sess', undefined);
    });
    it('promotes to READY without waiting for the probe to settle', async () => {
        resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
        report.mockReturnValue(new Promise(() => undefined)); // never settles
        const lc = await initializedLifecycle();
        promoteToReady(lc);
        expect(report).toHaveBeenCalledTimes(1);
        expect(lc.status).toBe(whatsapp_engine_interface_1.EngineStatus.READY);
        expect(onReady).toHaveBeenCalledTimes(1);
    });
    it('stays READY when the probe rejects', async () => {
        resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
        const lc = await initializedLifecycle();
        const rejection = Promise.reject(new Error('probe failed'));
        rejection.catch(() => undefined); // keep the test run free of an unhandled rejection
        report.mockReturnValue(rejection);
        expect(() => promoteToReady(lc)).not.toThrow();
        await new Promise(resolve => setImmediate(resolve));
        expect(report).toHaveBeenCalledTimes(1);
        expect(lc.status).toBe(whatsapp_engine_interface_1.EngineStatus.READY);
        expect(onReady).toHaveBeenCalledTimes(1);
    });
    // Unlike the call-hook probe, this one does not depend on when whatsapp-web.js finished injecting:
    // `window.Debug.VERSION` is WhatsApp Web's own. A tree missing the ready-sync patch keeps the log.
    it('still runs on a tree missing the ready-sync patch, which skips the call-hook probe', async () => {
        patches.mockReturnValue(['patch-wwebjs-ready-sync']);
        resolvePin.mockResolvedValue(pinFor('2.3000.1047787617-alpha'));
        const lc = await initializedLifecycle();
        promoteToReady(lc);
        expect(callHookReport).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledTimes(1);
    });
});
