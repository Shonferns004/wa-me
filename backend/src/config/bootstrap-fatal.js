"use strict";
/**
 * Fatal-bootstrap handling: log, best-effort teardown, then a real exit.
 *
 * Extracted from `main.ts` so the failure contract is unit-tested without booting the app.
 *
 * Why a real `process.exit(1)` instead of only setting `process.exitCode`: Nest's `listen()` runs the
 * FULL module init (sessions, Redis, Postgres, Chromium) before binding the port. If the bind then
 * fails (EADDRINUSE), setting `exitCode` alone leaves the event loop held open by those very handles —
 * the process becomes a zombie that serves no HTTP yet keeps the WhatsApp sessions running, and Docker's
 * `restart: unless-stopped` never fires because the container stays "running". Exiting lets the
 * orchestrator restart us onto a free port (or surface the conflict), and Puppeteer's own `exit`
 * handlers kill the browser children as the process goes down.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BOOTSTRAP_CLOSE_TIMEOUT_MS = void 0;
exports.runBootstrapOrExit = runBootstrapOrExit;
exports.DEFAULT_BOOTSTRAP_CLOSE_TIMEOUT_MS = 5000;
/**
 * Run `bootstrap()`; on ANY rejection (e.g. `listen()` failing with EADDRINUSE after full init), log the
 * fatal error, run the bounded best-effort teardown, and exit non-zero. A successful boot returns
 * normally and never touches `exit`.
 *
 * Every step is guarded: a throwing logger or teardown degrades to losing that one step while the exit
 * still proceeds — the exit is the guarantee the orchestrator relies on.
 */
async function runBootstrapOrExit(bootstrap, deps) {
    try {
        await bootstrap();
        return;
    }
    catch (err) {
        try {
            deps.logger.error('Fatal error during bootstrap — process will exit', err instanceof Error ? err.stack : String(err));
        }
        catch {
            /* never mask the original fatal error */
        }
    }
    if (deps.closeApp) {
        try {
            const closeApp = deps.closeApp;
            await Promise.race([
                Promise.resolve().then(() => closeApp()),
                // Not unref'd: a teardown parked on a promise that holds no handle would let the loop drain, and
                // the process would exit 0 on its own before the exit below ran.
                new Promise(resolve => {
                    setTimeout(resolve, deps.closeTimeoutMs ?? exports.DEFAULT_BOOTSTRAP_CLOSE_TIMEOUT_MS);
                }),
            ]);
        }
        catch {
            /* best-effort teardown — the exit below is what matters */
        }
    }
    (deps.exit ?? ((code) => process.exit(code)))(1);
}
