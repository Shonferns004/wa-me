"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../../../modules/message/entities/message.entity");
const _1786900000000_ScrubRevokedMessageContent_1 = require("../1786900000000-ScrubRevokedMessageContent");
// A real SQLite database: the statement itself is what is under test.
describe('ScrubRevokedMessageContent migration', () => {
    const migration = new _1786900000000_ScrubRevokedMessageContent_1.ScrubRevokedMessageContent1786900000000();
    let ds;
    let repository;
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:', entities: [message_entity_1.Message], synchronize: true });
        await ds.initialize();
        repository = ds.getRepository(message_entity_1.Message);
    });
    afterEach(async () => {
        await ds.destroy();
    });
    const row = (waMessageId, type, body) => repository.save(repository.create({
        sessionId: 's1',
        chatId: '628111@c.us',
        waMessageId,
        from: '628111@c.us',
        to: 'me@c.us',
        body,
        type,
        direction: message_entity_1.MessageDirection.INCOMING,
        status: message_entity_1.MessageStatus.SENT,
        timestamp: 1,
        metadata: { media: { mimetype: 'image/png', data: 'AAAA' }, reactions: { 'x@c.us': 'ok' } },
        mediaPath: `chat-media/s1/${waMessageId}.png`,
        mediaMimetype: 'image/png',
    }));
    it('clears the content of revoked rows and leaves every other row alone', async () => {
        const revoked = await row('wa-revoked', 'revoked', 'This message was deleted');
        const kept = await row('wa-kept', 'image', 'caption');
        const runner = ds.createQueryRunner();
        await migration.up(runner);
        await migration.up(runner); // idempotent
        await runner.release();
        expect(await repository.findOneByOrFail({ id: revoked.id })).toMatchObject({
            body: '',
            type: 'revoked',
            metadata: null,
            mediaPath: null,
            mediaMimetype: null,
        });
        expect(await repository.findOneByOrFail({ id: kept.id })).toMatchObject({
            body: 'caption',
            metadata: kept.metadata,
            mediaPath: kept.mediaPath,
            mediaMimetype: 'image/png',
        });
    });
    it('skips a database without a messages table', async () => {
        const empty = new typeorm_1.DataSource({ type: 'better-sqlite3', database: ':memory:' });
        await empty.initialize();
        const runner = empty.createQueryRunner();
        await expect(migration.up(runner)).resolves.toBeUndefined();
        await expect(migration.down()).resolves.toBeUndefined();
        await runner.release();
        await empty.destroy();
    });
});
