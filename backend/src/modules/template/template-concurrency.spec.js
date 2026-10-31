"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const template_service_1 = require("./template.service");
const template_entity_1 = require("./entities/template.entity");
const session_entity_1 = require("../session/entities/session.entity");
const deferred = () => {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
};
describe('concurrent template edits', () => {
    let database;
    let repository;
    let service;
    let id;
    beforeEach(async () => {
        database = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, template_entity_1.Template],
            synchronize: true,
            logging: false,
        });
        await database.initialize();
        const sessions = database.getRepository(session_entity_1.Session);
        await sessions.save(sessions.create({ id: 'session-a', name: 'session-a', status: session_entity_1.SessionStatus.READY, config: {} }), { transaction: false });
        repository = database.getRepository(template_entity_1.Template);
        service = new template_service_1.TemplateService(repository, sessions);
        id = (await service.create('session-a', { name: 'greeting', body: 'old-body', footer: 'old-footer' })).id;
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        if (database?.isInitialized)
            await database.destroy();
    });
    const stallRead = () => {
        const entered = deferred();
        const release = deferred();
        const real = repository.findOne.bind(repository);
        jest.spyOn(repository, 'findOne').mockImplementationOnce(async (options) => {
            const row = await real(options);
            entered.resolve();
            await release.promise;
            return row;
        });
        return { entered: entered.promise, release: release.resolve };
    };
    it.each([
        [{ body: 'new-body' }, { footer: 'new-footer' }, { body: 'new-body', footer: 'new-footer' }],
        [{ name: 'renamed' }, { body: 'new-body' }, { name: 'renamed', body: 'new-body' }],
        [{}, { body: 'new-body' }, { name: 'greeting', body: 'new-body' }],
    ])('preserves independently supplied fields: %j / %j', async (slowPatch, fastPatch, expected) => {
        const gate = stallRead();
        const slow = service.update('session-a', id, slowPatch);
        try {
            await gate.entered;
            await service.update('session-a', id, fastPatch);
        }
        finally {
            gate.release();
        }
        await slow;
        expect(await repository.findOneByOrFail({ id })).toMatchObject(expected);
    });
    it('returns404 rather than reinserting a template deleted during the edit', async () => {
        const gate = stallRead();
        const slow = service.update('session-a', id, { body: 'late-body' });
        const outcome = slow.then(() => undefined, error => error);
        try {
            await gate.entered;
            await service.delete('session-a', id);
        }
        finally {
            gate.release();
        }
        expect(await outcome).toMatchObject({ status: 404 });
        expect(await repository.countBy({ id })).toBe(0);
    });
});
