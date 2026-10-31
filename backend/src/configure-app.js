"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.configureApp = configureApp;
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const helmet_1 = __importDefault(require("helmet"));
const express_1 = require("express");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const path_1 = require("path");
const app_module_1 = require("./app.module");
const inflight_body_budget_1 = require("./config/inflight-body-budget");
const active_key_index_1 = require("./modules/auth/active-key-index");
const request_context_middleware_1 = require("./common/middleware/request-context.middleware");
const logger_service_1 = require("./common/services/logger.service");
const shutdown_service_1 = require("./common/services/shutdown.service");
const dashboard_csp_1 = require("./config/dashboard-csp");
const bootstrap_security_1 = require("./config/bootstrap-security");
const http_timeouts_1 = require("./config/http-timeouts");
const ip_1 = require("./common/utils/ip");
const body_nesting_1 = require("./common/validation/body-nesting");
/**
 * Everything the production HTTP surface installs on the Express app: request context, the CSP
 * nonce, helmet, the SPA document handler, CORS, the encoded-NUL refusal, the in-flight body budget,
 * the body parsers, the nesting-depth refusal and the trailing-slash DELETE refusal.
 *
 * It lives here rather than inside bootstrap() so the e2e lane can run the SAME stack. main.ts
 * boots on import, so a suite cannot import it; the whole stack was therefore executed by nothing,
 * and the one suite that needed the document handler carried its own copy of it.
 *
 * ORDER IS LOAD-BEARING. The budget must precede the parsers (a refused connection must not buffer
 * a byte), and the nonce must precede helmet (the CSP directive reads res.locals.cspNonce). Request
 * context, helmet and CORS must precede both: the budget answers its 503/415 itself and a parser
 * error skips every later non-error middleware, so a rejection registered ahead of them reaches a
 * cross-origin browser as an opaque network error, without the request id.
 */
function configureApp(app, options = {}) {
    const dashboard = options.dashboard ?? {
        distDir: app_module_1.DASHBOARD_DIST,
        enabled: app_module_1.dashboardServingEnabled && app_module_1.dashboardBuildPresent,
    };
    // Assign a request id to every inbound request (X-Request-ID), echo it on the response, and run
    // the whole downstream chain inside its scope so every log line + audit row carries it.
    app.use(request_context_middleware_1.requestContextMiddleware);
    // Give every response a CSP nonce. A bundled dashboard document receives its own value in a meta
    // element below; plugin config UIs copy it only onto inline scripts in their opaque sandboxed iframe.
    app.use((req, res, next) => {
        res.locals.cspNonce = (0, crypto_1.randomBytes)(18).toString('base64url');
        next();
    });
    // Enhanced Security Headers
    app.use((0, helmet_1.default)({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                // The dashboard bundles its fonts, so no third-party style or font origin is allowed. The Bull Board
                // UI (/api/admin/queues) links IBM Plex from Google Fonts; that stylesheet is blocked and it falls
                // back to system fonts.
                styleSrc: ["'self'", "'unsafe-inline'"],
                scriptSrc: ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
                // `blob:` is needed for the outgoing image-attachment preview, which the dashboard renders
                // from a URL.createObjectURL(file) blob before the message is sent (Chats.tsx).
                imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
                // Chat media (voice notes, video) is served to the dashboard as data: URIs. Without an
                // explicit media-src, <audio>/<video> fall back to default-src 'self' and are blocked.
                // Mirror imgSrc so audio/video render the same way images already do.
                mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                // Auto-upgrade HTTP→HTTPS in production, unless CSP_UPGRADE_INSECURE_REQUESTS opts out for an
                // HTTP-only private-network deployment (otherwise the browser forces the dashboard to https). (#611)
                upgradeInsecureRequests: (0, bootstrap_security_1.isUpgradeInsecureRequestsEnabled)(process.env.CSP_UPGRADE_INSECURE_REQUESTS, process.env.NODE_ENV)
                    ? []
                    : null,
            },
        },
        hsts: {
            maxAge: 31536000,
            includeSubDomains: true,
            preload: true,
        },
        noSniff: true,
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        // Disable for API usage
        crossOriginResourcePolicy: { policy: 'cross-origin' },
    }));
    // Serve SPA documents dynamically so the nonce embedded in this exact document matches its CSP
    // response header. A shared cookie is deliberately avoided: a second dashboard tab could overwrite
    // it and make the first tab's srcdoc scripts fail CSP. Assets and Nest-owned routes fall through.
    if (dashboard.enabled && (0, fs_1.existsSync)((0, path_1.join)(dashboard.distDir, 'index.html'))) {
        const dashboardIndex = (0, fs_1.readFileSync)((0, path_1.join)(dashboard.distDir, 'index.html'), 'utf8');
        app.use((req, res, next) => {
            // Lowercased because routing matches these prefixes case-insensitively.
            const path = req.path.toLowerCase();
            const excluded = path.startsWith('/api/') ||
                path === '/api' ||
                path.startsWith('/socket.io/') ||
                path === '/socket.io' ||
                path.startsWith('/mcp/') ||
                path === '/mcp' ||
                path.startsWith('/assets/');
            const documentRequest = req.method === 'GET' &&
                !excluded &&
                ((req.headers.accept ?? '').includes('text/html') || (0, path_1.extname)(req.path) === '');
            if (!documentRequest)
                return next();
            res.setHeader('Cache-Control', 'no-store');
            res.type('html').send((0, dashboard_csp_1.injectDashboardCspNonce)(dashboardIndex, res.locals.cspNonce));
        });
    }
    // CORS Configuration (#221 hardening)
    const corsPolicy = (0, bootstrap_security_1.resolveCorsPolicy)(process.env.CORS_ORIGINS, process.env.NODE_ENV);
    if (process.env.NODE_ENV === 'production' && corsPolicy.origins.length === 0 && !corsPolicy.allowAnyOrigin) {
        (0, logger_service_1.createLogger)('Bootstrap').warn('No explicit CORS_ORIGINS in production (wildcard "*" is refused): cross-origin browser ' +
            'requests will be blocked. Set CORS_ORIGINS to your dashboard origin(s).');
    }
    app.enableCors({
        origin: (origin, callback) => {
            // Allow requests with no origin (mobile apps, Postman, server-to-server)
            if (!origin)
                return callback(null, true);
            if (corsPolicy.allowAnyOrigin || corsPolicy.origins.includes(origin)) {
                callback(null, true);
            }
            else {
                // Deny WITHOUT throwing. Throwing here surfaced as a 500 Internal Server Error (#250).
                // Returning false simply omits the CORS headers: the browser blocks a true cross-origin
                // request itself (correct), while same-origin requests — e.g. the bundled dashboard served
                // through the proxy, which the browser never subjects to CORS — keep working. A genuine
                // cross-origin dashboard still needs its origin in CORS_ORIGINS.
                callback(null, false);
            }
        },
        credentials: corsPolicy.credentials,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
        // Idempotency-Key is the opt-in retry guard on the send routes (SendIdempotencyInterceptor).
        allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Request-ID', 'Idempotency-Key'],
        // The throttlers are named (short/medium/long, plus ingress-ip on ingress), so @nestjs/throttler
        // suffixes every rate-limit header with the throttler name; IngressService emits the per-instance
        // bucket's headers under the same `-instance` suffix. Expose the suffixed names so browser clients
        // can actually read them, plus the plain `Retry-After` (added by the guard, or by IngressService
        // for the instance bucket), which is not CORS-safelisted either.
        exposedHeaders: [
            'X-RateLimit-Limit-short',
            'X-RateLimit-Remaining-short',
            'X-RateLimit-Reset-short',
            'X-RateLimit-Limit-medium',
            'X-RateLimit-Remaining-medium',
            'X-RateLimit-Reset-medium',
            'X-RateLimit-Limit-long',
            'X-RateLimit-Remaining-long',
            'X-RateLimit-Reset-long',
            'X-RateLimit-Limit-instance',
            'X-RateLimit-Remaining-instance',
            'X-RateLimit-Reset-instance',
            'X-RateLimit-Limit-ingress-ip',
            'X-RateLimit-Remaining-ingress-ip',
            'X-RateLimit-Reset-ingress-ip',
            'Retry-After',
            'Retry-After-short',
            'Retry-After-medium',
            'Retry-After-long',
            'Retry-After-instance',
            'Retry-After-ingress-ip',
            // Marks a send answered from a stored Idempotency-Key response rather than sent again.
            'Idempotent-Replayed',
        ],
        maxAge: 86400, // 24 hours
    });
    // Express decodes %00 in a path parameter or the query to U+0000, which PostgreSQL rejects in every text
    // parameter, so the lookup behind the route failed with 500 (on the public ingress route too, which
    // resolves its instance before anything else). No route takes one. After CORS, so a browser can read it.
    app.use((req, res, next) => {
        if (!req.originalUrl.includes('%00'))
            return next();
        res.status(400).json({ statusCode: 400, message: 'URL must not contain an encoded NUL', error: 'Bad Request' });
    });
    // Providers some test modules lack. Looked up through ModuleRef: a failed app.get() aborts the
    // process instead of throwing.
    const optional = (token) => {
        try {
            return app.get(core_1.ModuleRef).get(token, { strict: false });
        }
        catch {
            return undefined;
        }
    };
    // Once the shutdown grace has elapsed, teardown runs every destroy hook before the listener
    // closes, and a request admitted then would run against services being torn down. Refuse new
    // requests from that point; admitted ones run until teardown ends and are then cut by the HTTP close
    // (forceCloseConnections in main.ts). Socket.IO answers its handshake ahead of Express, so a new
    // event-stream client is admitted until that close. The health probes stay answered so
    // readiness keeps reporting its draining state. Ahead of the budget, so no body is read.
    const shutdown = optional(shutdown_service_1.ShutdownService);
    app.use((req, res, next) => {
        if (!shutdown?.isTearingDown())
            return next();
        const path = req.path.toLowerCase();
        if (path === '/api/health' || path.startsWith('/api/health/'))
            return next();
        res.status(503).set('Connection', 'close').json({
            statusCode: 503,
            message: 'Server is shutting down',
            error: 'Service Unavailable',
        });
    });
    // Aggregate in-flight body budget (DoS hardening): once too many body bytes are being buffered
    // across ALL connections, new requests get 503 + Retry-After without their body being read.
    // This is a deliberate PRE-GUARD: the throttler/auth guards run at the Nest routing layer —
    // AFTER middleware and body buffering — so they can never stop slow-body memory pinning, and
    // this must run BEFORE the body parser so a rejected connection never buffers a byte. The
    // per-request BODY_SIZE_LIMIT below is a separate, unchanged cap on each admitted request.
    const inflightBudgetBytes = (0, inflight_body_budget_1.resolveInflightBodyBudgetBytes)(process.env.INFLIGHT_BODY_BUDGET_BYTES, process.env.BODY_SIZE_LIMIT);
    // Cap request body size (DoS hardening). Media sends carry base64 in the JSON body,
    // so the default is generous; tune with BODY_SIZE_LIMIT.
    const bodyLimit = (0, bootstrap_security_1.resolveBodyLimit)(process.env.BODY_SIZE_LIMIT);
    // Requests without a recognised API key share a pool of a quarter of the budget, never less than
    // two BODY_SIZE_LIMIT bodies (half the default budget). With no AuthModule in the app (some test
    // modules) every request is unrecognised, which is the stricter side.
    const keyIndex = optional(active_key_index_1.ActiveKeyIndex);
    app.use((0, inflight_body_budget_1.createInflightBodyBudget)(inflightBudgetBytes, {
        trustedProxies: (0, ip_1.parseTrustedProxies)(process.env.TRUSTED_PROXIES),
        classify: (req, clientIp) => keyIndex?.recognise(req.headers, clientIp),
        bodyLimitBytes: (0, inflight_body_budget_1.parseBodyLimitBytes)(bodyLimit),
        requestTimeoutMs: (0, http_timeouts_1.resolveRequestTimeoutMs)(process.env.REQUEST_TIMEOUT_MS),
    }).middleware);
    // The `verify` callback stashes the EXACT bytes json() received on req.rawBody, byte-identical to
    // what a provider signed, so the @Public ingress controller can HMAC-verify over the raw body
    // (JSON.stringify(req.body) is NOT byte-identical). Cheap for every route; non-ingress routes ignore it.
    // `inflate: false` is a backstop, not the guard: the budget middleware above already refuses a
    // compressed body with 415 before a byte is read. It sits here so a future reordering of these
    // parsers relative to that middleware cannot silently reopen the gap — an inflated body is
    // charged to the budget at its compressed size and bounded by nothing. Every other parser in the
    // process must carry the same flag for that argument to hold; the MCP route-level fallback
    // (src/modules/mcp/mcp.server.ts) does.
    //
    // The same callback reads the nesting depth off the raw UTF-8 bytes, before JSON.parse: the recursive
    // readers of a parsed body (class-transformer in the validation pipe, the send idempotency fingerprint, the
    // cluster proxy's JSON.stringify) overflow the stack a couple of thousand levels down and answered 500 with a
    // stack trace in the log. A body is refused here for the price of one pass over its bytes, ahead of the
    // parse, authentication, and every guard, interceptor and pipe. body-parser reports an error thrown from
    // `verify` as 403 unless it carries a status; this one carries 400, and Nest answers it in the usual shape.
    app.use((0, express_1.json)({
        limit: bodyLimit,
        inflate: false,
        verify: (req, _res, buf, encoding) => {
            req.rawBody = buf;
            if ((0, body_nesting_1.isUtf8Charset)(encoding)) {
                if ((0, body_nesting_1.exceedsJsonNesting)(buf))
                    throw new common_1.BadRequestException(body_nesting_1.BODY_NESTING_MESSAGE);
                req.nestingScanned = true;
            }
        },
    }));
    app.use((0, express_1.urlencoded)({
        extended: true,
        limit: bodyLimit,
        inflate: false,
        // Form-encoded webhook providers also sign the exact wire bytes. Use the same capture contract
        // as json(); other content types remain unsupported rather than installing a global catch-all.
        verify: (req, _res, buf) => {
            req.rawBody = buf;
        },
    }));
    // The raw scan above reads UTF-8 only. JSON in another UTF charset (UTF-16, even UTF-7) is decoded by the
    // parser, so its depth is walked on the parsed body here, with the same bound and the same answer. A
    // form-encoded body is walked too and costs nothing: the parser itself stops it at 32 levels and 1000 keys.
    // Every route and /mcp share the one bound, ahead of the guards, interceptors and pipes.
    app.use((req, _res, next) => {
        if (req.nestingScanned || !(0, body_nesting_1.exceedsBodyNesting)(req.body))
            return next();
        next(new common_1.BadRequestException(body_nesting_1.BODY_NESTING_MESSAGE));
    });
    // A DELETE path ending in '/' names no resource. Non-strict routing would still match it to the
    // route without the slash, so a client that normalises `<parent>/<child>/..` down to `<parent>/`
    // would delete the parent. Only DELETE under /api/ is refused: a trailing slash on other methods
    // keeps working, and /mcp handles its own DELETE. /api/ingress/ is exempt: it forwards every
    // method to a plugin route picked by its first wildcard segment and deletes nothing. The prefix
    // is compared case-insensitively because routing matches it that way. Registered after helmet
    // and CORS so the 404 carries their headers; routes mount later, at init, so it still runs
    // before routing.
    app.use((req, res, next) => {
        const path = req.path.toLowerCase();
        if (req.method === 'DELETE' &&
            path.startsWith('/api/') &&
            !path.startsWith('/api/ingress/') &&
            path.endsWith('/')) {
            res.status(404).json({ statusCode: 404, message: `Cannot DELETE ${req.path}`, error: 'Not Found' });
            return;
        }
        next();
    });
    return { bodyLimit, inflightBudgetBytes };
}
