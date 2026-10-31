"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = exports.DASHBOARD_STATIC_OPTIONS = exports.dashboardBuildPresent = exports.dashboardServingEnabled = exports.DASHBOARD_DIST = void 0;
const common_1 = require("@nestjs/common");
const serve_static_1 = require("@nestjs/serve-static");
const config_1 = require("@nestjs/config");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const typeorm_1 = require("@nestjs/typeorm");
const throttler_1 = require("@nestjs/throttler");
const redis_throttler_storage_1 = require("./common/throttler/redis-throttler.storage");
const throttler_redis_client_1 = require("./common/throttler/throttler-redis.client");
const configuration_1 = __importDefault(require("./config/configuration"));
const env_validation_1 = require("./config/env.validation");
const pg_boot_migrations_1 = require("./database/pg-boot-migrations");
const main_connection_1 = require("./database/main-connection");
const session_module_1 = require("./modules/session/session.module");
const message_module_1 = require("./modules/message/message.module");
const template_module_1 = require("./modules/template/template.module");
const webhook_module_1 = require("./modules/webhook/webhook.module");
const health_module_1 = require("./modules/health/health.module");
const auth_module_1 = require("./modules/auth/auth.module");
const audit_module_1 = require("./modules/audit/audit.module");
const engine_module_1 = require("./engine/engine.module");
const logger_module_1 = require("./common/services/logger.module");
const settings_module_1 = require("./modules/settings/settings.module");
const infra_module_1 = require("./modules/infra/infra.module");
const events_module_1 = require("./modules/events/events.module");
const contact_module_1 = require("./modules/contact/contact.module");
const group_module_1 = require("./modules/group/group.module");
const profile_module_1 = require("./modules/profile/profile.module");
const call_module_1 = require("./modules/call/call.module");
const label_module_1 = require("./modules/label/label.module");
const channel_module_1 = require("./modules/channel/channel.module");
const cache_1 = require("./common/cache");
const storage_module_1 = require("./common/storage/storage.module");
const stats_module_1 = require("./modules/stats/stats.module");
const metrics_module_1 = require("./modules/metrics/metrics.module");
const status_module_1 = require("./modules/status/status.module");
const media_module_1 = require("./modules/media/media.module");
const status_store_module_1 = require("./modules/status-store/status-store.module");
const chat_media_module_1 = require("./modules/chat-media/chat-media.module");
const automation_module_1 = require("./modules/automation/automation.module");
const takeover_module_1 = require("./modules/takeover/takeover.module");
const catalog_module_1 = require("./modules/catalog/catalog.module");
const hooks_1 = require("./core/hooks");
const plugins_1 = require("./core/plugins");
const plugins_module_1 = require("./modules/plugins/plugins.module");
const agent_tools_module_1 = require("./core/agent-tools/agent-tools.module");
const integration_module_1 = require("./modules/integration/integration.module");
const search_module_1 = require("./modules/search/search.module");
const sqlite_file_permissions_1 = require("./database/sqlite-file-permissions");
// Only import QueueModule if explicitly enabled to avoid Redis connection errors
const queueModules = [];
if (process.env.QUEUE_ENABLED === 'true') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const queueModule = require('./modules/queue/queue.module');
    queueModules.push(queueModule.QueueModule);
}
// Global message search. Opt-out via SEARCH_ENABLED=false: the module (route + provider + registry)
// is absent entirely — zero footprint, no DI wiring. Mirrors the queueModules/MCP conditional shape so
// an opt-out deployment never even loads the search providers. Default is ON for zero-config first boot.
const searchModules = [];
if (process.env.SEARCH_ENABLED !== 'false') {
    searchModules.push(search_module_1.SearchModule);
}
// Only mount the MCP server if explicitly enabled to avoid startup cost and
// the SDK import (which pulls in @modelcontextprotocol/sdk) in non-MCP deployments.
const mcpModules = [];
if (process.env.MCP_ENABLED === 'true') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { McpModule } = require('./modules/mcp/mcp.module');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { version } = require('../package.json');
    mcpModules.push(McpModule.forRoot({
        basePath: '/mcp',
        serverInfo: { name: 'openwa', version },
    }));
}
// Serve the bundled dashboard SPA from this same NestJS process/port when a build is
// present (the production image copies dashboard/dist in). In local dev the build is
// absent, so this stays inert and the Vite dev server (:2886) handles the UI. Opt out
// explicitly with SERVE_DASHBOARD=false. The path + flags are exported so main.ts can
// log a clear status line (served / disabled / build missing) at startup.
exports.DASHBOARD_DIST = path.resolve(__dirname, '..', 'dashboard', 'dist');
exports.dashboardServingEnabled = process.env.SERVE_DASHBOARD !== 'false';
exports.dashboardBuildPresent = fs.existsSync(path.join(exports.DASHBOARD_DIST, 'index.html'));
// Everything but the root, exported so the e2e suite boots these options and not a copy of them.
exports.DASHBOARD_STATIC_OPTIONS = {
    // No `exclude`: the module's error handler rewrites every error raised on an excluded path into
    // 404 "Cannot <method> <url>", which hid the body parsers' 413 and 400 under /api, /socket.io and
    // /mcp. Nest answers unknown routes there on its own now that the fallback below is off.
    // Disable this module's OWN catch-all SPA fallback. configure-app.ts already serves dashboard
    // documents (it injects the per-response CSP nonce, which is why it must own them), and
    // that handler is correctly narrow: it skips /assets and only answers extensionless paths
    // or explicit text/html navigations. The built-in fallback here is not narrow — it answers
    // EVERY unmatched GET with index.html, so a mistyped `<script src>` came back 200 HTML and
    // the browser reported a JavaScript parse error instead of the real 404, hiding broken
    // builds behind a confusing symptom. It is also outright broken when the install path
    // contains a dot-segment (~/.openwa, a checkout under ~/.cache): it sends the index by
    // ABSOLUTE path and Express's `send` refuses dot-segments, 404ing every client-side route.
    // Turning it off fixes both, and makes behaviour identical on either path shape.
    // ServeStaticModule has no explicit off switch, so this is a renderPath literal that no
    // real request can match.
    renderPath: '/__openwa_spa_fallback_owned_by_main_ts__',
};
const serveStaticModules = [];
if (exports.dashboardServingEnabled && exports.dashboardBuildPresent) {
    serveStaticModules.push(serve_static_1.ServeStaticModule.forRoot({ rootPath: exports.DASHBOARD_DIST, ...exports.DASHBOARD_STATIC_OPTIONS }));
}
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            // Configuration
            config_1.ConfigModule.forRoot({
                isGlobal: true,
                load: [configuration_1.default],
                validate: env_validation_1.validateEnv,
            }),
            // Main Database (always SQLite - boot config)
            typeorm_1.TypeOrmModule.forRootAsync({
                name: 'main',
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                // Migrations always, then synchronize on MAIN_DATABASE_SYNCHRONIZE=true; the factory refuses a
                // file whose schema does not match this release (see main-connection.ts).
                useFactory: (configService) => (0, main_connection_1.mainConnectionOptions)(configService),
                dataSourceFactory: main_connection_1.createMainDataSource,
            }),
            // Data Storage Database (pluggable - user data)
            typeorm_1.TypeOrmModule.forRootAsync({
                name: 'data',
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                // The postgres branch runs its boot migrations under a cross-replica advisory lock inside
                // this factory (see pg-boot-migrations.ts) instead of TypeORM's unsynchronized built-in
                // migrationsRun; SQLite with synchronize is initialized there too, to deduplicate terminal webhook
                // failures before the schema sync, and other sqlite options keep the library's default path.
                dataSourceFactory: pg_boot_migrations_1.createBootDataSource,
                useFactory: (configService) => {
                    const dbType = configService.get('dataDatabase.type', 'sqlite');
                    const baseConfig = {
                        entities: [
                            __dirname + '/modules/session/**/*.entity{.ts,.js}',
                            __dirname + '/modules/webhook/**/*.entity{.ts,.js}',
                            __dirname + '/modules/message/**/*.entity{.ts,.js}',
                            __dirname + '/modules/template/**/*.entity{.ts,.js}',
                            __dirname + '/engine/**/*.entity{.ts,.js}',
                            __dirname + '/modules/integration/**/*.entity{.ts,.js}',
                            __dirname + '/modules/status-store/**/*.entity{.ts,.js}',
                            __dirname + '/modules/automation/**/*.entity{.ts,.js}',
                        ],
                        migrations: [__dirname + '/database/migrations/*{.ts,.js}'],
                        logging: configService.get('dataDatabase.logging', false),
                    };
                    if (dbType === 'postgres') {
                        // Schema selection: 'public' (default) is a no-op vs the historical behavior. A non-public
                        // schema additionally sets the session search_path (createBootDataSource runs it as a statement on
                        // connect rather than in the startup packet) so
                        // the project's RAW, unqualified migration SQL (CREATE TABLE "x"..., ALTER TABLE "y"...)
                        // resolves to the configured schema — TypeORM's `schema` option alone does NOT set
                        // search_path, so without this raw DDL would land in `public` while the migration ledger
                        // lands in the configured schema.
                        const schema = configService.get('dataDatabase.schema', 'public');
                        const useCustomSearchPath = schema && schema !== 'public';
                        return {
                            ...baseConfig,
                            name: 'data',
                            type: 'postgres',
                            schema,
                            host: configService.get('dataDatabase.host'),
                            port: configService.get('dataDatabase.port'),
                            username: configService.get('dataDatabase.username'),
                            password: configService.get('dataDatabase.password'),
                            database: configService.get('dataDatabase.name', 'openwa'),
                            ssl: configService.get('dataDatabase.ssl', false)
                                ? {
                                    rejectUnauthorized: configService.get('dataDatabase.sslRejectUnauthorized', true),
                                }
                                : false,
                            // Never auto-sync Postgres in production; rely on migrations. Boot migrations execute
                            // inside createBootDataSource (dataSourceFactory above) under the advisory lock — this
                            // flag states the intent and remains the built-in fallback if that factory is ever
                            // bypassed (the factory constructs the DataSource with migrationsRun:false and calls
                            // runMigrations() itself while holding the lock).
                            synchronize: configService.get('dataDatabase.synchronize', false),
                            migrationsRun: true,
                            retryAttempts: 10,
                            retryDelay: 3000,
                            extra: {
                                max: configService.get('dataDatabase.poolSize', 10),
                                // Runtime query/pool timeouts so a stuck query or saturated pool fails fast instead of
                                // hanging requests. statement_timeout applies to the runtime pool only: the boot
                                // migration chain runs on a separate pool built without it (pg-boot-migrations.ts),
                                // so a long CREATE INDEX / backfill at boot is never aborted by it.
                                statement_timeout: configService.get('dataDatabase.statementTimeoutMs', 30000),
                                idleTimeoutMillis: configService.get('dataDatabase.idleTimeoutMs', 30000),
                                connectionTimeoutMillis: configService.get('dataDatabase.connectionTimeoutMs', 10000),
                                // Only set for a non-public schema (see above); createBootDataSource sets it on connect.
                                // `<schema>,public` keeps public on the
                                // path so pg_catalog + any public helpers still resolve; the configured schema wins.
                                ...(useCustomSearchPath ? { options: `-c search_path=${schema},public` } : {}),
                            },
                        };
                    }
                    // SQLite data DB: schema is MIGRATION-managed by default (DATABASE_SYNCHRONIZE unset/false),
                    // matching configuration.ts and .env.example ("Set false in production"). Set
                    // DATABASE_SYNCHRONIZE=true for zero-config synchronize instead. Computed once: the resolved
                    // value is always a boolean, so a get(..., true) fallback would never fire (and would be a trap).
                    const synchronize = configService.get('dataDatabase.synchronize', false);
                    return {
                        ...baseConfig,
                        name: 'data',
                        type: 'better-sqlite3',
                        database: configService.get('dataDatabase.database', './data/openwa.sqlite'),
                        timeout: main_connection_1.SQLITE_BUSY_TIMEOUT_MS,
                        synchronize,
                        migrationsRun: !synchronize,
                    };
                },
            }),
            // Rate limiting. When REDIS_ENABLED, the hit-count storage moves to Redis so limits aggregate
            // across replicas; otherwise the default in-memory (per-process) storage is used. Default off —
            // a single-node deployment gains nothing from Redis storage, and it adds a connection dep.
            throttler_1.ThrottlerModule.forRootAsync({
                imports: [config_1.ConfigModule],
                inject: [config_1.ConfigService],
                useFactory: (configService) => {
                    const throttlers = [
                        {
                            name: 'short',
                            ttl: configService.get('api.rateLimit.shortTtl', 1000),
                            limit: configService.get('api.rateLimit.shortLimit', 10),
                        },
                        {
                            name: 'medium',
                            ttl: configService.get('api.rateLimit.mediumTtl', 60000),
                            limit: configService.get('api.rateLimit.mediumLimit', 100),
                        },
                        {
                            name: 'long',
                            ttl: configService.get('api.rateLimit.longTtl', 3600000),
                            limit: configService.get('api.rateLimit.longLimit', 1000),
                        },
                    ];
                    // Fail-open on Redis error (see RedisThrottlerStorage), so a Redis outage never blocks the
                    // API. The client is built fail-fast (see throttler-redis.client.ts) so that fail-open
                    // engages immediately instead of after a queue/timeout stall per request.
                    const redisStorage = process.env.REDIS_ENABLED === 'true' ? new redis_throttler_storage_1.RedisThrottlerStorage((0, throttler_redis_client_1.createThrottlerRedisClient)()) : undefined;
                    return { throttlers, ...(redisStorage ? { storage: redisStorage } : {}) };
                },
            }),
            // Core modules
            hooks_1.HooksModule, // Global hook system for plugin integration
            // Global plugin system, kept ahead of ...queueModules. Nest runs the init hooks of global modules in the
            // order it first meets them among the imports, and PluginLoaderService.onModuleInit must mark the plugins
            // it restores before BullRegistrar starts the workers that take queued ingress jobs. This line and
            // QueueModule's own import of PluginsModule each keep it ahead of BullModule; test/queue-on.e2e-spec.ts
            // fails when neither does.
            plugins_1.PluginsModule,
            logger_module_1.LoggerModule,
            cache_1.CacheModule,
            storage_module_1.StorageModule,
            audit_module_1.AuditModule,
            events_module_1.EventsModule, // WebSocket real-time events
            ...queueModules,
            auth_module_1.AuthModule,
            engine_module_1.EngineModule,
            session_module_1.SessionModule,
            message_module_1.MessageModule,
            template_module_1.TemplateModule,
            webhook_module_1.WebhookModule,
            health_module_1.HealthModule,
            settings_module_1.SettingsModule,
            infra_module_1.InfraModule,
            contact_module_1.ContactModule,
            group_module_1.GroupModule,
            profile_module_1.ProfileModule, // Own-profile API (name / status / picture)
            call_module_1.CallModule, // Incoming-call API (reject a ringing call)
            label_module_1.LabelModule, // Phase 3: Labels Management
            channel_module_1.ChannelModule, // Phase 3: Channels/Newsletter
            stats_module_1.StatsModule, // Phase 3: Statistics Dashboard
            metrics_module_1.MetricsModule, // Prometheus /api/metrics
            status_module_1.StatusModule, // Phase 3: Status/Stories API
            media_module_1.MediaModule, // Server-side media conversion (opt-in)
            status_store_module_1.StatusStoreModule, // Phase 3: inbound status/story TTL store (24h purge + media persistence)
            chat_media_module_1.ChatMediaModule, // opt-in chat-media archive (retention purge + orphan sweep)
            automation_module_1.AutomationModule, // single-message autoreply rules, evaluated on the inbound dispatch
            takeover_module_1.TakeoverModule, // adopts sessions whose holder's lease lapsed (crashed peer / recreated node)
            catalog_module_1.CatalogModule, // Phase 3: Catalog API (WhatsApp Business)
            plugins_module_1.PluginsApiModule, // Phase 5: Plugins API
            agent_tools_module_1.AgentToolsModule, // Agent-invocable tool registry (protocol-neutral)
            integration_module_1.IntegrationModule, // Integration Fabric: @Public provider-webhook ingress + fast-ack pipeline
            ...searchModules, // Global message search (opt-out via SEARCH_ENABLED=false; default ON)
            ...mcpModules, // MCP Streamable-HTTP server (opt-in via MCP_ENABLED=true)
            ...serveStaticModules, // Bundled dashboard SPA (production single-port setup)
        ],
        // Runs after every DataSource has initialized (they initialize eagerly in their provider
        // factories, and onApplicationBootstrap fires after every onModuleInit), tightening the SQLite
        // files that better-sqlite3 created with umask permissions back to owner-only.
        providers: [sqlite_file_permissions_1.SqlitePermissionsBoot],
    })
], AppModule);
