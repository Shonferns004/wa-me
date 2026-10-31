"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IngressService = void 0;
exports.extractConversationId = extractConversationId;
exports.redactSensitiveHeaders = redactSensitiveHeaders;
const node_crypto_1 = require("node:crypto");
const throttler_1 = require("@nestjs/throttler");
const ingress_signature_1 = require("./ingress-signature");
const constantTimeEqual_1 = require("../../common/security/constantTimeEqual");
const ingress_preflight_1 = require("./ingress-preflight");
const ingress_ack_1 = require("./ingress-ack");
const inflight_body_budget_1 = require("../../config/inflight-body-budget");
const bootstrap_security_1 = require("../../config/bootstrap-security");
const logger_service_1 = require("../../common/services/logger.service");
/**
 * The fast-ack ingress pipeline. Pure orchestration over injected deps so it is unit-testable without
 * Nest DI: resolve the instance → answer a GET challenge host-side → size cap → verify over the RAW
 * body → per-instance rate bucket → dedup (persist-before-ack) → best-effort conversation id →
 * enqueue (or inline) → 202.
 */
class IngressService {
    deps;
    logger = (0, logger_service_1.createLogger)('IngressService');
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * The cap to apply when a manifest route declares none. Warned once per route so an incomplete
     * manifest is visible to the operator rather than silently degrading to the global limit.
     */
    warnedMissingCap = new Set();
    fallbackMaxBodyBytes(pluginId, route) {
        const key = `${pluginId}:${route}`;
        if (!this.warnedMissingCap.has(key)) {
            this.warnedMissingCap.add(key);
            this.logger.warn(`Ingress route ${key} declares no usable maxBodyBytes; falling back to the process body limit. ` +
                'Set a per-route maxBodyBytes in the plugin manifest.');
        }
        return (0, inflight_body_budget_1.parseBodyLimitBytes)((0, bootstrap_security_1.resolveBodyLimit)(process.env.BODY_SIZE_LIMIT));
    }
    async handle(req) {
        const instance = await this.deps.instances.resolve(req.pluginId, req.instanceId);
        if (!instance || !instance.enabled)
            return { status: 404, body: 'unknown instance' };
        const route = this.deps.manifestRoute(req.pluginId, req.route);
        if (!route)
            return { status: 404, body: 'unknown route' };
        // GET challenge handshake (e.g. Meta hub.challenge), answered host-side without the worker. The
        // token is compared against the instance's minted verifyToken.
        if (req.method === 'GET' && route.challenge) {
            const token = req.query[route.challenge.tokenParam];
            const echo = req.query[route.challenge.echoParam];
            // Constant-time compare (mirrors the signature path) so the verify token can't be probed by timing.
            if (token && instance.verifyToken && (0, constantTimeEqual_1.constantTimeEqual)(token, instance.verifyToken)) {
                return { status: 200, body: echo ?? '' };
            }
            return { status: 403, body: 'challenge failed' };
        }
        // Handled as the empty body, it would pass a scheme that signs only a header, and every such delivery
        // would hash to one dedup key: the first stored without its body, the rest acked and dropped. It
        // would also slip past the size cap below.
        if (req.unparsedBody)
            return { status: 415, body: 'unsupported ingress content type' };
        // `n > undefined` is always false, so a manifest that omits maxBodyBytes — or carries a
        // non-numeric or non-positive value — left this check inert: the 413 the published contract
        // promises never fired, and every accepted delivery is persisted with the body stored twice
        // (payload.body and payload.rawBody) and carried into the queue. A third-party adapter forgetting
        // one field turned its route into a write amplifier with no load-time error and no runtime signal.
        //
        // The fallback is the process-wide body limit, which is what such a route was already bounded by
        // in practice, so no delivery that is accepted today starts failing. What changes is that the
        // check can no longer be vacuous, and the gap is now stated in the log instead of being silent.
        // A manifest is third-party JSON with no runtime validation, so the field is only a `number` by
        // declaration. The `>` this replaced COERCED, which means a quoted number ("1024") enforced a real
        // cap — rejecting it as "unusable" would swap that for the far larger process-wide fallback. And
        // 0 is a cap, not a missing value: it admits the empty body a verification callback sends and
        // nothing else. Only a value that cannot express a limit at all falls back.
        const declaredCap = route.maxBodyBytes;
        const parsedCap = typeof declaredCap === 'number'
            ? declaredCap
            : typeof declaredCap === 'string' && declaredCap.trim() !== ''
                ? Number(declaredCap)
                : Number.NaN;
        const effectiveCap = Number.isFinite(parsedCap) && parsedCap >= 0 ? parsedCap : this.fallbackMaxBodyBytes(req.pluginId, route.route);
        if (Buffer.byteLength(req.rawBody, 'utf8') > effectiveCap)
            return { status: 413, body: 'payload too large' };
        const verdict = (0, ingress_signature_1.verifyIngressSignature)(route.signature, {
            rawBody: req.rawBody,
            headers: req.headers,
            secret: instance.secret,
            now: this.deps.now(),
            instanceId: req.instanceId,
        });
        if (!verdict.ok)
            return { status: 401, body: verdict.reason ?? 'signature verification failed' };
        // The per-instance bucket is charged here, after verification; everything above is bounded by the
        // guard's per-client-IP tier.
        // Before the preflight, so a signed provider hammering a dead session is still bounded.
        const admission = this.deps.admitInstance ? await this.deps.admitInstance(req.pluginId, req.instanceId) : undefined;
        if (admission && !admission.ok) {
            return {
                status: 429,
                // The body the global filter writes for a guard's ThrottlerException, so the wire shape is
                // the same one this route answered with before the charge moved here.
                body: JSON.stringify({ statusCode: 429, message: throttler_1.throttlerMessage }),
                headers: { 'content-type': 'application/json', ...admission.headers },
            };
        }
        // Host-side preflight (e.g. session-alive). AFTER signature verify (so an unauthenticated caller
        // cannot probe liveness) and BEFORE the dedup persist (so a 5xx-rejected delivery never writes a
        // dedup row that would swallow the provider's retry as a 200 'duplicate' — the dedup trap). A
        // rejection leaves no dedup/DLQ row, so log it for operator audit.
        // A route that declares a response contract wants its answer now, so a plugin the boot restore has not
        // reached yet is refused in the same stage. Any other route is accepted and persisted below like every
        // delivery: the queue holds its job until the plugin is up, or the reconciler dispatches the row.
        const preflight = route.response && this.deps.restorePending?.(req.pluginId)
            ? (0, ingress_preflight_1.pluginRestoringRejection)()
            : (0, ingress_preflight_1.evaluatePreflight)(route, instance.sessionScope, this.deps.sessionStatus);
        if (preflight) {
            this.deps.log?.('ingress_preflight_rejected', {
                pluginId: req.pluginId,
                instanceId: req.instanceId,
                route: req.route,
                status: preflight.status,
                reason: preflight.body,
                sessionScope: instance.sessionScope,
            });
            // Returned whole, so a rejection's headers reach the wire. Re-packing the two fields dropped the
            // Retry-After that decides whether the provider retries at all.
            return preflight;
        }
        // Standard Webhooks signs and requires webhook-id, so it is the stable, authenticated retry id.
        // Other schemes retain the existing x-delivery/body-hash behavior for compatibility.
        const defaultDedupHeader = route.signature.scheme === 'standard-webhooks' ? 'webhook-id' : 'x-delivery';
        const dedupHeader = (route.dedupHeader ?? route.signature.dedupHeader ?? defaultDedupHeader).toLowerCase();
        // A route that declares dedupOn: 'body' keys retries on the raw body: its provider mints a fresh
        // delivery id per attempt, so trusting the header would let every retry through as new.
        //
        // A header that is present but blank is no id at all, and it used to be taken as one: every
        // delivery then shared the empty key, so the dedup row admitted the first and dropped the rest
        // while answering each provider with the route's success ack. Nothing was enqueued, nothing was
        // dead-lettered, and the deliveries were simply gone. Fall through to the body hash, which is
        // exactly the "provider supplied no id" case it already exists for.
        const headerId = req.headers[dedupHeader]?.trim();
        // An id past 255 characters is no id a provider mints, and the unique index it is stored under refuses an
        // entry past about 2.7 KB on PostgreSQL with a 500, so such a header gets the body hash too.
        const deliveryId = route.dedupOn === 'body' || !headerId || headerId.length > MAX_DELIVERY_ID_LENGTH
            ? deriveDeliveryId(req)
            : headerId;
        // Provider request headers persist with the event (redrive/debugging); credentials must not.
        // Signature headers are re-derivable, auth material is not — redact before the first write.
        // A shared-secret route carries the instance secret itself in its declared header, and an hmac
        // route's declared header carries a signature that is only useful to re-send the same body.
        const payload = {
            // Every authenticating scheme has passed by here; a `none` route authenticates nothing. Recorded now
            // because a plugin update can change the scheme before a queued or replayed delivery runs.
            admission: { verified: route.signature.scheme !== 'none' },
            headers: redactSensitiveHeaders(req.headers, route.signature.scheme === 'shared-secret' || route.signature.scheme === 'hmac-sha256'
                ? route.signature.header
                : undefined),
            query: req.query,
            body: req.rawBody,
            rawBody: req.rawBody,
        };
        // Rendered BEFORE the dedup check so a provider retry gets the route's ack (same status and headers)
        // rather than a second contract on the same route. A body template renders from the retry, not the
        // first delivery, and a retry still passes the preflight above first. The ctx is the request in
        // hand (rawBody, deliveryId, now), never stored state, which is what makes rendering it on a dedup
        // hit sound: an ack field that had to reflect the PERSISTED row would echo the retry's values as the
        // original's. Keep it that way.
        const rendered = (0, ingress_ack_1.renderAck)(route.response?.ack, {
            rawBody: req.rawBody,
            timestamp: String(Math.floor(this.deps.now() / 1000)),
            id: deliveryId,
        });
        const ack = admission ? { ...rendered, headers: { ...rendered.headers, ...admission.headers } } : rendered;
        const isNew = await this.deps.events.recordOrSkip({
            instanceId: req.instanceId,
            pluginId: req.pluginId,
            providerDeliveryId: deliveryId,
            route: req.route,
            // The method rides with the row so a reconciler replay reaches the handler as this attempt does.
            payload: { ...payload, method: req.method },
            // The slim content fingerprint kept after the payload is retired on dispatch (see the entity).
            payloadHash: (0, node_crypto_1.createHash)('sha256').update(req.rawBody).digest('hex'),
            sessionId: instance.sessionScope,
        });
        if (!isNew)
            return ack; // already persisted/acked; a retry gets the route's ack, not enqueued again
        // Persisted and acked: dispatching it now would run the plugin inline where there is no worker to run it in.
        // The row stays 'pending', which is where a crash here would leave it too, and the reconciler dispatches it.
        if (this.deps.deferDispatch?.(req.pluginId))
            return ack;
        // Best-effort conversation id for P1 ordering. Never throws — a malformed body just yields undefined.
        const providerConversationId = extractConversationId(route.conversationId, req.headers, req.rawBody);
        const jobData = {
            pluginId: req.pluginId,
            instanceId: req.instanceId,
            route: req.route,
            method: req.method,
            deliveryId,
            sessionId: instance.sessionScope ?? undefined,
            providerConversationId,
            payload,
        };
        if (route.response) {
            // Sync-response route: the ack is host-side and final; enqueue (queued or inline) must NOT block
            // it — a queue-disabled deployment otherwise holds the HTTP response for up to the inline dispatch
            // timeout. enqueue() is not awaited; the dedup row already persisted is the durability handle. The
            // .catch() is a defensive guard: enqueue() never rejects without a signal (it swallows inline failures
            // and the factory wrapper writes a DLQ row on 'failed'), but a future regression must not become an unhandled
            // rejection that crashes the process on the ingress hot path.
            void this.deps.enqueue(jobData, deliveryId).catch(err => {
                this.deps.log?.('ingress_enqueue_unhandled', {
                    pluginId: req.pluginId,
                    instanceId: req.instanceId,
                    deliveryId,
                    error: err instanceof Error ? err.message : String(err),
                });
            });
        }
        else {
            await this.deps.enqueue(jobData, deliveryId);
        }
        return ack;
    }
}
exports.IngressService = IngressService;
/** The longest dedup header value taken as a delivery id, kept far below the index entry limit of PostgreSQL. */
const MAX_DELIVERY_ID_LENGTH = 255;
/**
 * Derives a DETERMINISTIC delivery id when the provider sends no dedup header, so a provider retry of
 * the same delivery dedups instead of being treated as new. A random UUID would silently disable both
 * the persist-dedup and BullMQ's jobId idempotency, causing duplicate downstream WhatsApp sends. Keyed
 * on pluginId + instanceId + route + rawBody, plus the method and query when the body is empty; never a
 * server timestamp, which would defeat dedup.
 */
function deriveDeliveryId(req) {
    const parts = [req.pluginId, req.instanceId, req.route, req.rawBody];
    // A delivery carried in the query string (a GET callback, a bodiless POST) is identified by its query: the
    // empty body alone gave every one of them the same id, so all but the first were acked and dropped. Only that
    // case adds it, so every other delivery keeps the id it had. Sorted by code point, not locale: the id is stored.
    const query = Object.entries(req.query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (req.rawBody === '' && query.length > 0)
        parts.push(req.method, JSON.stringify(query));
    return (0, node_crypto_1.createHash)('sha256').update(parts.join('\0')).digest('hex');
}
/**
 * Extracts the provider conversation id from a declared header or a JSON pointer into the body.
 * Returns undefined when no pointer is declared or extraction fails — the P1 lock then keys per
 * instance. Pure and total: never throws on a malformed body.
 */
function extractConversationId(spec, headers, rawBody) {
    if (!spec)
        return undefined;
    if (spec.header) {
        const v = headers[spec.header.toLowerCase()];
        if (v)
            return v;
    }
    if (spec.jsonPointer) {
        try {
            let node = JSON.parse(rawBody);
            // RFC 6901: an empty token is a key, `~1` and `~0` stand for `/` and `~`, and an array takes only an
            // index. A pointer written without its leading slash keeps resolving as it did.
            const path = spec.jsonPointer.startsWith('/') ? spec.jsonPointer.slice(1) : spec.jsonPointer;
            for (const token of path.split('/')) {
                if (/~(?:[^01]|$)/.test(token))
                    return undefined;
                const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
                if (node === null || typeof node !== 'object' || !Object.hasOwn(node, key))
                    return undefined;
                if (Array.isArray(node) && !/^(0|[1-9][0-9]*)$/.test(key))
                    return undefined;
                node = node[key];
            }
            // Only a scalar is a usable conversation key — an object/array would stringify to junk.
            if (typeof node === 'string')
                return node;
            if (typeof node === 'number' || typeof node === 'boolean')
                return String(node);
        }
        catch {
            return undefined; // malformed body → no key, per-instance ordering
        }
    }
    return undefined;
}
/**
 * Header names whose VALUES must never reach the persisted event payload: bearer/basic
 * credentials, cookies, and the provider signature headers (recomputable from the raw body, and
 * useless for redrive — the retry re-signs). The names survive so operators can still see WHICH
 * scheme the provider used.
 */
const SENSITIVE_INGRESS_HEADERS = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'x-hub-signature',
    'x-hub-signature-256',
    'x-signature',
    'x-signature-ed25519',
    'x-webhook-signature',
    'webhook-signature',
]);
function redactSensitiveHeaders(headers, credentialHeader) {
    const extra = credentialHeader?.toLowerCase();
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        out[name] = SENSITIVE_INGRESS_HEADERS.has(lower) || lower === extra ? '[redacted]' : value;
    }
    return out;
}
