"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const fs_1 = require("fs");
const path_1 = require("path");
const typeorm_1 = require("typeorm");
const api_key_usage_tracker_service_1 = require("./api-key-usage-tracker.service");
const api_key_entity_1 = require("./entities/api-key.entity");
/**
 * The usage-stat write must carry usage state and nothing else.
 *
 * Authentication loads the whole key row and hands the entity to the usage tracker, which mutates
 * `lastUsedAt`/`usageCount` on it and persists on a 60s window. Persisting that entity WHOLE writes
 * every column back — including `isActive`, `role`, `allowedSessions`, `allowedIps` and `expiresAt`
 * as they were when the request began. An administrator change committed between the load and the
 * windowed write is silently reverted by an advisory statistics update. Deletion is a hard delete,
 * so the same write on a removed key is an INSERT rather than an UPDATE: the credential comes back
 * with its original hash and authenticates again.
 *
 * `forget()` is called by revoke() and delete() after their write and closes the window for a key with
 * only PENDING counters. It cannot reach an entity a request handler is already holding, which is the
 * case these tests pin.
 *
 * The shutdown path already writes correctly — `flushPending` uses an atomic column increment and its
 * own comment warns against "reloading the row and saving it back". These tests hold the hot path to
 * the same standard.
 */
function makeRow(overrides = {}) {
    return {
        id: 'key-1',
        name: 'Test Key',
        keyHash: 'hash',
        keyPrefix: 'prefix',
        role: api_key_entity_1.ApiKeyRole.OPERATOR,
        allowedIps: null,
        allowedSessions: null,
        allowedChats: null,
        isActive: true,
        expiresAt: null,
        lastUsedAt: null,
        usageCount: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}
/**
 * A repository standing in for one persisted row: `save` writes the whole entity over it, `update`
 * writes only the named columns. That asymmetry is the entire subject of these tests, so the double
 * models it rather than asserting on which method was called.
 */
function makeRepository(row) {
    return {
        save: jest.fn((entity) => {
            Object.assign(row, entity);
            return Promise.resolve(entity);
        }),
        update: jest.fn((_criteria, patch) => {
            Object.assign(row, patch);
            return Promise.resolve({ affected: 1 });
        }),
        increment: jest.fn(() => Promise.resolve({ affected: 1 })),
    };
}
/** The columns the usage write is allowed to touch. */
const USAGE_COLUMNS = ['lastUsedAt', 'usageCount'];
describe('API-key usage write scope', () => {
    it('does not resurrect a key revoked while the request was in flight', async () => {
        const row = makeRow();
        const repository = makeRepository(row);
        const tracker = new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repository);
        // A request authenticates and the handler now holds its own copy of the row.
        const heldByRequest = { ...row };
        // An administrator revokes the key while that request is still in flight. forget() clears any
        // PENDING counter but cannot reach the entity above.
        row.isActive = false;
        tracker.forget(row.id);
        // The windowed usage write fires (lastUsedAt is null, so the window is due immediately).
        await tracker.record(heldByRequest);
        expect(row.isActive).toBe(false);
    });
    it('does not revert an authorisation narrowing committed while the request was in flight', async () => {
        const row = makeRow({ role: api_key_entity_1.ApiKeyRole.ADMIN });
        const repository = makeRepository(row);
        const tracker = new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repository);
        const heldByRequest = { ...row };
        // Narrowed on every authorisation dimension at once.
        row.role = api_key_entity_1.ApiKeyRole.VIEWER;
        row.allowedSessions = ['session-a'];
        row.allowedIps = ['10.0.0.1'];
        row.expiresAt = new Date('2020-01-01T00:00:00.000Z');
        await tracker.record(heldByRequest);
        expect(row.role).toBe(api_key_entity_1.ApiKeyRole.VIEWER);
        expect(row.allowedSessions).toEqual(['session-a']);
        expect(row.allowedIps).toEqual(['10.0.0.1']);
        expect(row.expiresAt).toEqual(new Date('2020-01-01T00:00:00.000Z'));
    });
    it('persists exactly the two usage columns and no others', async () => {
        const row = makeRow();
        const repository = makeRepository(row);
        const tracker = new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repository);
        await tracker.record({ ...row });
        const updateCall = repository.update.mock.calls[0];
        const saveCall = repository.save.mock.calls[0];
        const written = updateCall ? updateCall[1] : saveCall[0];
        expect(Object.keys(written).sort()).toEqual([...USAGE_COLUMNS].sort());
        // Neither column may arrive undefined. TypeORM strips an undefined value from the SET clause
        // rather than writing NULL, so an undefined here is not a wipe — it is a write that silently
        // updates nothing but `updatedAt`, and the statistics stop advancing with no error to notice.
        expect(written.lastUsedAt).toBeInstanceOf(Date);
        // The count is a SQL increment expression, not a value.
        expect(typeof written.usageCount).toBe('function');
    });
    it('aims the write at the row it loaded and no other', async () => {
        const row = makeRow();
        const repository = makeRepository(row);
        const tracker = new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repository);
        await tracker.record({ ...row });
        // Blast radius, not column scope. The double writes whatever patch it is handed to the single row
        // it models, so every assertion about WHAT is written holds just as well for a write aimed at the
        // wrong rows: `update({ isActive: true }, ...)` — which TypeORM accepts — would stamp one key's
        // statistics onto every active key, and passes all of the tests above.
        expect(repository.update.mock.calls[0][0]).toEqual({ id: row.id });
    });
    it('still returns the incremented counters on the entity the caller holds', async () => {
        const row = makeRow({ usageCount: 5 });
        const repository = makeRepository(row);
        const tracker = new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repository);
        const heldByRequest = { ...row };
        await tracker.record(heldByRequest);
        expect(heldByRequest.usageCount).toBe(6);
        expect(heldByRequest.lastUsedAt).toBeInstanceOf(Date);
    });
    it('keeps a failed usage write non-fatal', async () => {
        const row = makeRow();
        const repository = makeRepository(row);
        repository.update.mockRejectedValueOnce(new Error('db down'));
        repository.save.mockRejectedValueOnce(new Error('db down'));
        const tracker = new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repository);
        await expect(tracker.record({ ...row })).resolves.toBeUndefined();
    });
});
describe('API-key usage count at a window boundary', () => {
    let ds;
    beforeAll(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [api_key_entity_1.ApiKey], synchronize: true });
        await ds.initialize();
    });
    afterAll(async () => {
        await ds.destroy();
    });
    it('keeps every counted use when two requests holding the same stale row both write', async () => {
        const repo = ds.getRepository(api_key_entity_1.ApiKey);
        const { id } = await repo.save(repo.create({ name: 'k', keyPrefix: 'kp', keyHash: 'window', role: api_key_entity_1.ApiKeyRole.OPERATOR, usageCount: 0 }));
        const tracker = new api_key_usage_tracker_service_1.ApiKeyUsageTracker(repo);
        // Ten uses inside the window stay pending.
        await repo.update({ id }, { lastUsedAt: new Date(Date.now() - 1_000) });
        for (let i = 0; i < 10; i++)
            await tracker.record(await repo.findOneByOrFail({ id }));
        // The window passes; two requests load the same row before either windowed write lands.
        await repo.update({ id }, { lastUsedAt: new Date(Date.now() - 120_000) });
        const first = await repo.findOneByOrFail({ id });
        const second = await repo.findOneByOrFail({ id });
        await Promise.all([tracker.record(first), tracker.record(second)]);
        expect((await repo.findOneByOrFail({ id })).usageCount).toBe(12);
    });
});
/**
 * Structural guard for the entrypoint dimension of the same bug.
 *
 * The defect lives in the usage write, which every authentication path reaches through
 * validateApiKey. An enumeration that misses an entrypoint produces a fix that looks complete and
 * leaves a path uncovered — the websocket re-validation in events.gateway.ts was missed exactly once
 * during analysis of this defect. This test fails when a new call site appears, so the next
 * enumeration cannot silently be short.
 */
describe('validateApiKey entrypoint coverage', () => {
    /** Every known caller, with the surface it authenticates. */
    const KNOWN_CALLERS = new Map([
        ['core/agent-tools/tool-invoker.js', 'agent tool invocation'],
        ['common/security/bull-board-auth.middleware.js', 'queue dashboard middleware'],
        ['modules/auth/guards/api-key.guard.js', 'REST route guard'],
        ['modules/events/events.gateway.js', 'websocket connect and per-subscribe re-validation'],
        ['modules/health/health.controller.js', 'version disclosure on the public health check'],
        ['modules/mcp/mcp.server.js', 'MCP mount key gate'],
    ]);
    /** Where validateApiKey is declared, which is not a caller. */
    const DEFINITION = 'modules/auth/auth.service.js';
    function walk(dir, out = []) {
        for (const entry of (0, fs_1.readdirSync)(dir, { withFileTypes: true })) {
            const full = (0, path_1.join)(dir, entry.name);
            if (entry.isDirectory())
                walk(full, out);
            else if (entry.name.endsWith('.js') && !entry.name.endsWith('.spec.js'))
                out.push(full);
        }
        return out;
    }
    it('enumerates every caller of validateApiKey', () => {
        const srcRoot = (0, path_1.join)(__dirname, '..', '..');
        const callers = walk(srcRoot)
            .filter(file => /\bvalidateApiKey\s*\(/.test((0, fs_1.readFileSync)(file, 'utf8')))
            .map(file => (0, path_1.relative)(srcRoot, file).split(path_1.sep).join('/'))
            .filter(rel => rel !== DEFINITION)
            .sort();
        expect(callers).toEqual([...KNOWN_CALLERS.keys()].sort());
    });
});
