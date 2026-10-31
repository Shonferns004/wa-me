"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = teardown;
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
/**
 * Remove the throwaway state roots the lane creates.
 *
 * Every suite gets its own root (setupFiles runs once per test file), so a run leaves one directory
 * per suite behind. Nothing removed them before and the temp dir accumulated hundreds of entries.
 * Anything older than an hour is swept rather than only this run's roots: a killed run leaves its
 * own litter, and the age bound keeps this from deleting a root a concurrent run is still using.
 */
const MAX_AGE_MS = 60 * 60 * 1000;
function teardown() {
    const root = (0, os_1.tmpdir)();
    const cutoff = Date.now() - MAX_AGE_MS;
    let entries;
    try {
        entries = (0, fs_1.readdirSync)(root).filter(name => name.startsWith('openwa-e2e-'));
    }
    catch {
        return;
    }
    for (const name of entries) {
        const target = (0, path_1.join)(root, name);
        try {
            if ((0, fs_1.statSync)(target).mtimeMs < cutoff)
                (0, fs_1.rmSync)(target, { force: true, recursive: true });
        }
        catch {
            // A root the OS or another run removed underneath us is already the outcome we wanted.
        }
    }
}
