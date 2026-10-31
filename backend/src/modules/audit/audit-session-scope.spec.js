"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// A session-scoped ADMIN key (allowedSessions set) must not read another tenant's audit rows.
// The ApiKeyGuard fence only reads route params, so `GET /api/audit?sessionId=...` (a QUERY param)
// bypasses it — with no param at all, an unscoped findAll returns every tenant's rows. These run
// against a real in-memory DB so the scoping is exercised end-to-end, not asserted on a mock.
const typeorm_1 = require("typeorm");
const audit_service_1 = require("./audit.service");
const audit_log_entity_1 = require("./entities/audit-log.entity");
describe('AuditService session-scoped findAll', () => {
    let ds;
    let service;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [audit_log_entity_1.AuditLog],
            synchronize: true,
        });
        await ds.initialize();
        const repo = ds.getRepository(audit_log_entity_1.AuditLog);
        service = new audit_service_1.AuditService(repo);
        for (const sessionId of ['sessA', 'sessB']) {
            await repo.save(repo.create({ action: audit_log_entity_1.AuditAction.SESSION_CREATED, severity: audit_log_entity_1.AuditSeverity.INFO, sessionId }));
        }
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('a key scoped to sessA sees only sessA rows, never sessB', async () => {
        const { data, total } = await service.findAll({}, ['sessA']);
        expect(data.map(r => r.sessionId)).toEqual(['sessA']);
        expect(total).toBe(1);
    });
    it('a scoped key with NO sessionId param does not leak other tenants (the where={} leak)', async () => {
        const { data } = await service.findAll({}, ['sessA']);
        expect(data.every(r => r.sessionId === 'sessA')).toBe(true);
    });
    it('a scoped key requesting sessB (outside its scope) gets nothing, not sessB', async () => {
        const { data, total } = await service.findAll({ sessionId: 'sessB' }, ['sessA']);
        expect(data).toEqual([]);
        expect(total).toBe(0);
    });
    it('an unrestricted key (null allowlist) still sees all tenants', async () => {
        const { total } = await service.findAll({}, null);
        expect(total).toBe(2);
    });
    it('an unrestricted key can still narrow to a single session via the query param', async () => {
        const { data } = await service.findAll({ sessionId: 'sessB' }, null);
        expect(data.map(r => r.sessionId)).toEqual(['sessB']);
    });
});
