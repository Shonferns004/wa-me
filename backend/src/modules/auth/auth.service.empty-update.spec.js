"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const api_key_entity_1 = require("./entities/api-key.entity");
const auth_service_1 = require("./auth.service");
/**
 * Pins the empty-body semantics of update() against a REAL better-sqlite3 DataSource. Every
 * UpdateApiKeyDto field is optional, so `{}` is a legal request that must stay the historical
 * 200 no-op (the row returned unchanged). The unguarded path expresses this as a targeted UPDATE
 * whose set list is empty — TypeORM's entity-targeted update then stamps only `updatedAt`
 * (its empty-values branch appends the update-date column rather than throwing), which is easy
 * to break silently in a future rewrite of the statement builder, so it gets a dedicated spec.
 */
describe('AuthService update with an empty DTO', () => {
    let ds;
    let repo;
    beforeAll(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [api_key_entity_1.ApiKey],
            synchronize: true,
        });
        await ds.initialize();
        repo = ds.getRepository(api_key_entity_1.ApiKey);
    });
    afterAll(async () => {
        await ds.destroy();
    });
    it('is a 200-style no-op: resolves with the row, no columns change', async () => {
        const saved = await repo.save(repo.create({
            name: 'probe',
            keyPrefix: 'kp',
            keyHash: 'h',
            role: api_key_entity_1.ApiKeyRole.ADMIN,
            isActive: true,
            allowedIps: null,
            allowedSessions: null,
            expiresAt: null,
            usageCount: 0,
        }));
        const tracker = { record: jest.fn(), forget: jest.fn() };
        const service = new auth_service_1.AuthService(repo, tracker, {});
        const before = await repo.findOneByOrFail({ id: saved.id });
        const emptyDto = {};
        await expect(service.update(saved.id, emptyDto)).resolves.toMatchObject({ id: saved.id, name: 'probe' });
        const after = await repo.findOneByOrFail({ id: saved.id });
        expect(after.role).toBe(before.role);
        expect(after.isActive).toBe(before.isActive);
        expect(after.name).toBe(before.name);
    });
});
