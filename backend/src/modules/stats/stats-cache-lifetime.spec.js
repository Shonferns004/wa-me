"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const stats_service_1 = require("./stats.service");
const session_entity_1 = require("../session/entities/session.entity");
const message_entity_1 = require("../message/entities/message.entity");
describe('StatsService memo lifetime', () => {
    let ds;
    let service;
    const keys = () => [...service.memo.keys()];
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, message_entity_1.Message],
            synchronize: true,
        });
        await ds.initialize();
        const config = { get: (_key, fallback) => (_key === 'stats.cacheTtlMs' ? 1000 : fallback) };
        service = new stats_service_1.StatsService(ds.getRepository(session_entity_1.Session), ds.getRepository(message_entity_1.Message), config);
        for (const id of ['a', 'b'])
            await ds.getRepository(session_entity_1.Session).save({ id, name: id, config: {} });
    });
    afterEach(async () => {
        jest.restoreAllMocks();
        await ds.destroy();
    });
    it('drops the expired entry of a deleted session once another one is computed', async () => {
        const start = Date.now();
        await service.getSessionStats('a');
        await ds.getRepository(session_entity_1.Session).delete({ id: 'a' });
        expect(keys()).toEqual(['session:a']);
        jest.spyOn(Date, 'now').mockReturnValue(start + 5000);
        await service.getSessionStats('b');
        expect(keys()).toEqual(['session:b']);
    });
    it('keeps an entry that has not expired', async () => {
        await service.getSessionStats('a');
        await service.getSessionStats('b');
        expect(keys().sort()).toEqual(['session:a', 'session:b']);
    });
});
