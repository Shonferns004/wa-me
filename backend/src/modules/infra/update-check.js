"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.__resetUpdateCheckCache = __resetUpdateCheckCache;
exports.isNewerRelease = isNewerRelease;
exports.checkForUpdate = checkForUpdate;
const plugin_download_1 = require("../plugins/plugin-download");
const catalog_1 = require("../plugins/catalog");
const ssrf_guard_1 = require("../../common/security/ssrf-guard");
const logger_service_1 = require("../../common/services/logger.service");
const logger = (0, logger_service_1.createLogger)('UpdateCheck');
// Same source as /api/health: the version that ships with the running code, not a build-time stamp.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: APP_VERSION } = require('../../../package.json');
// GitHub's `/releases/latest` skips drafts and prereleases, so only a published release is offered.
const LATEST_RELEASE_URL = 'https://api.github.com/repos/rmyndharis/OpenWA/releases/latest';
const RELEASE_PAGE_URL = 'https://github.com/rmyndharis/OpenWA/releases/tag/';
// One unauthenticated request per process per window stays far inside GitHub's 60 per hour per IP,
// while a long-running instance still notices a new release the same day.
const SUCCESS_TTL_MS = 6 * 60 * 60_000;
const FAILURE_BACKOFF_MS = 15 * 60_000;
// The response carries the release notes, which run to tens of KB.
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5_000;
// A plain release tag only. The `v` is stripped before comparing: compareSemver reads `v1` as 0.
const RELEASE_TAG = /^v?(\d+\.\d+\.\d+)$/;
let latest = null;
let nextCheckAt = 0;
let inFlight = null;
/** Test-only: forget the cached release between cases. */
function __resetUpdateCheckCache() {
    latest = null;
    nextCheckAt = 0;
    inFlight = null;
}
async function refresh() {
    try {
        const body = JSON.parse((await (0, plugin_download_1.fetchSafeBuffer)(LATEST_RELEASE_URL, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS })).toString('utf8'));
        const tag = typeof body.tag_name === 'string' ? body.tag_name : '';
        const match = RELEASE_TAG.exec(tag);
        // The link is built from the validated tag rather than taken from the response.
        latest = match ? { version: match[1], url: `${RELEASE_PAGE_URL}${tag}` } : null;
        nextCheckAt = Date.now() + SUCCESS_TTL_MS;
    }
    catch (error) {
        // Offline, blocked by egress policy, rate-limited or malformed: keep whatever was known and retry
        // later. Logged once per backoff window, redacted like any other guarded fetch.
        logger.debug('Release check failed', { error: (0, ssrf_guard_1.redactSsrfError)(error) });
        nextCheckAt = Date.now() + FAILURE_BACKOFF_MS;
    }
}
/**
 * Whether `latest` (a plain X.Y.Z) is newer than the running version. A running prerelease counts as
 * older than its own final release: compareSemver ignores the `-rc.1` suffix, so without this an
 * instance on 0.24.0-rc.1 would never hear that 0.24.0 is out.
 */
function isNewerRelease(latest, current) {
    const cmp = (0, catalog_1.compareSemver)(latest, current);
    return cmp > 0 || (cmp === 0 && current.includes('-'));
}
async function checkForUpdate() {
    if (process.env.UPDATE_CHECK_ENABLED === 'false') {
        return { current: APP_VERSION, latest: null, updateAvailable: false, releaseUrl: null };
    }
    if (Date.now() >= nextCheckAt) {
        inFlight ??= refresh().finally(() => {
            inFlight = null;
        });
        await inFlight;
    }
    return {
        current: APP_VERSION,
        latest: latest?.version ?? null,
        updateAvailable: latest !== null && isNewerRelease(latest.version, APP_VERSION),
        releaseUrl: latest?.url ?? null,
    };
}
