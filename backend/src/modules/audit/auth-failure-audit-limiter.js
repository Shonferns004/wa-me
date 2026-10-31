"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.allowUnauthenticatedAuditRow = allowUnauthenticatedAuditRow;
const ws_rate_limit_1 = require("../events/ws-rate-limit");
const ip_1 = require("../../common/utils/ip");
/**
 * Per-IP budget for API_KEY_AUTH_FAILED rows written by the REST guard, the Bull Board mount and the
 * MCP key gate for a rejection that resolved no key (UnresolvedApiKeyException: no key, or a key that
 * matches no row). Such a rejection costs the caller nothing, and the throttler counts per route
 * handler, so without this bound one source could write audit rows as fast as it can send requests.
 * One module-level instance so all three surfaces draw on a single budget per client: 10 rows a
 * minute, the same bound the health route applies to its own probes. A rejection of a stored key
 * (revoked, expired, IP or session refused, or a 403) is not charged here; it is always audited.
 */
const limiter = new ws_rate_limit_1.SlidingWindowLimiter(10, 60_000);
/** True while `clientIp` still has budget for an unauthenticated auth-failure audit row. */
function allowUnauthenticatedAuditRow(clientIp) {
    return limiter.allow((0, ip_1.limiterKeyForIp)(clientIp));
}
