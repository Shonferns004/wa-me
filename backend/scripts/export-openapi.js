"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Generates the committed OpenAPI snapshot by bootstrapping the Nest app WITHOUT listening,
// then calling SwaggerModule.createDocument(). The script pins a hermetic environment below
// (in-memory main SQLite + a temp-dir data SQLite that is removed on exit, queue/MCP off) so it is
// safe to run anywhere: no DB files are left behind, no Redis connection is opened, no engines
// start, no sessions run. The version is sourced from package.json via swagger.config.ts, so the
// snapshot tracks releases automatically.
//
// Usage: node scripts/export-openapi.js <output-path>
require("../src/config/load-env");
const core_1 = require("@nestjs/core");
const swagger_1 = require("@nestjs/swagger");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const swagger_config_1 = require("../src/config/swagger.config");
// Pin a hermetic env BEFORE AppModule is imported. AppModule reads QUEUE_ENABLED / MCP_ENABLED at
// module top-level (its conditional module mounts) and TypeORM reads the DB settings during
// NestFactory.create() below — so these pins must win over whatever the loader applied above. That
// is why AppModule is imported dynamically inside main(), after these assignments. (NestFactory.create
// never calls init(), so onModuleInit / onApplicationBootstrap hooks — session autostart, the
// PROCESSING-batch and message-type backfills — do not fire regardless; the pins are belt-and-braces.)
process.env.QUEUE_ENABLED = 'false';
process.env.MCP_ENABLED = 'false';
process.env.AUTO_START_SESSIONS = 'false';
process.env.DATABASE_TYPE = 'sqlite';
// Keep the throttler storage in-memory: with REDIS_ENABLED=true in the caller's env the export
// would open a Redis connection for no benefit (the document doesn't change either way).
process.env.REDIS_ENABLED = 'false';
// The search module mounts conditionally on SEARCH_ENABLED (app.module.ts top-level), so an
// export run with SEARCH_ENABLED=false in the caller's env would silently drop /api/search from
// the snapshot. Pin it on — the committed snapshot documents the full default surface.
process.env.SEARCH_ENABLED = 'true';
async function main() {
    // Operator-supplied CLI path — this is a local dev/CI tool, not a network service, so there is
    // no trust boundary to enforce (the caller already has full filesystem access). No path
    // validation is applied by design; restricting writes to cwd would break legitimate out-of-tree
    // snapshot writes, which the documented usage explicitly allows.
    const out = process.argv[2];
    if (!out) {
        console.error('Usage: node scripts/export-openapi.js <output-path>');
        process.exit(1);
    }
    // The 'data' connection must use a real SQLite file path to satisfy env-validation (an in-memory or
    // bare value is rejected to catch PostgreSQL db-name leaks — see env.validation.ts). Use a temp dir
    // so the export stays hermetic; the whole dir is removed in the finally below, and recursive rmSync
    // also drops any SQLite -wal/-shm sidecars. The 'main' connection keeps in-memory SQLite. Created
    // only once the arguments are valid, so a usage error leaves nothing behind.
    const exportDataDir = (0, node_fs_1.mkdtempSync)((0, node_path_1.join)((0, node_os_1.tmpdir)(), 'openapi-export-'));
    process.env.DATABASE_NAME = (0, node_path_1.join)(exportDataDir, 'export.sqlite');
    process.env.MAIN_DATABASE_NAME = ':memory:';
    let app;
    try {
        // Imported after the env pins above so AppModule's top-level reads the hermetic values. Uses
        // require() rather than a dynamic import() because the entry point is CommonJS. Inside the try:
        // its top-level validation throws on a bad environment.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { AppModule } = require('../src/app.module');
        // Bootstrap the full DI graph so every controller/DTO is discovered, but never listen.
        // Errors/warns only — bootstrap is chatty and we only need the document. abortOnError: false
        // makes a failed bootstrap throw; the default aborts the process and skips the cleanup below.
        app = await core_1.NestFactory.create(AppModule, { logger: ['error', 'warn'], abortOnError: false });
        // Mirror main.ts: the global /api prefix is part of the real route paths the docs publish.
        app.setGlobalPrefix('api');
        const doc = swagger_1.SwaggerModule.createDocument(app, (0, swagger_config_1.createSwaggerConfig)());
        // Before the exemption pass, so it never spends work on an operation about to be removed.
        (0, swagger_config_1.dropUnexpressibleOperations)(doc);
        (0, swagger_config_1.exemptPublicOperations)(doc);
        (0, swagger_config_1.documentErrorResponses)(doc);
        (0, node_fs_1.writeFileSync)(out, JSON.stringify(doc, null, 2) + '\n');
        console.log(`✓ OpenAPI snapshot written to ${out} (version ${doc.info.version}, ${Object.keys(doc.paths).length} paths)`);
    }
    finally {
        try {
            await app?.close();
        }
        finally {
            (0, node_fs_1.rmSync)(exportDataDir, { recursive: true, force: true });
        }
    }
}
void main().catch(e => {
    console.error(e);
    process.exit(1);
});
