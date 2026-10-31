"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KeyRateLimiter = void 0;
exports.readRateLimitConfig = readRateLimitConfig;
exports.readIpRateLimitConfig = readIpRateLimitConfig;
const common_1 = require("@nestjs/common");
const env_int_1 = require("../../common/utils/env-int");
const ws_rate_limit_1 = require("../events/ws-rate-limit");
const DEFAULT_MAX = 60;
const DEFAULT_WINDOW_MS = 60_000;
// Pre-auth per-IP budget: more generous than the per-key one so a legitimate multi-key host behind one
// IP (e.g. a shared proxy) isn't starved, while still bounding an unauthenticated key-probing flood.
const DEFAULT_IP_MAX = 120;
const DEFAULT_MAX_KEYS = 50_000;
/**
 * Read MCP rate-limit configuration from the environment.
 * Falls back to the default for any missing, blank, non-positive, or non-numeric value.
 */
function readRateLimitConfig(env = process.env) {
    return {
        max: (0, env_int_1.positiveIntOrDefault)(env['MCP_RATE_LIMIT_MAX'], DEFAULT_MAX),
        windowMs: (0, env_int_1.positiveIntOrDefault)(env['MCP_RATE_LIMIT_WINDOW_MS'], DEFAULT_WINDOW_MS),
    };
}
/**
 * Read the PRE-AUTH per-IP MCP throttle config. Independent of the per-key vars above (which must not
 * bleed in), with the same blank/non-positive/non-numeric fallback.
 */
function readIpRateLimitConfig(env = process.env) {
    return {
        max: (0, env_int_1.positiveIntOrDefault)(env['MCP_IP_RATE_LIMIT_MAX'], DEFAULT_IP_MAX),
        windowMs: (0, env_int_1.positiveIntOrDefault)(env['MCP_IP_RATE_LIMIT_WINDOW_MS'], DEFAULT_WINDOW_MS),
    };
}
/**
 * Per-API-key sliding window rate limiter.
 * The inherited IP-keyed throttler collapses all MCP calls into one 127.0.0.1 bucket,
 * so MCP needs its own per-key limiter.
 * In-memory per-process; move to Redis for multi-instance deployments. The key map is capped with
 * approximate LRU eviction so a distinct-key flood cannot grow process memory without limit.
 */
class KeyRateLimiter {
    window;
    constructor(max = 60, windowMs = 60_000, now = () => Date.now(), maxKeys = DEFAULT_MAX_KEYS) {
        this.window = new ws_rate_limit_1.SlidingWindowLimiter(max, windowMs, now, maxKeys);
    }
    check(key) {
        if (!this.window.allow(key)) {
            throw new common_1.HttpException('MCP rate limit exceeded', common_1.HttpStatus.TOO_MANY_REQUESTS);
        }
    }
}
exports.KeyRateLimiter = KeyRateLimiter;
