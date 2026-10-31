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
exports.killOrphanedChromiumProcesses = killOrphanedChromiumProcesses;
exports.removeStaleSingletonFiles = removeStaleSingletonFiles;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process_1 = require("child_process");
const auth_dir_paths_1 = require("../auth-dir-paths");
/**
 * SIGKILL any Chromium orphaned by a previous lifetime of this process. When OpenWA dies hard
 * (kill -9, crash, host reboot) Puppeteer's exit hook never runs, so the browser survives as an
 * orphan — leaking memory and pinning the session profile dir. Orphans are identified by the
 * `--openwa-session=<id>` marker arg appended to the puppeteer args at launch (Chromium ignores
 * the unknown flag; it is purely a `ps` label). Best-effort: never throws — a `ps` failure only
 * logs at debug, so the sweep can never block an engine start.
 */
async function killOrphanedChromiumProcesses(sessionId, logger) {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
        logger.debug(`Skipping orphaned Chromium sweep: unsupported platform ${process.platform}`);
        return;
    }
    try {
        // No shell: the args array is handed to ps verbatim, so nothing here is injectable.
        // maxBuffer is raised because `ps -eo args` prints full command lines, which on a busy host
        // (many Chromium renderers carrying dozens of flags each) can exceed the 1MB default.
        const psOutput = await new Promise((resolve, reject) => {
            (0, child_process_1.execFile)('ps', ['-eo', 'pid=,args='], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
                // The @types/node ExecFileException is an Omit<> of ErrnoException, which the type
                // checker no longer recognises as an Error — narrow it explicitly for the reject.
                if (error)
                    reject(error instanceof Error ? error : new Error(error.message));
                else
                    resolve(stdout);
            });
        });
        // Token-exact marker match: the marker is a single argv token, so it must appear delimited by
        // whitespace or string boundaries. A plain substring test would let restarting session
        // `sales` SIGKILL the LIVE browser of sibling `sales2` (their markers share a prefix).
        const marker = `--openwa-session=${sessionId}`;
        const markerRe = new RegExp('(?:^|\\s)' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)');
        const killedPids = [];
        for (const line of psOutput.split('\n')) {
            const match = /^\s*(\d+)\s+(.*)$/.exec(line);
            if (!match)
                continue;
            const pid = Number(match[1]);
            const args = match[2];
            if (pid === process.pid || !markerRe.test(args))
                continue;
            // Never kill a non-browser process that happens to carry the marker string
            // (e.g. a `grep --openwa-session=…` probing the process table).
            if (!/chrome|chromium|headless/i.test(args))
                continue;
            try {
                process.kill(pid, 'SIGKILL');
                killedPids.push(pid);
            }
            catch (error) {
                // ESRCH: the process exited between `ps` and the kill — nothing left to do.
                if (error.code !== 'ESRCH') {
                    logger.debug(`Could not SIGKILL orphaned Chromium pid ${pid}`, { error: String(error) });
                }
            }
        }
        if (killedPids.length > 0) {
            logger.log(`Killed ${killedPids.length} orphaned Chromium process(es) left over from a previous process lifetime`, { sessionId, pids: killedPids });
        }
    }
    catch (error) {
        logger.debug('Could not enumerate processes for the orphaned Chromium sweep', { error: String(error) });
    }
}
/**
 * Remove Chromium's SingletonLock/SingletonSocket/SingletonCookie from the LocalAuth profile dir
 * (same dir clearLocalAuth removes) before the browser launches. A hard-killed Chromium
 * (SIGKILL/crash) leaves them behind, and on some setups (e.g. Docker PID reuse) the stale files
 * block the next launch unless they are cleared first. Best-effort: a removal
 * failure only logs at debug and never fails the start.
 */
async function removeStaleSingletonFiles(sessionId, sessionDataPath, logger) {
    const profileDir = (0, auth_dir_paths_1.wwjsAuthDir)(sessionDataPath, sessionId);
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
        try {
            await fs.promises.rm(path.join(profileDir, name), { force: true });
        }
        catch (error) {
            logger.debug(`Could not remove stale ${name} from ${profileDir}`, { error: String(error) });
        }
    }
}
