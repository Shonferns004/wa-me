"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// e2e boot environment. Set BEFORE AppModule is imported (setupFiles phase) so the
// app boots against local SQLite with no Redis/queue and no production boot guard.
//
// These suites run ONE AT A TIME (`maxWorkers: 1` in jest-e2e.json). That began as a fix for
// parallel workers fighting over one plugin registry, and the measurement below records it. Serial
// execution did not close the whole hole: the registry was shared SEQUENTIALLY too. Each suite
// boots a real application, and closing it disables every enabled plugin, which writes
// `status: disabled` into the registry the NEXT suite then boots against. Measured directly:
// set the whatsapp-web.js engine to `enabled`, run one AppModule-booting suite, and it comes back
// `disabled`. The same write landed in the DEVELOPER's `./data/plugins/registry.json`.
// PLUGIN_STATE_DIR below redirects it, the way the databases and the key file are redirected.
// Measured on one parallel run: 52 writes from 12 processes, 30 of them landing within 500ms of a
// write by a different process. Each individual write is atomic, but the read-modify-write cycle
// is not, so workers overwrote and re-read each other's plugin state.
//
// The result was a roughly one-in-ten failure that moved between suites — a 403 where a 200 was
// expected, a 404 where a 403 was, a rate-limit window behaving oddly — and never reproduced when a
// suite was run on its own, which is what made it read as flakiness. Serially it does not happen:
// 11 consecutive clean runs against a measured failure rate of about one in twelve in parallel.
//
// Restoring parallelism means giving each worker its own data root, not just its own database.
const path_1 = require("path");
const os_1 = require("os");
const fs_1 = require("fs");
const core_1 = require("@nestjs/core");
const nestAppProto = core_1.NestApplication.prototype;
if (!nestAppProto.__e2eLoopbackListening) {
    const originalInit = nestAppProto.init;
    nestAppProto.init = async function (...args) {
        const result = await originalInit.apply(this, args);
        const server = this.getHttpServer();
        if (server && typeof server.listen === 'function' && !server.listening) {
            // A failed bind arrives as an 'error' event, not as this callback. Waiting on the callback
            // alone leaves init() pending AND, with nothing listening for 'error', Node throws it detached
            // from the call that caused it. Either half is the unexplained failure this block exists to
            // remove, so the event is what settles the wait.
            await new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(0, '127.0.0.1', () => {
                    server.removeListener('error', reject);
                    resolve();
                });
            });
            server.__e2eAutoListened = true;
        }
        return result;
    };
    // `listen()` initialises first and then binds the SAME server, so the port taken above would meet it
    // as ERR_SERVER_ALREADY_LISTEN on its own socket. Initialise here, hand that port back, and let the
    // real call bind whatever it was asked for. A hostless port keeps the loopback the lane relies on,
    // since a wildcard bind is exactly what the block above exists to avoid.
    const originalListen = nestAppProto.listen;
    nestAppProto.listen = async function (...args) {
        await this.init();
        const server = this.getHttpServer();
        if (server?.__e2eAutoListened && server.listening) {
            delete server.__e2eAutoListened;
            await new Promise(resolve => server.close(() => resolve()));
        }
        const wantsDefaultHost = args.length <= 1 || typeof args[1] !== 'string';
        return wantsDefaultHost
            ? originalListen.call(this, args[0], '127.0.0.1', ...args.slice(1))
            : originalListen.apply(this, args);
    };
    nestAppProto.__e2eLoopbackListening = true;
}
process.env.NODE_ENV = 'test';
// The plugin registry + per-plugin storage: the last state a suite could not isolate.
// Keyed per SETUP RUN, not per process: setupFiles executes once per test file, so a pid-keyed path
// would be one directory shared by every suite in the run, and wiping it at each suite's start
// would pull the tree out from under any app a previous suite left running.
const e2eRunId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const e2ePluginState = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-e2e-plugins-${e2eRunId}`);
process.env.PLUGIN_STATE_DIR = e2ePluginState;
// The package directory beside the registry, as in production. Left unset it is the checkout's
// ./data/plugins, and the legacy ./plugins is scanned too: every boot would load and reconcile the
// developer's real plugin tree.
process.env.PLUGINS_DIR = (0, path_1.join)(e2ePluginState, 'plugins');
// The remaining data paths. Each already carries its own knob, and leaving them unset pointed every
// suite at the same `./data/sessions`, `./data/baileys` and `./data/media`: shared between suites
// in a run, and the developer's own directories besides.
for (const [key, name] of [
    ['SESSION_DATA_PATH', 'sessions'],
    ['BAILEYS_AUTH_DIR', 'baileys'],
    ['STORAGE_LOCAL_PATH', 'media'],
]) {
    process.env[key] = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-e2e-${name}-${e2eRunId}`);
}
process.env.DATABASE_TYPE = 'sqlite';
// Isolate the e2e data DB to a throwaway temp file so suites never pollute the developer's
// ./data/openwa.sqlite. e2e creates sessions/webhooks and doesn't self-clean, so without this they
// pile up across runs. Start each run from a fresh file.
const e2eDataDb = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-e2e-${process.pid}.sqlite`);
(0, fs_1.rmSync)(e2eDataDb, { force: true });
process.env.DATABASE_NAME = e2eDataDb;
// Likewise isolate the auth/audit (main) DB, so e2e api-keys don't accumulate in ./data/main.sqlite.
const e2eMainDb = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-e2e-main-${process.pid}.sqlite`);
(0, fs_1.rmSync)(e2eMainDb, { force: true });
process.env.MAIN_DATABASE_NAME = e2eMainDb;
// The bootstrap key file is written on first boot (no keys yet — which every e2e run is) and unlinked
// when that key is revoked or deleted. Without a lever it resolves under the repo root, so an e2e run
// rewrote the DEVELOPER'S ./data/.api-key. Point it at the same throwaway temp dir as the databases.
const e2eKeyFile = (0, path_1.join)((0, os_1.tmpdir)(), `openwa-e2e-key-${process.pid}`);
(0, fs_1.rmSync)(e2eKeyFile, { force: true });
process.env.BOOTSTRAP_KEY_FILE = e2eKeyFile;
process.env.QUEUE_ENABLED = 'false';
// Likewise force Redis off per suite, over an ambient REDIS_ENABLED inherited from the developer's
// shell or the CI env; without this reset a suite would boot with Redis-backed throttling/cache.
process.env.REDIS_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
// Keep the auth/audit + data schema zero-config for the test boot.
process.env.MAIN_DATABASE_SYNCHRONIZE = 'true';
process.env.DATABASE_SYNCHRONIZE = 'true';
// e2e suites burst many requests at the API; relax the per-second rate limit so the
// ThrottlerGuard (still wired) doesn't 429 a normal test run.
process.env.RATE_LIMIT_SHORT_LIMIT = '100000';
process.env.RATE_LIMIT_MEDIUM_LIMIT = '100000';
process.env.RATE_LIMIT_LONG_LIMIT = '100000';
