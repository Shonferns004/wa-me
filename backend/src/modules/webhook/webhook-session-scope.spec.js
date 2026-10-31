"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// webhook by-id operations (findOne/update/delete/test) must be scoped to the URL
// :sessionId, and GET /webhooks must be scoped to the key's allowedSessions. Without it, an
// OPERATOR key for one session can read/edit/delete/redirect/fire another session's webhook,
// and enumerate every session's webhook URLs. These run against a real in-memory DB so the
// scoping is exercised end-to-end, not asserted on a mock's WHERE clause.
const typeorm_1 = require("typeorm");
const common_1 = require("@nestjs/common");
const webhook_service_1 = require("./webhook.service");
const webhook_entity_1 = require("./entities/webhook.entity");
const session_entity_1 = require("../session/entities/session.entity");
describe('WebhookService session-scoped access', () => {
    let ds;
    let service;
    let whA;
    let whB;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, webhook_entity_1.Webhook],
            synchronize: true,
        });
        await ds.initialize();
        const repo = ds.getRepository(webhook_entity_1.Webhook);
        const cfg = { get: () => false }; // queue.enabled = false
        // 2nd arg is the delivery-failure repo, 3rd the session repo, and 5th the delivery service —
        // the scoped read/update/delete paths under test never touch them (only create() checks
        // session existence; test() would probe via the delivery service's header/signature helpers).
        service = new webhook_service_1.WebhookService(repo, {}, {}, cfg, {});
        const sessions = ds.getRepository(session_entity_1.Session);
        for (const id of ['sessA', 'sessB']) {
            await sessions.save(sessions.create({ id, name: id, status: session_entity_1.SessionStatus.READY, config: {} }));
        }
        whA = await repo.save(repo.create({
            sessionId: 'sessA',
            url: 'https://a.example/hook',
            events: ['message.received'],
            headers: {},
            retryCount: 3,
        }));
        whB = await repo.save(repo.create({
            sessionId: 'sessB',
            url: 'https://b.example/hook',
            events: ['message.received'],
            headers: {},
            retryCount: 3,
        }));
    });
    afterEach(async () => {
        await ds.destroy();
    });
    it('findOne returns a webhook only for its owning session', async () => {
        expect((await service.findOne('sessA', whA.id)).id).toBe(whA.id);
        await expect(service.findOne('sessA', whB.id)).rejects.toThrow(common_1.NotFoundException);
    });
    it('update refuses (404) a webhook owned by another session and does not mutate it', async () => {
        await expect(service.update('sessA', whB.id, { url: 'https://evil.example/x' })).rejects.toThrow(common_1.NotFoundException);
        expect((await ds.getRepository(webhook_entity_1.Webhook).findOneByOrFail({ id: whB.id })).url).toBe('https://b.example/hook');
    });
    it('delete refuses (404) a webhook owned by another session and does not remove it', async () => {
        await expect(service.delete('sessA', whB.id)).rejects.toThrow(common_1.NotFoundException);
        expect(await ds.getRepository(webhook_entity_1.Webhook).countBy({ id: whB.id })).toBe(1);
    });
    it('test refuses (404) to fire a webhook owned by another session', async () => {
        await expect(service.test('sessA', whB.id)).rejects.toThrow(common_1.NotFoundException);
    });
    it('findAll scopes to allowedSessions when set, returns all when unrestricted', async () => {
        expect((await service.findAll(['sessA'])).map(w => w.id)).toEqual([whA.id]);
        expect((await service.findAll(null)).map(w => w.id).sort()).toEqual([whA.id, whB.id].sort());
        expect((await service.findAll([])).length).toBe(2); // empty allowlist = unrestricted (matches the guard)
    });
});
