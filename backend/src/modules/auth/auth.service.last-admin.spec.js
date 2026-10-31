"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const common_1 = require("@nestjs/common");
const typeorm_1 = require("typeorm");
const api_key_entity_1 = require("./entities/api-key.entity");
const auth_service_1 = require("./auth.service");
/**
 * The last-admin guard against a REAL better-sqlite3 DataSource, for the part the in-memory double
 * cannot show: how long the surviving admin lasts. A survivor that expires before the key being
 * removed only postpones the lockout, so it must not let the removal through.
 */
describe('AuthService last-admin guard and expiring admins', () => {
    let ds;
    let repo;
    let service;
    const inHours = (hours) => new Date(Date.now() + hours * 3_600_000);
    beforeAll(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [api_key_entity_1.ApiKey], synchronize: true });
        await ds.initialize();
        repo = ds.getRepository(api_key_entity_1.ApiKey);
        const tracker = { record: jest.fn(), forget: jest.fn() };
        service = new auth_service_1.AuthService(repo, tracker, { get: () => undefined });
    });
    afterAll(async () => {
        await ds.destroy();
    });
    beforeEach(async () => {
        await repo.clear();
    });
    const admin = async (name, expiresAt) => (await repo.save(repo.create({ name, keyPrefix: name, keyHash: name, role: api_key_entity_1.ApiKeyRole.ADMIN, isActive: true, expiresAt }))).id;
    it('refuses to remove or expire a non-expiring admin when the only other admin expires', async () => {
        const a = await admin('a', null);
        const b = await admin('b', inHours(1));
        await expect(service.revoke(a)).rejects.toThrow(common_1.ConflictException);
        await expect(service.delete(a)).rejects.toThrow(common_1.ConflictException);
        await expect(service.update(a, { expiresAt: inHours(2).toISOString() })).rejects.toThrow(common_1.ConflictException);
        expect(await repo.findOneByOrFail({ id: a })).toMatchObject({ isActive: true, expiresAt: null });
        await expect(service.revoke(b)).resolves.toMatchObject({ isActive: false });
    });
    it('lets an expiring admin go when another admin lasts at least as long', async () => {
        const old = await admin('old', inHours(1));
        await admin('rotated', inHours(24 * 30));
        await expect(service.revoke(old)).resolves.toMatchObject({ isActive: false });
        await repo.clear();
        const longer = await admin('longer', inHours(24 * 30));
        await admin('shorter', inHours(1));
        await expect(service.delete(longer)).rejects.toThrow(common_1.ConflictException);
        await repo.clear();
        const first = await admin('first', null);
        await admin('second', null);
        await expect(service.delete(first)).resolves.toBeUndefined();
    });
    it('lets an expiring admin have its expiry pushed later, but not a demotion alongside it', async () => {
        const a = await admin('a', inHours(1));
        const b = await admin('b', inHours(0.5));
        await expect(service.update(a, { expiresAt: inHours(5).toISOString() })).resolves.toBeDefined();
        await expect(service.update(a, { expiresAt: inHours(72).toISOString() })).resolves.toBeDefined();
        await expect(service.update(a, { expiresAt: inHours(3).toISOString() })).rejects.toThrow(common_1.ConflictException);
        await expect(service.update(b, { expiresAt: inHours(0.75).toISOString() })).resolves.toBeDefined();
        await repo.clear();
        const sole = await admin('sole', inHours(1));
        await expect(service.update(sole, { expiresAt: inHours(5).toISOString() })).resolves.toBeDefined();
        await expect(service.update(sole, { expiresAt: inHours(10).toISOString(), role: api_key_entity_1.ApiKeyRole.OPERATOR })).rejects.toThrow(common_1.ConflictException);
        expect(await repo.findOneByOrFail({ id: sole })).toMatchObject({ role: api_key_entity_1.ApiKeyRole.ADMIN });
    });
});
