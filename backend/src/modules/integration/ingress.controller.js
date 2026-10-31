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
exports.IngressController = void 0;
const common_1 = require("@nestjs/common");
const throttler_1 = require("@nestjs/throttler");
const swagger_1 = require("@nestjs/swagger");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const ingress_ack_1 = require("./ingress-ack");
const ingress_service_1 = require("./ingress.service");
const instance_throttler_guard_1 = require("./instance-throttler.guard");
// @Public so the global ApiKeyGuard early-returns (providers can't present an API key). The
// controller-level @SkipThrottle below exempts the GLOBAL per-IP guard (see its comment).
// The provider body is read as RAW bytes from req.rawBody (stashed by the json() verify callback in
// src/configure-app.ts) — it is intentionally NOT DTO-bound, so the global ValidationPipe never 400s on the
// provider's unknown keys, and the exact signed bytes reach the HMAC verifier.
let IngressController = class IngressController {
    ingress;
    constructor(ingress) {
        this.ingress = ingress;
    }
    // Express 5 (path-to-regexp v8) has no bare `*` — Nest's route converter rewrites it to the named
    // wildcard `*path`, so the trailing segments land in req.params.path (an array), not req.params[0].
    //
    // Two rate bounds, neither from the global per-IP guard (skipped via @SkipThrottle above, because
    // its medium tier of 100/min sits below the per-instance default of 120/min and 429'd every
    // tenant of a shared-egress-IP provider). InstanceThrottlerGuard ignores the bare @SkipThrottle
    // (see its shouldSkip) and bounds each client IP before anything else (INGRESS_IP_LIMIT). The
    // per-(pluginId, instanceId) bucket (INGRESS_INSTANCE_LIMIT) is charged by IngressService only
    // after the signature verifies. Both windows use INGRESS_INSTANCE_TTL. The limits are read from the
    // environment, NOT via @Throttle: @Throttle metadata is reflected on the route and read by every
    // ThrottlerGuard subclass that walks a tier of that name.
    async receive(pluginId, instanceId, query, req, res) {
        const wildcard = req.params.path;
        const segments = Array.isArray(wildcard)
            ? wildcard
            : typeof wildcard === 'string'
                ? wildcard.split('/').filter(Boolean)
                : [];
        const route = segments[0] ?? '';
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(',') : String(v ?? '')]));
        // Express answers a repeated query parameter with an array, so the Record<string, string> the
        // service is typed against is a promise the framework does not keep. The challenge path feeds
        // these straight into a constant-time compare, which throws on anything that is not a string, so
        // `?token=a&token=b` answered 500. Flattened here, the way the headers above already are: the
        // first value wins, as URLSearchParams.get and most providers' own clients read it. The app runs
        // Express's default 'simple' query parser, which never nests (`?a[b]=c` is the key `a[b]`), so
        // the last arm is only there to keep the mapping total if that setting ever changes.
        const flatQuery = Object.fromEntries(Object.entries(query).map(([k, v]) => [
            k,
            Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '',
        ]));
        const rawBody = req.rawBody?.toString('utf8') ?? '';
        // Only json() and urlencoded() capture req.rawBody, so a body in any other content type reaches
        // here unread; the service refuses it rather than handling it as the empty body.
        const unparsedBody = req.rawBody === undefined &&
            (Number(headers['content-length'] || 0) > 0 || headers['transfer-encoding'] !== undefined);
        const result = await this.ingress.handle({
            pluginId,
            instanceId,
            route,
            method: req.method,
            headers,
            query: flatQuery,
            rawBody,
            unparsedBody,
        });
        if (result.headers)
            res.set((0, ingress_ack_1.safeAckHeaders)(result.headers));
        // Both reflections echo provider-controlled strings (hub.challenge, the ack template). Express
        // types a bare send() as text/html, which turns a reflection into XSS material on this origin, so
        // only a non-executable declared type survives and everything else is forced to text/plain. It
        // reads the UNFILTERED headers on purpose: safeAckHeaders fences content-type precisely because
        // this is the one place allowed to decide it.
        res.type((0, ingress_ack_1.ackContentType)(result.headers));
        res.status(result.status).send(result.body ?? '');
    }
};
exports.IngressController = IngressController;
__decorate([
    (0, common_1.UseGuards)(instance_throttler_guard_1.InstanceThrottlerGuard),
    (0, common_1.All)(':pluginId/:instanceId/*path')
    // The wildcard segment is part of the published path template, so it needs a parameter of its own —
    // the handler reads it off the request rather than binding it, which leaves the document with a
    // `{path}` placeholder nothing declares. Awkward to express, not impossible.
    ,
    (0, swagger_1.ApiParam)({
        name: 'path',
        type: String,
        description: 'The plugin-declared route: a single path segment. ' +
            'Only the first segment selects the route; any further segments are ignored.',
        example: 'chatwoot',
    }),
    (0, swagger_1.ApiOkResponse)({
        description: 'GET verification challenge echo, or a route whose declared ack sets 200. ' +
            'Not the primary success path; see 202. ' +
            "A re-delivery that reaches the dedup check is answered with the route's ack " +
            '(same status and headers as the first delivery), so it is not distinguishable by status.',
    }),
    (0, swagger_1.ApiResponse)({
        status: 202,
        description: 'Webhook accepted (the primary success path). With the queue on it is queued for async plugin processing. ' +
            'With the queue off a route without a response contract answers after the plugin ran inline (at most ' +
            'INGRESS_DISPATCH_TIMEOUT_MS), and a route with one answers first and dispatches inline after.',
    }),
    (0, swagger_1.ApiResponse)({
        status: 400,
        description: 'The path or query contains an encoded NUL (`%00`), or a JSON body does not parse.',
    }),
    (0, swagger_1.ApiResponse)({ status: 401, description: 'Signature verification failed (missing, stale, or wrong secret).' }),
    (0, swagger_1.ApiResponse)({ status: 403, description: 'GET verification challenge failed (verifyToken mismatch).' }),
    (0, swagger_1.ApiResponse)({ status: 404, description: 'Unknown pluginId/instanceId, or no route claimed by the plugin.' }),
    (0, swagger_1.ApiResponse)({ status: 413, description: 'Request body exceeds the route maxBodyBytes limit.' }),
    (0, swagger_1.ApiResponse)({
        status: 415,
        description: 'Request body is not `application/json` or `application/x-www-form-urlencoded`.',
    }),
    (0, swagger_1.ApiResponse)({
        status: 429,
        description: 'Rate limit exceeded: the per-instance bucket (INGRESS_INSTANCE_LIMIT) or the per-client-IP bucket (INGRESS_IP_LIMIT). The `Retry-After-instance` / `Retry-After-ingress-ip` header names which one shed the request, and a plain `Retry-After` carries the same delay for a client that reads only the standard name.',
    }),
    (0, swagger_1.ApiResponse)({
        status: 503,
        description: "A route that declares a response contract, while its plugin is still being restored after startup or when its `session-alive` preflight finds the bound session with no running engine or a failed one (a starting, reconnecting or QR-pending session is answered with the route's ack). The delivery is not persisted, so the provider's retry is treated as a new one; `Retry-After` carries the delay. A route without a response contract is accepted while its plugin restores.",
    }),
    __param(0, (0, common_1.Param)('pluginId')),
    __param(1, (0, common_1.Param)('instanceId')),
    __param(2, (0, common_1.Query)()),
    __param(3, (0, common_1.Req)()),
    __param(4, (0, common_1.Res)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String, Object, Object, Object]),
    __metadata("design:returntype", Promise)
], IngressController.prototype, "receive", null);
exports.IngressController = IngressController = __decorate([
    (0, swagger_1.ApiTags)('integration'),
    (0, auth_decorators_1.Public)()
    // The global per-IP throttle SKIPS this route (its medium tier, 100/min by default, sits below the
    // per-instance limit's 120/min, so a provider delivering every tenant's webhooks from one shared
    // egress IP was 429'd at the IP tier before the instance bound ever fired). InstanceThrottlerGuard
    // bounds each client instead, and IngressService charges a per-(pluginId, instanceId) bucket once a
    // delivery's signature verifies. The client tier counts every request, including one the instance
    // bucket then sheds, so a tenant pushing one shared IP past INGRESS_IP_LIMIT sheds its neighbours too.
    ,
    (0, throttler_1.SkipThrottle)(),
    (0, common_1.Controller)('ingress'),
    __metadata("design:paramtypes", [ingress_service_1.IngressService])
], IngressController);
