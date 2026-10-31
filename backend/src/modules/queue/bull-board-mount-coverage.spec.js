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
const path = __importStar(require("path"));
/**
 * The queue dashboard is a middleware mount, not a Nest controller — so neither
 * global-route-fence-coverage.spec.ts nor the APP_GUARD pipeline can see it. Its auth fence
 * (BullBoardAuthMiddleware) only holds while the mount path in main.ts covers the exact path
 * BullBoardModule serves. A drift in any of the three literals (global prefix, module route,
 * middleware mount) silently re-opens the deployment-global mount to session-restricted keys —
 * or 404s the board — and no other test or CI step would catch it. This spec is that tripwire.
 */
function extractGlobalPrefix(appValidationSrc) {
    const match = /setGlobalPrefix\(\s*'([^']+)'/.exec(appValidationSrc);
    if (!match)
        throw new Error('setGlobalPrefix literal not found in app-validation.js');
    return match[1];
}
function extractBullBoardRoute(queueModuleSrc) {
    const match = /BullBoardModule\.forRoot\(\{\s*route:\s*'([^']+)'/.exec(queueModuleSrc);
    if (!match)
        throw new Error('BullBoardModule route literal not found in queue.module.js');
    return match[1];
}
function mountCoversRoute(mainSrc, prefix, route) {
    return mainSrc.includes(`app.use('/${prefix}${route}'`);
}
describe('bull-board mount path tripwire', () => {
    const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
    const queueModuleSrc = fs.readFileSync(path.join(__dirname, 'queue.module.js'), 'utf8');
    const appValidationSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'app-validation.js'), 'utf8');
    it('main.ts mounts the auth middleware on the exact path BullBoardModule serves', () => {
        const prefix = extractGlobalPrefix(appValidationSrc);
        const route = extractBullBoardRoute(queueModuleSrc);
        expect(mountCoversRoute(mainSrc, prefix, route)).toBe(true);
    });
    it('the check fails when any of the three literals drifts', () => {
        expect(mountCoversRoute(mainSrc, 'api', '/other/path')).toBe(false);
        expect(mountCoversRoute(mainSrc, 'wrongprefix', '/admin/queues')).toBe(false);
        expect(mountCoversRoute("app.use('/api/admin/queues', handler);", 'api', '/admin/queues')).toBe(true);
    });
});
