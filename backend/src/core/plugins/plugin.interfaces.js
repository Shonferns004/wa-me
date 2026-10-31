"use strict";
/**
 * Plugin System Interfaces
 * Defines the contract for OpenWA plugins
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginCapabilityError = exports.SUPPORTED_SDK_MAJOR = exports.PluginCapabilityPermission = exports.PluginStatus = exports.PluginType = void 0;
exports.validateIngressManifest = validateIngressManifest;
exports.warnUnauthenticatedIngressRoutes = warnUnauthenticatedIngressRoutes;
exports.warnUnsignedTimestampRoutes = warnUnsignedTimestampRoutes;
// ============================================================================
// Plugin Types
// ============================================================================
var PluginType;
(function (PluginType) {
    PluginType["ENGINE"] = "engine";
    PluginType["STORAGE"] = "storage";
    PluginType["QUEUE"] = "queue";
    PluginType["AUTH"] = "auth";
    PluginType["EXTENSION"] = "extension";
})(PluginType || (exports.PluginType = PluginType = {}));
var PluginStatus;
(function (PluginStatus) {
    PluginStatus["INSTALLED"] = "installed";
    PluginStatus["ENABLED"] = "enabled";
    PluginStatus["DISABLED"] = "disabled";
    PluginStatus["ERROR"] = "error";
})(PluginStatus || (exports.PluginStatus = PluginStatus = {}));
// ============================================================================
// Plugin Capability
// ============================================================================
/**
 * Capability permissions a plugin declares in its manifest `permissions` and that the loader
 * enforces at the capability boundary. A plugin may only use a capability whose permission it
 * declares; an undeclared (or missing-permission) plugin is denied with a PluginCapabilityError.
 */
exports.PluginCapabilityPermission = {
    /** `ctx.messages.*` — send / reply on a session. */
    MESSAGES_SEND: 'messages:send',
    /** `ctx.engine.*` — read-only engine queries (group info, contacts, chats, number check). */
    ENGINE_READ: 'engine:read',
    /** `ctx.net.fetch` — SSRF-guarded outbound HTTP, scoped to the manifest `net.allow` host list. */
    NET_FETCH: 'net:fetch',
    /**
     * `ctx.storage.*` — per-plugin key/value persistence on the host disk (get / set / delete / list).
     * The per-plugin directory, the key-shape check and the byte quota already bound what a plugin can
     * reach, so this is a DECLARATION boundary rather than a containment one: without it a manifest
     * declaring no permissions at all still wrote to disk, and the operator reading that manifest had
     * no way to see it.
     */
    STORAGE_USE: 'storage:use',
    /** `ctx.registerWebhook` — claim an inbound ingress route. Loader-enforced; cannot be widened by config. */
    WEBHOOK_INGRESS: 'webhook:ingress',
    /** `ctx.conversations.send` — normalized outbound send translated to MessageService. */
    CONVERSATION_SEND: 'conversation:send',
    /**
     * `ctx.registerSearchProvider` — serve the gateway's /search queries. Under the default
     * SEARCH_PROVIDER=auto a registered provider is also made ACTIVE, superseding builtin-fts, so an
     * undeclared plugin would otherwise see every search query the gateway serves.
     */
    SEARCH_PROVIDE: 'search:provide',
};
const INGRESS_SIGNATURE_SCHEMES = [
    'hmac-sha256',
    'shared-secret',
    'standard-webhooks',
    'none',
];
/** Integration SDK major version this host supports. A plugin whose `sdkVersion` major differs is refused. */
exports.SUPPORTED_SDK_MAJOR = 1;
// ack header guards: name must be an RFC 7230 token (no spaces/separators), value must be one Node's
// setHeader accepts (HTAB, visible ASCII, space, and 0x80-0xFF; so no CR/LF and no other control
// character or anything above U+00FF). A value Node refuses throws at write time, after the delivery
// was persisted, and answers every attempt with a 500. The header source is the static manifest,
// validated once at load.
const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HTTP_HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;
// An ingress route must survive as one URL path segment. The controller matches the first decoded
// segment after the instance id, so '/' (and '\\', which a WHATWG URL parser turns into '/') splits
// it, '?' and '#' end the path, a bare '%' is a malformed escape, and a URL parser strips tab and
// newline (so control characters are refused outright). Anything else, a space or a non-ASCII letter
// included, is percent-encoded in the minted ingress URL and decoded back before the match. A lone
// UTF-16 surrogate has no UTF-8 form: encodeURIComponent throws on it and no URL decodes to it.
// eslint-disable-next-line no-control-regex
const INGRESS_ROUTE_SEGMENT = /^[^/\\?#%\x00-\x1f\x7f\p{Cs}]+$/u;
/**
 * Validates a manifest's `ingress` declarations: SDK major compatibility, the `webhook:ingress`
 * permission, route uniqueness, that each route is a single URL path segment the controller can
 * match, that a declared `toleranceSec` is a finite number > 0 (a replay window of zero or less, or
 * NaN, would make the tolerance check a no-op), that `dedupOn` is 'header' or 'body', that a
 * declared ack is a final status (200-599) with a string body and header names and values Node can
 * write, and that no route declares `signature.scheme: 'none'` unless the operator has explicitly
 * opted in via `ALLOW_UNSIGNED_INGRESS=true`. A `none`-scheme route is a fully-unauthenticated `@Public()`
 * endpoint — once an instance is provisioned, anyone who can reach the host can POST a forged
 * payload that triggers outbound WhatsApp sends. Rejecting it at load (rather than only warning)
 * keeps that surface from lighting up silently. A manifest with no `ingress` entries is a no-op.
 * Called from PluginLoaderService.loadPlugin, so a malformed declaration is rejected at load time.
 */
function validateIngressManifest(manifest, allowUnsignedIngress = false) {
    if (!manifest.ingress?.length)
        return; // no ingress declared → nothing to validate
    const declaredMajor = Number.parseInt((manifest.sdkVersion ?? '1').split('.')[0], 10);
    if (!Number.isFinite(declaredMajor) || declaredMajor !== exports.SUPPORTED_SDK_MAJOR) {
        throw new Error(`Plugin ${manifest.id}: SDK major ${manifest.sdkVersion} is not supported by this host (supports ${exports.SUPPORTED_SDK_MAJOR})`);
    }
    const perms = manifest.permissions ?? [];
    if (!perms.includes(exports.PluginCapabilityPermission.WEBHOOK_INGRESS)) {
        throw new Error(`Plugin ${manifest.id}: declares ingress routes but is missing the 'webhook:ingress' permission. ` +
            `Add "webhook:ingress" to the "permissions" array in the plugin's manifest.json.`);
    }
    const seen = new Set();
    for (const r of manifest.ingress) {
        if (!r.route || seen.has(r.route)) {
            throw new Error(`Plugin ${manifest.id}: duplicate or empty ingress route '${r.route}'`);
        }
        seen.add(r.route);
        if (typeof r.route !== 'string' || !INGRESS_ROUTE_SEGMENT.test(r.route) || r.route === '.' || r.route === '..') {
            throw new Error(`Plugin ${manifest.id}: ingress route '${String(r.route)}' must be a single URL path segment ` +
                `(no '/', '\\', '?', '#', '%', control character or lone surrogate, and not '.' or '..')`);
        }
        // The verifier treats any scheme it does not know as hmac-sha256, so a typo would load and then
        // reject every delivery as a signature mismatch, with nothing pointing back at the manifest.
        const signature = r.signature && typeof r.signature === 'object' ? r.signature : undefined;
        if (!signature?.scheme || !INGRESS_SIGNATURE_SCHEMES.includes(signature.scheme)) {
            throw new Error(`Plugin ${manifest.id}: route '${r.route}' signature.scheme must be one of ` +
                `${INGRESS_SIGNATURE_SCHEMES.join(', ')} (got '${String(signature?.scheme)}')`);
        }
        // Only hmac-sha256 reads `encoding`; the other schemes ignore it, so a stray value there still loads.
        if (signature.scheme === 'hmac-sha256' &&
            signature.encoding !== undefined &&
            signature.encoding !== 'hex' &&
            signature.encoding !== 'base64') {
            throw new Error(`Plugin ${manifest.id}: route '${r.route}' signature.encoding must be 'hex' or 'base64' ` +
                `(got '${String(signature.encoding)}')`);
        }
        if (r.signature.scheme === 'none' && !allowUnsignedIngress) {
            throw new Error(`Plugin ${manifest.id}: ingress route '${r.route}' declares signature.scheme 'none', which is an ` +
                `unauthenticated public endpoint that can trigger WhatsApp sends. Set ALLOW_UNSIGNED_INGRESS=true to ` +
                `opt in (and front the route with a network/reverse-proxy ACL).`);
        }
        // A manifest is third-party JSON, so the field is only a number by declaration. The verifier's
        // `skew > tolerance` compares against NaN for a value like "5m" or {}, which is always false, so the
        // replay window silently disappeared. A quoted number ("300") coerces correctly there and still loads.
        const tol = r.signature.toleranceSec;
        if (tol !== undefined) {
            const n = typeof tol === 'number' ? tol : typeof tol === 'string' && tol.trim() !== '' ? Number(tol) : Number.NaN;
            if (!Number.isFinite(n) || n <= 0) {
                throw new Error(`Plugin ${manifest.id}: route '${r.route}' toleranceSec must be a positive number of seconds ` +
                    `(a replay guard would be a no-op)`);
            }
        }
        if (r.dedupOn !== undefined && r.dedupOn !== 'header' && r.dedupOn !== 'body') {
            throw new Error(`Plugin ${manifest.id}: route '${r.route}' dedupOn must be 'header' or 'body' (got '${String(r.dedupOn)}')`);
        }
        if (r.response) {
            const ackStatus = r.response.ack?.status;
            // A 1xx is an informational response: Node writes it with no final response after it, so the
            // provider waits until it times out.
            if (ackStatus !== undefined && (!Number.isInteger(ackStatus) || ackStatus < 200 || ackStatus > 599)) {
                throw new Error(`Plugin ${manifest.id}: route '${r.route}' response.ack.status must be a final HTTP status (200-599)`);
            }
            const ackBody = r.response.ack?.body;
            if (ackBody !== undefined && typeof ackBody !== 'string') {
                throw new Error(`Plugin ${manifest.id}: route '${r.route}' response.ack.body must be a string`);
            }
            if (r.response.ack?.headers) {
                for (const [name, value] of Object.entries(r.response.ack.headers)) {
                    if (!HTTP_HEADER_NAME.test(name)) {
                        throw new Error(`Plugin ${manifest.id}: route '${r.route}' response.ack header name '${name}' is not a valid HTTP token`);
                    }
                    // Before the character guard: RegExp.test coerces its argument, so a number would pass it and
                    // then be dropped at render time, leaving the header silently absent from every ack.
                    if (typeof value !== 'string') {
                        throw new Error(`Plugin ${manifest.id}: route '${r.route}' response.ack header '${name}' must be a string`);
                    }
                    if (!HTTP_HEADER_VALUE.test(value)) {
                        throw new Error(`Plugin ${manifest.id}: route '${r.route}' response.ack header '${name}' has invalid characters ` +
                            `(control characters and characters above U+00FF cannot be written in a header)`);
                    }
                }
            }
        }
    }
}
/**
 * Warns about each ingress route declared with `scheme: 'none'` — a fully-unauthenticated public endpoint
 * that anyone who can reach the host can use to trigger WhatsApp sends. Such a route only loads when the
 * operator has opted in via `ALLOW_UNSIGNED_INGRESS=true` (otherwise `validateIngressManifest` rejects it);
 * this warning keeps the exposure loud at boot and on dynamic install so an operator who enabled the flag
 * for one provider is reminded to front the URL with a network/reverse-proxy ACL.
 * Called from PluginLoaderService.loadPlugin.
 */
function warnUnauthenticatedIngressRoutes(manifest, logger) {
    for (const r of manifest.ingress ?? []) {
        if (r.signature.scheme === 'none') {
            logger.warn(`Ingress route '${r.route}' of plugin '${manifest.id}' uses signature scheme 'none' — it is an ` +
                `UNAUTHENTICATED public endpoint that can trigger WhatsApp sends. Only keep this if the provider ` +
                `offers no HMAC and the URL is guarded by a network/reverse-proxy ACL.`, { pluginId: manifest.id, route: r.route, action: 'ingress_unauthenticated_route' });
        }
    }
}
/**
 * Warns about hmac-sha256 ingress routes whose declared timestamp is not actually bound into the
 * signature. Declaring `timestampHeader` makes the host enforce timestamp freshness, but freshness
 * alone does not stop a replay: if the provider's `contentTemplate` omits `{timestamp}`, the
 * timestamp is UNSIGNED, so a captured (body, signature) pair can be re-sent with a freshly-minted
 * timestamp and a new delivery id forever. Binding the timestamp (`contentTemplate` containing
 * `{timestamp}`, e.g. `{timestamp}.{rawBody}`) makes the signed bytes expire with the window. The
 * inverse declaration — a `{timestamp}` token with no `timestampHeader` — signs the empty string,
 * which is equally inert.
 *
 * It also warns about routes whose default header-keyed dedup is the only thing between a copy of a
 * delivery and a second enqueue: an hmac-sha256 route that binds no timestamp, and a shared-secret
 * route (which binds neither body nor time). The dedup header is not covered by the credential, so a
 * copy sent with a different header value is accepted as new. `dedupOn: 'body'` silences it.
 *
 * Warn-only (SDK v1 is additive within a major; a load-time rejection would break already-installed
 * manifests). Called from PluginLoaderService.loadPlugin.
 */
function warnUnsignedTimestampRoutes(manifest, logger) {
    for (const r of manifest.ingress ?? []) {
        if (r.signature.scheme === 'shared-secret' && r.dedupOn !== 'body') {
            logger.warn(`Ingress route '${r.route}' of plugin '${manifest.id}' uses scheme 'shared-secret', which binds ` +
                `neither the body nor a timestamp, and dedups on a header the secret does not cover: a copy of a ` +
                `delivery sent with a different header value is accepted as new. Prefer an hmac-sha256 scheme ` +
                `with a signed timestamp, or set dedupOn: 'body' if the provider's retries are byte-identical.`, { pluginId: manifest.id, route: r.route, action: 'ingress_replayable_route' });
            continue;
        }
        if (r.signature.scheme !== 'hmac-sha256')
            continue; // only hmac templates can bind a timestamp
        const signsTimestamp = (r.signature.contentTemplate ?? '{rawBody}').includes('{timestamp}');
        if (r.signature.timestampHeader && !signsTimestamp) {
            logger.warn(`Ingress route '${r.route}' of plugin '${manifest.id}' declares timestampHeader ` +
                `'${r.signature.timestampHeader}' but its contentTemplate does not sign it — the timestamp is ` +
                `freshness-checked but UNSIGNED, so a replayed body can mint a fresh timestamp. Include ` +
                `{timestamp} in the contentTemplate (e.g. '{timestamp}.{rawBody}') to bind it.`, { pluginId: manifest.id, route: r.route, action: 'ingress_unsigned_timestamp' });
        }
        else if (!r.signature.timestampHeader && signsTimestamp) {
            logger.warn(`Ingress route '${r.route}' of plugin '${manifest.id}' signs a {timestamp} token but declares no ` +
                `timestampHeader — the token binds the empty string and no freshness check runs. Declare the ` +
                `provider's timestamp header (and optionally toleranceSec) to activate the replay window.`, { pluginId: manifest.id, route: r.route, action: 'ingress_unsigned_timestamp' });
        }
        else if (!r.signature.timestampHeader && r.dedupOn !== 'body') {
            logger.warn(`Ingress route '${r.route}' of plugin '${manifest.id}' signs no timestamp and dedups on a header ` +
                `the signature does not cover: a copy of a delivery sent with a different header value is ` +
                `accepted as new. Declare and sign the provider's timestamp (timestampHeader plus {timestamp} ` +
                `in the contentTemplate), or set dedupOn: 'body' if the provider's retries are byte-identical.`, { pluginId: manifest.id, route: r.route, action: 'ingress_replayable_route' });
        }
    }
}
/**
 * Thrown by a plugin capability when a call is rejected (missing permission, out-of-scope session,
 * unstarted session, etc.). Gives plugins a predictable failure instead of a raw TypeError.
 */
class PluginCapabilityError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PluginCapabilityError';
    }
}
exports.PluginCapabilityError = PluginCapabilityError;
