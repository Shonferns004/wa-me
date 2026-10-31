"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const lid_mapping_entity_1 = require("../../../engine/identity/lid-mapping.entity");
const message_entity_1 = require("../../../modules/message/entities/message.entity");
const _1786950000000_ScrubNonPhoneLidMappings_1 = require("../1786950000000-ScrubNonPhoneLidMappings");
// A real SQLite database: the statements themselves are what is under test.
describe('ScrubNonPhoneLidMappings migration', () => {
    const migration = new _1786950000000_ScrubNonPhoneLidMappings_1.ScrubNonPhoneLidMappings1786950000000();
    let ds;
    let mappings;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [lid_mapping_entity_1.LidMapping, message_entity_1.Message],
            synchronize: true,
        });
        await ds.initialize();
        mappings = ds.getRepository(lid_mapping_entity_1.LidMapping);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const message = (chatId) => ds.getRepository(message_entity_1.Message).save({
        sessionId: 's1',
        chatId,
        waMessageId: `wa-${chatId}`,
        from: chatId,
        to: 'me@c.us',
        body: 'hi',
        type: 'text',
        direction: message_entity_1.MessageDirection.INCOMING,
        status: message_entity_1.MessageStatus.SENT,
        timestamp: 1,
    });
    it('drops a status or broadcast-list id stored as a phone and keeps real phones and negative results', async () => {
        await mappings.save([
            { lid: '111', phone: 'status', sessionId: 's1' },
            { lid: '222', phone: '1612345678', sessionId: 's1' },
            { lid: '333', phone: '628111', sessionId: 's1' },
            { lid: '444', phone: null, sessionId: 's1' },
        ]);
        await message('1612345678@broadcast');
        await message('status@broadcast');
        await message('628111@c.us');
        const runner = ds.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner); // idempotent
        await runner.release();
        const rows = await mappings.find({ order: { lid: 'ASC' } });
        expect(rows.map(r => [r.lid, r.phone])).toEqual([
            ['333', '628111'],
            ['444', null],
        ]);
    });
    it('skips a database without the tables', async () => {
        const empty = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await empty.initialize();
        const runner = empty.createQueryRunner();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down()).resolves.toBeUndefined();
        await runner.release();
        await empty.destroy();
    });
});
