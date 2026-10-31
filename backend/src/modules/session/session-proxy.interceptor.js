"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionProxyInterceptor = exports.FORWARDED_HEADER = void 0;
exports.forwardTarget = forwardTarget;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const core_1 = require("@nestjs/core");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const rxjs_1 = require("rxjs");
const session_entity_1 = require("./entities/session.entity");
const session_ownership_service_1 = require("./session-ownership.service");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const logger_service_1 = require("../../common/services/logger.service");
const ip_1 = require("../../common/utils/ip");
/**
 * The request headers a forwarded call carries over. Everything else is this hop's business.
 * content-type is not among them: forward() sends every body as JSON and labels it so itself.
 * idempotency-key travels so the OWNER claims it: the claim is part of the request's meaning, not
 * of this hop.
 */
const FORWARDED_REQUEST_HEADERS = ['x-api-key', 'authorization', 'accept', 'idempotency-key'];
/** The response headers relayed back. Deliberately short: hop-by-hop headers must not leak through. */
const RELAYED_RESPONSE_HEADERS = [
    'content-type',
    'content-disposition',
    'x-content-type-options',
    // Tells the client the owner answered from a stored Idempotency-Key response, not a new send.
    'idempotent-replayed',
    // Throttle answers come from the OWNER's counters, so the client must be told what the owner
    // said: without these a forwarded 429 arrives with no indication of when to retry.
    // ProxyAwareThrottlerGuard sets the plain Retry-After that HTTP clients read; the base throttler
    // adds the per-tier Retry-After-<name> and X-RateLimit-* headers. All of them are relayed.
    'retry-after',
    'retry-after-short',
    'retry-after-medium',
    'retry-after-long',
    'x-ratelimit-limit-short',
    'x-ratelimit-remaining-short',
    'x-ratelimit-reset-short',
    'x-ratelimit-limit-medium',
    'x-ratelimit-remaining-medium',
    'x-ratelimit-reset-medium',
    'x-ratelimit-limit-long',
    'x-ratelimit-remaining-long',
    'x-ratelimit-reset-long',
];
/**
 * Connection-stage failure codes: the owner never received the request, so nothing ran there and a
 * retry cannot repeat an action. Any other failure may come after the owner started acting on it.
 */
const NOT_DISPATCHED_CODES = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
]);
/** Marks a request as already forwarded once. Whatever happens, it is never forwarded again. */
exports.FORWARDED_HEADER = 'x-openwa-forwarded';
/**
 * The URL to forward to: ALWAYS the owner's origin (under its NODE_URL path, if it has one),
 * carrying only the request's path and query.
 *
 * The request target is caller-controlled. HTTP/1.1 allows the absolute form
 * (`GET http://elsewhere/api/sessions/x HTTP/1.1`), Express matches the route for it, and
 * `req.originalUrl` then holds that absolute URI — where `new URL(originalUrl, base)` DISCARDS the
 * base entirely. Resolving that way would let an authenticated caller aim this node's forwarder at
 * any origin they choose and receive the response, with the credentials of the call attached: a
 * server-side request forgery that also exfiltrates the API key. Rebuilding from the owner's base
 * makes the origin structurally un-influenceable rather than merely validated.
 *
 * The rebuild carries the path and query only, and it does so through the URL setters rather than
 * `new URL(path, base)`: a `pathname` that begins with `//` (or that a control character re-parses
 * into) is a network-path reference, so `new URL('//elsewhere/x', base)` would resolve its authority
 * from the path and re-open the exact origin hijack this function exists to close. Assigning
 * `target.pathname` / `target.search` on a clone of the owner's origin never reinterprets the value
 * as an authority, so the host stays the owner's for every input. Routing cannot currently deliver
 * such a target (Express does not match a session route whose path starts with `//`), but the origin
 * must be un-influenceable by construction, not by the router's normalization holding.
 */
function forwardTarget(originalUrl, ownerNodeUrl) {
    const base = new URL(ownerNodeUrl);
    const requested = new URL(originalUrl, base);
    const target = new URL(base.toString());
    // Joined, not replaced: an owner behind a path-prefixed reverse proxy is reachable only under it.
    target.pathname = base.pathname.replace(/\/$/, '') + requested.pathname;
    target.search = requested.search;
    return target.toString();
}
/**
 * Routes a session-scoped request to the node hosting the session's engine.
 *
 * The ownership lease records WHERE each session runs; this is the piece that acts on it: a request
 * landing on the wrong node — a load balancer round-robining across replicas knows nothing about
 * session placement — is forwarded to the owner's `nodeUrl` and the owner's response is relayed
 * back. Interceptor rather than middleware so it runs AFTER the API-key guard: a node only spends
 * outbound work on requests that authenticated here first (the owner authenticates them again
 * against its own key store; API keys live in each node's main SQLite file and are not shared).
 *
 * Entirely inert unless the operator configured routing: without NODE_URL on this node the
 * interceptor never even looks up the session, so single-node deployments pay nothing.
 *
 * Deliberate decisions:
 * - A LAPSED owner does not forward: the session is adoptable, and the local node handling the
 *   request (a POST /start claims it here) is the takeover semantic, not an error.
 * - A live owner WITHOUT a nodeUrl cannot be reached; the request proceeds locally and the
 *   engine-level "held by another node" conflict answers it — precise, if unrouteable.
 * - One hop only: a forwarded request is never forwarded again (FORWARDED_HEADER). The marker is
 *   client-settable, so it is verified rather than trusted: a marked request that still lands on a
 *   live non-owner — forged, or ownership moved mid-flight — is refused with a retryable 409
 *   instead of executed against a node with no engine.
 */
let SessionProxyInterceptor = class SessionProxyInterceptor {
    reflector;
    sessions;
    ownership;
    configService;
    logger = (0, logger_service_1.createLogger)('SessionProxyInterceptor');
    constructor(reflector, sessions, ownership, configService) {
        this.reflector = reflector;
        this.sessions = sessions;
        this.ownership = ownership;
        this.configService = configService;
    }
    async intercept(context, next) {
        if (context.getType() !== 'http' || !this.ownership)
            return next.handle();
        // Routing is opt-in per deployment: a node that never announced its own URL is not part of a
        // routed topology, and the per-request ownership lookup would be pure overhead.
        if (!this.ownership.nodeUrl)
            return next.handle();
        const request = context.switchToHttp().getRequest();
        const sessionId = this.sessionIdOf(context, request);
        // An import keeps any safe key as a session id, so a non-UUID id can name a routed session. `sessions.id`
        // is varchar on both dialects, so such an id is looked up like any other; only a NUL byte would make
        // PostgreSQL fail the query, and no id carries one.
        if (!sessionId || sessionId.includes('\0'))
            return next.handle();
        const owner = await this.sessions.findOne({
            where: { id: sessionId },
            select: { id: true, nodeId: true, nodeUrl: true, leaseExpiresAt: true },
        });
        if (!owner?.nodeId || owner.nodeId === this.ownership.nodeId)
            return next.handle();
        const leaseLive = owner.leaseExpiresAt != null && owner.leaseExpiresAt > new Date();
        if (!leaseLive)
            return next.handle();
        // One hop only — but never "execute anywhere": the hop marker is client-settable, so a request
        // marked forwarded that still lands on a live non-owner (forged header, or ownership moved
        // mid-flight) is refused rather than run here — a stop() on this node would write DISCONNECTED
        // while the owner's engine stays up. A retry re-routes against fresh ownership data.
        if (request.headers[exports.FORWARDED_HEADER]) {
            throw new common_1.ConflictException(`Session ${sessionId} is running on another node`);
        }
        if (!owner.nodeUrl)
            return next.handle();
        await this.forward(request, context.switchToHttp().getResponse(), owner.nodeId, owner.nodeUrl);
        // The response has been written and ended here. Emit undefined rather than completing empty:
        // Nest resolves an interceptor's observable with `lastValueFrom`, which REJECTS on an empty one
        // (EmptyError) — every successful forward then travelled the unknown-exception path and logged
        // an ERROR stack, for a request that had in fact succeeded. Emitting leaves the already-sent
        // response untouched (verified end-to-end in session-proxy.e2e-spec).
        return (0, rxjs_1.of)(undefined);
    }
    sessionIdOf(context, request) {
        const params = (request.params ?? {});
        if (params.sessionId)
            return params.sessionId;
        const sessionScoped = this.reflector.getAllAndOverride(auth_decorators_1.SESSION_SCOPED_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        return sessionScoped ? params.id : undefined;
    }
    async forward(request, response, ownerNodeId, ownerNodeUrl) {
        const timeoutMs = this.configService?.get('session.proxyTimeoutMs', 60_000) ?? 60_000;
        const hasBody = !['GET', 'HEAD'].includes(request.method);
        const headers = { [exports.FORWARDED_HEADER]: this.ownership?.nodeId ?? '1' };
        for (const name of FORWARDED_REQUEST_HEADERS) {
            const value = request.headers[name];
            if (typeof value === 'string')
                headers[name] = value;
        }
        // Label the bytes actually sent: a form-encoded request, relabelled as the client sent it, would
        // have the owner's urlencoded parser read the JSON text as one form key and answer 400.
        if (hasBody)
            headers['content-type'] = 'application/json';
        // The owner re-authenticates the forwarded call (allowedIps) and throttles per client IP, so
        // the chain must carry what this hop observed — without it every forwarded call shows up as
        // THIS node's address. Standard proxy behavior: relay the inbound chain, append the immediate
        // peer. The owner only honors the chain when this node is in its TRUSTED_PROXIES (docs/13).
        const inbound = request.headers['x-forwarded-for'];
        const inboundChain = Array.isArray(inbound) ? inbound.join(', ') : inbound;
        const observedPeer = (0, ip_1.normalizeIp)(request.socket?.remoteAddress || request.ip || '');
        if (observedPeer) {
            headers['x-forwarded-for'] = inboundChain ? `${inboundChain}, ${observedPeer}` : observedPeer;
        }
        let target;
        try {
            // Inside the try: a NODE_URL that is not a usable absolute URL makes this throw, and that is
            // an unreachable-owner condition (the 503 below names the node and the setting), not a 500
            // on a request that had nothing wrong with it. Boot validation rejects such a value too.
            target = forwardTarget(request.originalUrl, ownerNodeUrl);
            const upstream = await fetch(target, {
                method: request.method,
                headers,
                // The body has already been parsed by this hop's JSON or urlencoded body-parser; re-serialising
                // it as JSON keeps the parsed values the owner's DTOs would have seen (there are no multipart
                // session routes).
                body: hasBody ? JSON.stringify(request.body ?? {}) : undefined,
                signal: AbortSignal.timeout(timeoutMs),
                redirect: 'manual',
            });
            // Read the whole body before touching the response, so a read that fails midway leaves no
            // relayed status or headers behind on the error answer below.
            const body = Buffer.from(await upstream.arrayBuffer());
            response.status(upstream.status);
            for (const name of RELAYED_RESPONSE_HEADERS) {
                const value = upstream.headers.get(name);
                if (value)
                    response.setHeader(name, value);
            }
            response.setHeader('x-openwa-served-by', ownerNodeId);
            if (body.length > 0)
                response.send(body);
            else
                response.end();
        }
        catch (error) {
            // Duck-typed rather than `instanceof`: fetch rejects with a DOMException on timeout, and its
            // errors are not guaranteed to share this context's Error class.
            const failure = (error ?? {});
            const code = failure.cause?.code;
            // fetch reports every network failure as 'fetch failed'; the cause code (a TLS certificate
            // error, a DNS failure) is what tells the operator what went wrong.
            this.logger.warn(`Forwarding to session owner '${ownerNodeId}' failed`, {
                ownerNodeUrl,
                error: error instanceof Error ? error.message : String(error),
                cause: code,
            });
            if (target === undefined || (typeof code === 'string' && NOT_DISPATCHED_CODES.has(code))) {
                // Nothing reached the owner: 503 is the honest, retryable answer.
                response.status(503).json({
                    statusCode: 503,
                    message: `this session is hosted on node '${ownerNodeId}', which could not be reached from this node — ` +
                        'check the owner node and its NODE_URL',
                    error: 'Service Unavailable',
                });
                return;
            }
            // Anything else may have happened after the request was sent (an unlisted error such as a TLS
            // handshake failure happens before it, but cannot be told apart), so the owner may have acted
            // on it. Never 503 here: clients treat 503 as declined-before-acting and replay non-idempotent
            // sends on it.
            const timedOut = failure.name === 'TimeoutError' || failure.name === 'AbortError';
            const status = timedOut ? 504 : 502;
            response.status(status).json({
                statusCode: status,
                message: timedOut
                    ? `node '${ownerNodeId}', which hosts this session, did not answer within ${timeoutMs}ms; ` +
                        'the request may still have been carried out there'
                    : `forwarding to node '${ownerNodeId}', which hosts this session, failed, possibly after the request ` +
                        'was sent; it may have been carried out there, check the owner node and its NODE_URL',
                error: timedOut ? 'Gateway Timeout' : 'Bad Gateway',
            });
        }
    }
};
exports.SessionProxyInterceptor = SessionProxyInterceptor;
exports.SessionProxyInterceptor = SessionProxyInterceptor = __decorate([
    (0, common_1.Injectable)(),
    __param(1, (0, typeorm_1.InjectRepository)(session_entity_1.Session, 'data')),
    __param(2, (0, common_1.Optional)()),
    __param(3, (0, common_1.Optional)()),
    __metadata("design:paramtypes", [core_1.Reflector,
        typeorm_2.Repository,
        session_ownership_service_1.SessionOwnershipService,
        config_1.ConfigService])
], SessionProxyInterceptor);
