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
exports.WwebjsStuckAuth = void 0;
const fs = __importStar(require("fs"));
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const auth_dir_paths_1 = require("../auth-dir-paths");
class WwebjsStuckAuth {
    host;
    // Guards the stuck-auth self-heal so it runs at most once per engine: a re-paired session that still
    // can't reach readiness fails terminally instead of looping QR -> timeout -> clear forever.
    recoveryAttempted = false;
    constructor(host) {
        this.host = host;
    }
    /**
     * Recover a session that authenticated but never reached runtime readiness (stale/incompatible auth
     * or a wedged page). Clear the broken LocalAuth and disconnect so the session lifecycle re-pairs (a
     * fresh QR) instead of hanging at "authenticating". Runs at most ONCE per reconnect episode: the
     * one-shot budget lives on the session (via the synchronous `claimStuckAuthRecovery` callback), so
     * an automatic reconnect that builds a fresh adapter cannot reset it and wipe LocalAuth every
     * generation. A re-paired session that still can't reach readiness fails terminally rather than looping.
     *
     * When the callback is ABSENT (standalone adapter use/test, no session lifecycle) the adapter falls
     * back to its own instance-local boolean so standalone behavior stays one-shot.
     */
    async recoverFromStuckAuth() {
        // The one-shot budget is decided SYNCHRONOUSLY before any destructive I/O. The session-owned
        // callback is authoritative when present; the instance-local boolean is the standalone fallback.
        // Fail-closed: a callback that throws (or already-spent budget) makes this terminal WITHOUT
        // touching the auth dir, so a wedged claim path can never wipe the only copy of the credentials.
        const claim = this.host.getCallbacks().claimStuckAuthRecovery;
        let granted;
        if (claim) {
            try {
                granted = claim();
            }
            catch {
                granted = false;
            }
        }
        else {
            granted = !this.recoveryAttempted;
            this.recoveryAttempted = true;
        }
        if (!granted) {
            this.host.setStatus(whatsapp_engine_interface_1.EngineStatus.FAILED);
            this.host
                .getCallbacks()
                .onError?.('WhatsApp Web could not reach readiness after re-pairing. Pin WWEBJS_WEB_VERSION to a known-good build and try again.');
            return;
        }
        const client = this.host.getClient();
        this.host.setClient(null);
        // Kill the wedged Chromium before removing its profile: a live browser keeps writing into the
        // directory being removed, which can exhaust the rm retries and leave half a profile behind.
        try {
            const browser = client?.pupBrowser;
            browser?.process?.()?.kill?.('SIGKILL');
        }
        catch (err) {
            this.host.logger.warn('Could not kill the browser before clearing the saved session', {
                sessionId: this.host.config.sessionId,
                error: String(err),
            });
        }
        // Clear auth + disconnect (the recovery path), then finish the client teardown in the background
        // so a hung destroy can't block (or skip) the recovery. The removal is registered with the
        // credential-teardown fence before it is awaited, as the logout path does: a stop and start
        // arriving meanwhile would otherwise launch a new Chromium into the directory being deleted.
        const removal = this.clearLocalAuth();
        this.host.getCallbacks().onCredentialTeardownStarted?.(removal);
        await removal;
        this.host.setStatus(whatsapp_engine_interface_1.EngineStatus.DISCONNECTED);
        // onDisconnected drives the lifecycle's reconnect, which re-creates the engine with no saved auth
        // → a fresh QR. (A no-op once the engine is superseded/torn down.)
        this.host.getCallbacks().onDisconnected?.('Saved session could not be restored; cleared for re-pairing');
        if (typeof client?.destroy === 'function')
            void client.destroy().catch(() => undefined);
    }
    /** Remove this session's LocalAuth directory so the next start re-pairs from a clean slate. */
    async clearLocalAuth() {
        const dir = (0, auth_dir_paths_1.wwjsAuthDir)(this.host.config.sessionDataPath, this.host.config.sessionId);
        await fs.promises
            // maxRetries mirrors LocalAuth's own default: on a WhatsApp-initiated unlink the library never
            // closes the browser, so Chromium is still rotating IndexedDB files while this walks the tree and
            // a bare rm reports ENOTEMPTY (#1072). Node's default is 0 retries, which is why the failure
            // surfaced here and never on the library's removal of the same directory.
            .rm(dir, { recursive: true, force: true, maxRetries: 4 })
            .then(() => {
            // #981: this is the only copy of the session's WhatsApp credentials, and removing it is not
            // recoverable — every later start finds an empty profile and can do nothing but show a QR. Say
            // so at the moment it happens: otherwise the sole trace is a session that silently stops
            // reconnecting, indistinguishable from a WhatsApp-side logout or an untouched profile.
            this.host.logger.warn(`Deleted this session's stored WhatsApp credentials at ${dir}. That was the only copy, so the ` +
                'next start cannot restore the link and comes back with a fresh QR to scan.', { sessionId: this.host.config.sessionId, dir, action: 'auth_cleared' });
        })
            .catch((error) => {
            this.host.logger.warn(`Could not clear stale auth at ${dir}`, {
                sessionId: this.host.config.sessionId,
                dir,
                error: String(error),
            });
        });
    }
}
exports.WwebjsStuckAuth = WwebjsStuckAuth;
