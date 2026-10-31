"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSupportedProxyUrl = isSupportedProxyUrl;
exports.buildProxyLaunchConfig = buildProxyLaunchConfig;
/**
 * Whether a per-session proxy URL parses to a supported scheme — defense-in-depth for a stored proxy
 * that bypassed DTO validation (e.g. loaded from the DB on restart). The host is NOT SSRF-blocked: a
 * per-session proxy is operator-chosen egress, and a loopback proxy sidecar is a legitimate setup.
 */
function isSupportedProxyUrl(url) {
    try {
        return ['http:', 'https:', 'socks4:', 'socks5:'].includes(new URL(url).protocol);
    }
    catch {
        return false;
    }
}
/**
 * Split a proxy URL into a credential-less `--proxy-server` value plus, for an HTTP/HTTPS proxy, the
 * username/password to hand to whatsapp-web.js's `proxyAuthentication` (which calls `page.authenticate`
 * — the only way Chromium authenticates a proxy). Credentials embedded in `--proxy-server` are ignored
 * by Chromium, and SOCKS proxies cannot be authenticated at all, so SOCKS credentials are surfaced via
 * `socksAuthUnsupported` for the caller to warn about instead of failing with an opaque nav timeout (#628).
 * Call only with a URL that already passed {@link isSupportedProxyUrl}.
 */
function buildProxyLaunchConfig(url) {
    const parsed = new URL(url);
    const serverArg = `${parsed.protocol}//${parsed.host}`;
    let username;
    let password;
    try {
        username = decodeURIComponent(parsed.username);
        password = decodeURIComponent(parsed.password);
    }
    catch {
        // A lone `%` in a stored URL that bypassed DTO validation; the bare `URI malformed` names nothing.
        throw new Error('The session proxy URL has malformed percent-encoded credentials');
    }
    const hasCredentials = username !== '' || password !== '';
    const isSocks = parsed.protocol === 'socks4:' || parsed.protocol === 'socks5:';
    if (hasCredentials && !isSocks) {
        return { serverArg, proxyAuthentication: { username, password }, socksAuthUnsupported: false };
    }
    return { serverArg, socksAuthUnsupported: hasCredentials && isSocks };
}
