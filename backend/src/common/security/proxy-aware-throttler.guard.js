"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProxyAwareThrottlerGuard = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const ip_1 = require("../utils/ip");
const logger_service_1 = require("../services/logger.service");
const logger = (0, logger_service_1.createLogger)('ProxyAwareThrottlerGuard');
/**
 * The single metadata key a bare `@SkipThrottle()` writes.
 *
 * The decorator defaults its argument to `{ default: true }` and writes `THROTTLER:SKIP` + each key
 * of that object, so the bare form produces exactly this one. The base guard instead reads
 * `THROTTLER:SKIP` + the name of each CONFIGURED tier, and this application names its tiers `short`,
 * `medium` and `long` — so the two spellings never intersect and a bare decorator is inert.
 */
const LIBRARY_DEFAULT_SKIP_KEY = 'THROTTLER:SKIPdefault';
/**
 * Rate-limit bucket keyed on the resolved client IP.
 *
 * The stock ThrottlerGuard keys on `req.ip`, which — behind the documented reverse
 * proxy with Express `trust proxy` disabled — resolves to the proxy for every client,
 * so all traffic shares ONE bucket and a single abuser rate-limits everyone (self-DoS).
 *
 * This reuses the same trusted-proxy-aware resolution as ApiKeyGuard: with no
 * TRUSTED_PROXIES configured it falls back to the socket IP (no behavior change and no
 * XFF-spoofing risk); with trusted proxies it keys on the real forwarded client IP.
 *
 * The resolved address is normalized through `@nestjs/throttler`'s `normalizeIp`:
 * IPv6 addresses are masked to `ipv6SubnetPrefix` (default /64) so that an IPv6 client
 * cannot evade rate limits by rotating addresses within its subnet, while IPv4,
 * IPv4-mapped, and loopback addresses remain unchanged.
 */
let ProxyAwareThrottlerGuard = class ProxyAwareThrottlerGuard extends throttler_1.ThrottlerGuard {
    /**
     * The shared-bucket condition is deployment-wide, so the warning fires once per guard instance.
     * In practice that is once per process: this guard runs as the singleton APP_GUARD. The only other
     * instance is InstanceThrottlerGuard on the ingress route, which keys on this tracker too, so at
     * most one extra line can appear.
     */
    warnedSharedProxyBucket = false;
    getTracker(req) {
        const trustedProxies = (0, ip_1.parseTrustedProxies)(process.env.TRUSTED_PROXIES);
        // An X-Forwarded-For header with an empty TRUSTED_PROXIES is the silent self-DoS this guard
        // exists to prevent: every client collapses onto the proxy's socket address, so all traffic
        // shares ONE bucket per tier and one abuser rate-limits everyone. The header itself must stay
        // untrusted (spoofable), so the fix is operator-side: name the proxy in TRUSTED_PROXIES. Warn
        // once instead of per request; the stock-resolve fallback below is still the safe default.
        if (trustedProxies.length === 0 && !this.warnedSharedProxyBucket) {
            const headers = (req.headers ?? {});
            if (headers['x-forwarded-for'] !== undefined) {
                this.warnedSharedProxyBucket = true;
                logger.warn('X-Forwarded-For is present but TRUSTED_PROXIES is empty: every client shares one ' +
                    'rate-limit bucket keyed on the proxy address (and per-key IP allowlists see the proxy ' +
                    'too). Set TRUSTED_PROXIES to the proxy address/subnet to key limits per client.');
            }
        }
        const clientIp = (0, ip_1.resolveClientIp)(req, trustedProxies);
        return Promise.resolve((0, throttler_1.normalizeIp)(clientIp, this.ipv6SubnetPrefix));
    }
    /**
     * Honour a bare `@SkipThrottle()` as "skip every tier this guard evaluates".
     *
     * `canActivate` calls this before the tier loop, so a route exempted here costs no storage
     * round-trip for any tier and emits no rate-limit headers — which is what a scrape or a liveness
     * probe should cost. Reading the library's own default key here also covers every future bare
     * `@SkipThrottle()` rather than requiring each call site to re-list the configured tier names.
     *
     * An explicit `@SkipThrottle({ default: false })` writes `false` and is not an exemption, so the
     * strict comparison matters: only `true` skips.
     */
    shouldSkip(context) {
        const skip = this.reflector.getAllAndOverride(LIBRARY_DEFAULT_SKIP_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        return Promise.resolve(skip === true);
    }
    /**
     * Emit a plain `Retry-After` alongside the library's `Retry-After-<window>`.
     *
     * The base guard suffixes the header with the tier name (`Retry-After-short` here, and
     * `Retry-After-ingress-ip` on the ingress route, where IngressService sets `Retry-After-instance`
     * and the plain header itself). That is useful for telling an operator which bucket shed a
     * request and useless to every HTTP client, none of which look for those spellings. A shed
     * request therefore advertised a retry hint nothing could read, and a caller that retries a 429
     * only when the response carries `Retry-After` gave up instead of coming back. Written BEFORE
     * delegating, so the suffixed header and the exception are untouched.
     *
     * Known ceiling: the first blocked window wins. Tiers are evaluated in order, so the value is the
     * shortest blocked window rather than the longest. That can cost a caller one wasted retry, but it
     * never advertises a wait shorter than the window that actually answered. Reporting the maximum
     * would mean evaluating every tier before answering, which is a much larger change.
     */
    async throwThrottlingException(context, throttlerLimitDetail) {
        // The same flag the base guard gates its own header on. A per-tier `setHeaders` is not visible
        // from here; this application configures neither, so both default to true.
        if (this.commonOptions.setHeaders ?? true) {
            const { res } = this.getRequestResponse(context);
            res.header('Retry-After', String(throttlerLimitDetail.timeToBlockExpire));
        }
        await super.throwThrottlingException(context, throttlerLimitDetail);
    }
};
exports.ProxyAwareThrottlerGuard = ProxyAwareThrottlerGuard;
exports.ProxyAwareThrottlerGuard = ProxyAwareThrottlerGuard = __decorate([
    (0, common_1.Injectable)()
], ProxyAwareThrottlerGuard);
