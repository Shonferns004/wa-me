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
Object.defineProperty(exports, "__esModule", { value: true });
const glob_1 = require("glob");
const data_source_1 = __importStar(require("./data-source"));
// The data CLI DataSource manages the DATA connection's migrations (session/webhook/message/
// template/engine). It must NOT pull in the auth/audit entities — those belong to the always-SQLite
// MAIN connection (data-source-main.ts). A broad '**' entity glob would sweep the main-owned
// entities into `migration:generate` against the data DB and emit spurious auth/audit DDL.
describe('data CLI DataSource', () => {
    const resolveEntityFiles = () => data_source_1.default.options.entities
        .flatMap(pattern => (0, glob_1.globSync)(pattern))
        .map(file => file.replace(/\\/g, '/'));
    it('resolves the data-owned entities (session, webhook, message, template, engine)', () => {
        const files = resolveEntityFiles();
        expect(files.some(f => f.endsWith('session.entity.js'))).toBe(true);
        expect(files.some(f => f.endsWith('webhook.entity.js'))).toBe(true);
        expect(files.some(f => f.endsWith('message.entity.js'))).toBe(true);
        expect(files.some(f => f.endsWith('template.entity.js'))).toBe(true);
        expect(files.some(f => f.endsWith('lid-mapping.entity.js'))).toBe(true);
    });
    it('never resolves the main-owned api-key/audit-log entities', () => {
        const files = resolveEntityFiles();
        expect(files.some(f => f.endsWith('api-key.entity.js'))).toBe(false);
        expect(files.some(f => f.endsWith('audit-log.entity.js'))).toBe(false);
    });
    it('does not use a catch-all entity glob (guards against re-broadening)', () => {
        for (const pattern of data_source_1.default.options.entities) {
            expect(pattern).not.toMatch(/\/\.\.\/\*\*\/\*\.entity/);
        }
    });
    it('refuses to load when DATABASE_NAME resolves to the main DB file (CLI collision guard)', () => {
        // The migration CLI never runs ConfigModule's validate(), so the SQLite main/data collision
        // guard is applied at module load instead — data migrations must never run against the main
        // (auth/audit) file.
        const prevMain = process.env.MAIN_DATABASE_NAME;
        const prevData = process.env.DATABASE_NAME;
        process.env.MAIN_DATABASE_NAME = '/tmp/cli-guard-main.sqlite';
        // A non-normalized relative spelling of the same file must be caught too.
        process.env.DATABASE_NAME = '/tmp/../tmp/cli-guard-main.sqlite';
        jest.resetModules();
        try {
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                require('./data-source');
            }).toThrow(/DATABASE_NAME/);
        }
        finally {
            if (prevMain !== undefined)
                process.env.MAIN_DATABASE_NAME = prevMain;
            else
                delete process.env.MAIN_DATABASE_NAME;
            if (prevData !== undefined)
                process.env.DATABASE_NAME = prevData;
            else
                delete process.env.DATABASE_NAME;
            jest.resetModules();
        }
    });
    // Boot rejects a padded selector, but the CLI compared it raw: 'postgres ' from the host env, or
    // quoted in .env, picked the SQLite options and migrated a file named after the Postgres database.
    it.each(['postgres ', ' sqlite', 'postgre'])('refuses to load with DATABASE_TYPE %j', value => {
        const prevType = process.env.DATABASE_TYPE;
        process.env.DATABASE_TYPE = value;
        jest.resetModules();
        try {
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                require('./data-source');
            }).toThrow(`DATABASE_TYPE must be "sqlite" or "postgres" (got ${JSON.stringify(value)})`);
        }
        finally {
            if (prevType !== undefined)
                process.env.DATABASE_TYPE = prevType;
            else
                delete process.env.DATABASE_TYPE;
            jest.resetModules();
        }
    });
    it('refuses to load a postgres CLI connection with a mixed-case POSTGRES_SCHEMA', () => {
        // search_path is unquoted (folded to lower case) while TypeORM quotes the schema, so migration DDL
        // and the ledger would land in two different schemas.
        const prevType = process.env.DATABASE_TYPE;
        const prevSchema = process.env.POSTGRES_SCHEMA;
        process.env.DATABASE_TYPE = 'postgres';
        process.env.POSTGRES_SCHEMA = 'OpenWA';
        jest.resetModules();
        try {
            expect(() => {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                require('./data-source');
            }).toThrow(/POSTGRES_SCHEMA/);
        }
        finally {
            if (prevType !== undefined)
                process.env.DATABASE_TYPE = prevType;
            else
                delete process.env.DATABASE_TYPE;
            if (prevSchema !== undefined)
                process.env.POSTGRES_SCHEMA = prevSchema;
            else
                delete process.env.POSTGRES_SCHEMA;
            jest.resetModules();
        }
    });
});
// The migration CLI connection runs DDL (CREATE INDEX, unique backfills) that can legitimately take
// minutes on a large table. It must carry pool/connection timeouts for resilience but MUST NOT carry a
// server-side statement_timeout, or a long migration would be aborted mid-flight.
describe('Postgres migration connection pool timeouts', () => {
    const extra = data_source_1.postgresDataSourceOptions.extra;
    it('sets idle and connection pool timeouts', () => {
        expect(extra.idleTimeoutMillis).toBe(30000);
        expect(extra.connectionTimeoutMillis).toBe(10000);
    });
    it('never sets statement_timeout (would abort long-running migrations)', () => {
        expect(extra.statement_timeout).toBeUndefined();
    });
});
// POSTGRES_SCHEMA: a non-public schema sets TypeORM's `schema` option AND the session search_path (by a
// statement in the connect hook, never in the startup packet, which PgBouncer does not carry to every
// client) so the project's raw, unqualified migration DDL + the typeorm_migrations ledger resolve to the
// configured schema. The default (public) path sets none. The builder is tested directly so no
// process.env mutation or module reload is needed.
describe('PostgreSQL schema selection (POSTGRES_SCHEMA)', () => {
    /** The statements the CLI pool's connect hook issues on a fresh connection. */
    const connectStatements = async (opts) => {
        const query = jest.fn().mockResolvedValue({});
        await (opts.extra?.onConnect)({ query });
        return query.mock.calls.map(([sent]) => sent.text);
    };
    it('defaults schema to "public" and does NOT set a search_path when POSTGRES_SCHEMA is unset', async () => {
        const opts = (0, data_source_1.buildPostgresDataSourceOptions)({});
        expect(opts.schema).toBe('public');
        expect(opts.extra?.options).toBeUndefined();
        expect(await connectStatements(opts)).toEqual(["SET TIME ZONE 'UTC'"]);
    });
    it('passes schema through and sets the search_path on connect for a non-public schema', async () => {
        const opts = (0, data_source_1.buildPostgresDataSourceOptions)({ POSTGRES_SCHEMA: 'openwa' });
        expect(opts.schema).toBe('openwa');
        expect(opts.extra?.options).toBeUndefined();
        expect(await connectStatements(opts)).toEqual([
            "SET TIME ZONE 'UTC'; SELECT set_config('search_path', 'openwa,public', false)",
        ]);
    });
    it('keeps the pool timeouts under a custom schema (never drops them or adds statement_timeout)', () => {
        const opts = (0, data_source_1.buildPostgresDataSourceOptions)({ POSTGRES_SCHEMA: 'openwa' });
        expect(opts.extra?.max).toBe(10);
        expect(opts.extra?.idleTimeoutMillis).toBe(30000);
        expect(opts.extra?.connectionTimeoutMillis).toBe(10000);
        // the migration connection must STILL never carry a statement_timeout
        expect(opts.extra?.statement_timeout).toBeUndefined();
    });
});
