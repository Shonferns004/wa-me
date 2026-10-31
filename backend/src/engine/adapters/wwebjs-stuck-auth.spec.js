"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const wwebjs_stuck_auth_1 = require("./wwebjs-stuck-auth");
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * The stuck-auth recovery removes the session's LocalAuth profile. A stop and start arriving while
 * that rm is still walking the tree would launch a new Chromium into the directory being deleted,
 * so the rm must be registered with the credential-teardown fence before it is awaited, exactly as
 * the logout path registers its own removal.
 */
describe('WwebjsStuckAuth.recoverFromStuckAuth', () => {
    afterEach(() => jest.restoreAllMocks());
    it('registers the profile removal with the teardown fence while it is still running', async () => {
        let finishRm;
        jest.spyOn(fs.promises, 'rm').mockReturnValue(new Promise(resolve => (finishRm = resolve)));
        const registered = [];
        const setStatus = jest.fn();
        const host = {
            logger: (0, logger_service_1.createLogger)('wwebjs-stuck-auth.spec'),
            config: { sessionId: 's1', sessionDataPath: './data/sessions', puppeteer: {} },
            getClient: () => null,
            setClient: jest.fn(),
            setStatus,
            getCallbacks: () => ({
                claimStuckAuthRecovery: () => true,
                onCredentialTeardownStarted: (operation) => registered.push(operation),
            }),
        };
        const recovery = new wwebjs_stuck_auth_1.WwebjsStuckAuth(host).recoverFromStuckAuth();
        await Promise.resolve();
        expect(registered).toHaveLength(1);
        let settled = false;
        void registered[0].then(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false);
        finishRm();
        await recovery;
        expect(settled).toBe(true);
        expect(setStatus).toHaveBeenCalledWith(whatsapp_engine_interface_1.EngineStatus.DISCONNECTED);
    });
});
