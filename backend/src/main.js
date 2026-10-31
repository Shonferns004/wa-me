"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// The env loader MUST be the first import: it populates process.env from .env / data/.env.generated
// before any other module is evaluated, so modules that read process.env at import time (e.g. the
// webhook Worker's @Processor connection) see the configured values rather than pre-dotenv defaults.
require("./config/load-env");
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const swagger_1 = require("@nestjs/swagger");
const app_module_1 = require("./app.module");
const shutdown_service_1 = require("./common/services/shutdown.service");
const logger_service_1 = require("./common/services/logger.service");
const swagger_config_1 = require("./config/swagger.config");
const process_error_monitor_1 = require("./config/process-error-monitor");
const bootstrap_fatal_1 = require("./config/bootstrap-fatal");
const stop_signals_1 = require("./config/stop-signals");
const env_validation_1 = require("./config/env.validation");
const ssrf_guard_1 = require("./common/security/ssrf-guard");
const storage_root_1 = require("./config/storage-root");
const http_timeouts_1 = require("./config/http-timeouts");
const app_validation_1 = require("./config/app-validation");
const configure_app_1 = require("./configure-app");
const bootstrap_security_1 = require("./config/bootstrap-security");
const bull_board_auth_middleware_1 = require("./common/security/bull-board-auth.middleware");
const ip_1 = require("./common/utils/ip");
const auth_service_1 = require("./modules/auth/auth.service");
const audit_service_1 = require("./modules/audit/audit.service");
const redis_io_adapter_1 = require("./modules/events/redis-io.adapter");
const docker_service_1 = require("./modules/docker/docker.service");
// The created app, exposed at module scope so the fatal handler below can run a best-effort teardown
// (engine sessions, Redis/pg) when bootstrap fails AFTER NestFactory.create succeeded — notably a
// listen() bind failure (EADDRINUSE), where full init already ran.
let appInstance;
async function bootstrap() {
    // The env loader already applied LOG_LEVEL to its own lines once the env files were merged; applying
    // it again here is a no-op that keeps the rule visible. Unset means INFO. A misspelling is skipped;
    // validateEnv below rejects it before the boot has any side effect.
    (0, logger_service_1.applyLogLevelFromEnv)();
    // Backstop for promise rejections that escaped a local handler (e.g. a fire-and-forget engine-event
    // dispatch), including the expected engine-teardown case it downgrades to a warning (see the helper).
    const bootstrapLogger = (0, logger_service_1.createLogger)('Bootstrap');
    (0, process_error_monitor_1.registerUnhandledRejectionHandler)(bootstrapLogger);
    // A synchronous throw from a non-promise context (e.g. a sync timer callback) is fatal — Node prints a
    // raw stack to stderr, bypassing the structured log pipeline, and exits(1). Route the stack through the
    // logger WITHOUT swallowing the exception, so the crash-and-restart posture is unchanged (see the helper).
    (0, process_error_monitor_1.registerUncaughtExceptionMonitor)(bootstrapLogger);
    // Validate the environment before anything acts on it. ConfigModule.forRoot runs the same check, but
    // only once NestFactory.create awaits it, which is after the storage root is created and a built-in
    // PostgreSQL container is started; an invalid config would do both and then be reported twice.
    (0, env_validation_1.validateEnv)(process.env);
    // Reported, not refused: with S3 selected and an endpoint the client cannot use, the instance runs today on its
    // local fallback directory, so an upgrade must not turn that into a crash loop. The Infrastructure save refuses it.
    const s3EndpointProblem = (0, env_validation_1.s3EndpointError)(process.env);
    if (s3EndpointProblem) {
        bootstrapLogger.error(`${s3EndpointProblem}. Until then S3 is unavailable and media is written to the local directory.`);
    }
    // Reported at boot, where the operator reads the log, rather than at the first outbound request.
    (0, ssrf_guard_1.warnUnusableAllowedHosts)();
    // Advisory (not enforced): an unset/blank NODE_ENV is the deliberate local-dev default, but it
    // silently degrades four controls to their dev posture (the default-secret guard, wildcard CORS,
    // Swagger UI, validation error detail) — warn so a production deployment that simply forgot the
    // variable can tell. The defaults themselves stay unchanged.
    if ((0, bootstrap_security_1.isNodeEnvUnset)(process.env.NODE_ENV)) {
        bootstrapLogger.warn('NODE_ENV is not set: running with development defaults — the default-secret guard is skipped, ' +
            'wildcard CORS is allowed, Swagger UI is served, and validation error detail is exposed. ' +
            'Set NODE_ENV=production for a production deployment.');
    }
    // Fail fast: never start production with default/placeholder secrets.
    (0, bootstrap_security_1.assertNoDefaultSecretsInProduction)({
        nodeEnv: process.env.NODE_ENV,
        databaseType: process.env.DATABASE_TYPE,
        databasePassword: process.env.DATABASE_PASSWORD,
        postgresBuiltIn: process.env.POSTGRES_BUILTIN,
        databaseHost: process.env.DATABASE_HOST,
        storageType: process.env.STORAGE_TYPE,
        minioBuiltIn: process.env.MINIO_BUILTIN,
        s3Endpoint: process.env.S3_ENDPOINT,
        // Mirror storage.service's canonical-with-legacy fallback so the guard inspects the var the app
        // actually uses (it reads S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY first).
        s3AccessKey: process.env.S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY,
        s3SecretKey: process.env.S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_KEY,
        apiMasterKey: process.env.API_MASTER_KEY,
        allowDevApiKey: process.env.ALLOW_DEV_API_KEY,
        redisPassword: process.env.REDIS_PASSWORD,
        metricsToken: process.env.METRICS_TOKEN,
    });
    // Advisory (not enforced): without API_KEY_PEPPER, stored API-key hashes use plain SHA-256. Enabling
    // a pepper on an install with keys locks every key out (see api-key-hash.ts), so we only nudge the operator.
    if ((0, bootstrap_security_1.isApiKeyPepperMissingInProduction)(process.env.NODE_ENV, process.env.API_KEY_PEPPER)) {
        bootstrapLogger.warn('API_KEY_PEPPER is not set in production: stored API-key hashes use plain SHA-256. ' +
            'Set API_KEY_PEPPER before the first boot to enable HMAC hashing; on an install with keys it locks out ' +
            'every key until the previous pepper is restored, or api_keys is cleared and the instance restarted to ' +
            'seed a new admin key.');
    }
    // Advisory (not enforced): the main DB normally runs its migration chain; synchronize is an opt-in.
    if ((0, bootstrap_security_1.isMainDbSynchronizeInProduction)(process.env.NODE_ENV, process.env.MAIN_DATABASE_SYNCHRONIZE)) {
        bootstrapLogger.warn('MAIN_DATABASE_SYNCHRONIZE=true in production: after its migrations the auth/audit schema is also ' +
            "synchronized to this release's entities, and those changes are not recorded in the migration ledger. " +
            'Unset it to use the main migrations alone.');
    }
    // Advisory (not enforced): a TRUSTED_PROXIES entry that is not an IP or CIDR never matches, so the
    // proxy it meant to name is treated as a client. Failing the boot would break configs that run today.
    const badTrustedProxies = (0, ip_1.invalidTrustedProxies)(process.env.TRUSTED_PROXIES);
    if (badTrustedProxies.length > 0) {
        bootstrapLogger.warn(`TRUSTED_PROXIES entries that are not an IP address or CIDR range are ignored: ${badTrustedProxies.join(', ')}`);
    }
    // Advisory: an origin copied from the address bar carries a path or a trailing slash that a browser never
    // sends in `Origin`. It is used without them, which is what the operator meant.
    const rewrittenOrigins = (0, bootstrap_security_1.rewrittenCorsOrigins)(process.env.CORS_ORIGINS);
    if (rewrittenOrigins.length > 0) {
        bootstrapLogger.warn(`CORS_ORIGINS entries are used as an origin, without their path or trailing slash: ${rewrittenOrigins.join(', ')}`);
    }
    // Fail fast on a media storage root the app cannot write to, BEFORE Nest builds the module graph:
    // StorageService only checks that the root EXISTS, so a root owned by another user passes boot and
    // fails later on the first media write instead (#1065). Runs ahead of NestFactory.create so
    // configuration.ts reads the resolved value.
    process.env.STORAGE_LOCAL_PATH = (0, storage_root_1.resolveStorageRoot)({
        configured: process.env.STORAGE_LOCAL_PATH,
        logger: bootstrapLogger,
    });
    // The data connection dials PostgreSQL inside NestFactory.create, so a stopped built-in container
    // must be started before it, not from DockerService.onModuleInit (see the helper).
    await (0, docker_service_1.prestartBuiltinDatabase)();
    // Disable Nest's default body parser so we can set an explicit size cap below. Framework lines
    // (route mapping, unhandled-exception stacks) go through the app logger so LOG_LEVEL, LOG_FORMAT and
    // the request id apply to them too.
    // forceCloseConnections: the HTTP close runs after every destroy hook, and a request still in flight
    // would hold it until the force-exit; destroying the open sockets there keeps it at 0 s in the
    // shutdown budget (shutdown-budget.ts). It also cuts in-flight requests and WebSocket clients at that
    // point (the socket.io server is not closed first), after the destroy hooks have run.
    const app = await core_1.NestFactory.create(app_module_1.AppModule, {
        bodyParser: false,
        logger: (0, logger_service_1.createLogger)('Nest'),
        forceCloseConnections: true,
    });
    appInstance = app;
    // Cross-replica WebSocket fan-out: when Redis is enabled, broadcasts reach clients on every
    // replica, not just this process. Set before the gateway's namespace is created so it inherits
    // the adapter. Inert (plain in-memory adapter) without REDIS_ENABLED, so single-node pays nothing.
    app.useWebSocketAdapter(new redis_io_adapter_1.RedisIoAdapter(app));
    // The production HTTP surface: request context, the CSP nonce, helmet, the SPA document handler,
    // CORS, the encoded-NUL refusal, in-flight body budget, body parsers and the trailing-slash DELETE
    // refusal. Extracted so the e2e lane runs the SAME stack instead of a copy of it (src/configure-app.ts).
    const { bodyLimit, inflightBudgetBytes } = (0, configure_app_1.configureApp)(app);
    bootstrapLogger.log(`Request body caps: ${bodyLimit} per request, ${inflightBudgetBytes} bytes aggregate in flight`);
    // Let Nest own every shutdown signal EXCEPT SIGTERM/SIGINT — those we route through the bounded
    // drain below, so a load balancer / orchestrator observes readiness=503 and stops routing BEFORE
    // teardown begins. (enableShutdownHooks with an EMPTY array registers ALL signals; this filtered
    // list is non-empty, so the exclusion is honoured.)
    app.enableShutdownHooks(Object.values(common_1.ShutdownSignal).filter(s => s !== common_1.ShutdownSignal.SIGTERM && s !== common_1.ShutdownSignal.SIGINT));
    // Wire up graceful shutdown service
    const shutdownService = app.get(shutdown_service_1.ShutdownService);
    shutdownService.setShutdownCallback(async () => {
        await app.close();
    });
    // On SIGTERM/SIGINT: drain gracefully. shutdown() flips readiness to 503 immediately (the LB stops
    // routing), keeps serving in-flight requests for a bounded grace, then runs app.close() (the SAME
    // Nest lifecycle hooks Nest's own handler would run) and exits deterministically. A repeat signal
    // one second or more after the first forces an immediate exit (130); a repeat inside that second is
    // the same stop request delivered twice, which npm and the Nest CLI do. See stop-signals.ts.
    (0, stop_signals_1.installStopSignalHandlers)({ shutdown: () => shutdownService.shutdown() });
    // Shared production/e2e prefix and DTO validation contract.
    (0, app_validation_1.applyGlobalValidation)(app);
    // Swagger documentation. ENABLE_SWAGGER wins; otherwise default on outside production, off in
    // production (the API schema is reconnaissance surface — production opts in with ENABLE_SWAGGER=true).
    const swaggerEnabled = (0, bootstrap_security_1.isSwaggerEnabled)(process.env.ENABLE_SWAGGER, process.env.NODE_ENV);
    if (swaggerEnabled) {
        const config = (0, swagger_config_1.createSwaggerConfig)();
        const document = swagger_1.SwaggerModule.createDocument(app, config);
        // Same passes, in the same order, as scripts/export-openapi.ts. The document is produced in
        // TWO places — here for the live /api/docs and there for the committed snapshot — and fixing only
        // the snapshot leaves a running gateway serving a document that fails schema validation.
        (0, swagger_config_1.dropUnexpressibleOperations)(document);
        (0, swagger_config_1.exemptPublicOperations)(document);
        (0, swagger_config_1.documentErrorResponses)(document);
        swagger_1.SwaggerModule.setup('api/docs', app, document);
    }
    // Protect the Bull Board queue UI (/api/admin/queues). It is mounted by
    // @bull-board/nestjs as raw Express middleware that the global ApiKeyGuard
    // does not cover; registering this before app.listen() ensures it runs ahead
    // of the Bull Board router. Requires a valid ADMIN API key. The middleware also
    // writes the audit trail for this mount (auth failures + queue mutations).
    const bullBoardAuth = new bull_board_auth_middleware_1.BullBoardAuthMiddleware(app.get(auth_service_1.AuthService), app.get(config_1.ConfigService), app.get(audit_service_1.AuditService));
    app.use('/api/admin/queues', (req, res, next) => {
        void bullBoardAuth.use(req, res, next);
    });
    // Apply explicit HTTP server timeouts so they are operator-tunable (REQUEST_TIMEOUT_MS /
    // HEADERS_TIMEOUT_MS / KEEPALIVE_TIMEOUT_MS) and observable at boot, instead of Node's implicit
    // defaults. Done after the adapter exists and before listen(). Target MUST be the http.Server
    // (app.getHttpServer()) — NOT getHttpAdapter().getInstance(), which is the Express APPLICATION
    // (a function with no requestTimeout/headersTimeout/keepAliveTimeout props); writing onto it is
    // inert. The timeouts only take effect on the real server.
    const appliedHttpTimeouts = (0, http_timeouts_1.applyHttpTimeouts)(app.getHttpServer(), app.get(config_1.ConfigService).get('http'));
    bootstrapLogger.log(`HTTP server timeouts applied: requestTimeout=${appliedHttpTimeouts.requestTimeoutMs}ms ` +
        `headersTimeout=${appliedHttpTimeouts.headersTimeoutMs}ms keepAliveTimeout=${appliedHttpTimeouts.keepAliveTimeoutMs}ms`);
    const port = process.env.PORT || 2785;
    await app.listen(port);
    // Advertise the configured public URL, matching the AuthService banner (auth.service.ts). A bare
    // `localhost` literal here contradicted that banner and read as "the UI is pinned to localhost",
    // sending #731 chasing BASE_URL/BIND_HOST/API_PORT instead of the real cause.
    const publicUrl = process.env.BASE_URL || `http://localhost:${port}`;
    bootstrapLogger.log(`OpenWA is running on: ${publicUrl}`);
    if (swaggerEnabled) {
        bootstrapLogger.log(`Swagger docs: ${publicUrl}/api/docs`);
    }
    // Make the dashboard-serving outcome explicit so a missing build (no UI on `/`)
    // is obvious instead of a silent 404.
    if (!app_module_1.dashboardServingEnabled) {
        bootstrapLogger.log('Dashboard: serving disabled (SERVE_DASHBOARD=false); API only');
    }
    else if (app_module_1.dashboardBuildPresent) {
        bootstrapLogger.log(`Dashboard: serving bundled UI at ${publicUrl}`);
    }
    else {
        bootstrapLogger.warn(`Dashboard: no build at ${app_module_1.DASHBOARD_DIST} - UI disabled (API still serves /api). ` +
            'Run `npm run build:all` to bundle it, or use the Vite dev server (`npm run dev`).');
    }
    // The upgrade-insecure-requests trap (#731): the browser upgrades the UI's own script fetches to
    // https and a non-TLS server can't answer them, so the dashboard renders blank with nothing in the
    // server log. We can't tell a TLS proxy from direct HTTP at boot (`trust proxy` is off), so this
    // fires for both and the text says who should ignore it.
    if ((0, bootstrap_security_1.isDashboardCspUpgradeTrapLikely)({
        nodeEnv: process.env.NODE_ENV,
        cspEnv: process.env.CSP_UPGRADE_INSECURE_REQUESTS,
        dashboardServed: app_module_1.dashboardServingEnabled && app_module_1.dashboardBuildPresent,
    })) {
        bootstrapLogger.warn('Dashboard: CSP upgrade-insecure-requests is ON (production default). If this instance is ' +
            "reached over plain HTTP, the browser will upgrade the UI's scripts to https:// and the " +
            'dashboard will render blank. Behind a TLS proxy? Ignore this. Serving direct HTTP? Set ' +
            'CSP_UPGRADE_INSECURE_REQUESTS=false.');
    }
}
// A failed bootstrap MUST terminate the process with a non-zero code, not just set `process.exitCode`:
// listen() runs the full module init (database, Redis, plugin registration) before binding the port, and
// the detached session auto-start (SessionService.onApplicationBootstrap) is already launching engines by
// then, so a bind failure (EADDRINUSE) would otherwise leave a zombie process: no HTTP port, yet still
// holding the event loop open and running WhatsApp sessions, invisible to Docker's restart policy.
// runBootstrapOrExit logs the failure, runs a bounded best-effort app.close() teardown, then exits(1); a
// successful boot returns without touching exit. Puppeteer's own `exit` handlers kill any browser
// children still up.
void (0, bootstrap_fatal_1.runBootstrapOrExit)(bootstrap, {
    logger: (0, logger_service_1.createLogger)('Bootstrap'),
    closeApp: () => (appInstance ? appInstance.close() : Promise.resolve()),
});
