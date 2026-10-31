"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../message/entities/message.entity");
const session_entity_1 = require("./entities/session.entity");
const message_history_projector_1 = require("./message-history-projector");
// A revoke tombstone from a history sync names the chat in the neutral dialect, while a row a REST send
// wrote keeps the chat id as the caller wrote it.
describe('persistHistoryMessages revokes', () => {
    let ds;
    let repo;
    const logger = { log: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() };
    const stored = (chatId, waMessageId = 'W1') => repo.insert({
        sessionId: 's1',
        waMessageId,
        chatId,
        from: 'me@c.us',
        to: chatId,
        body: 'secret text',
        type: 'text',
        direction: message_entity_1.MessageDirection.OUTGOING,
        timestamp: 10,
    });
    const tombstone = (chatId) => ({
        id: 'W1',
        chatId,
        from: 'me@c.us',
        to: chatId,
        body: '',
        type: 'revoked',
        timestamp: 5,
        fromMe: true,
        isGroup: false,
        kind: 'individual',
    });
    const run = (messages) => (0, message_history_projector_1.persistHistoryMessages)(repo, undefined, 's1', messages, logger, () => true);
    beforeEach(async () => {
        ds = new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [session_entity_1.Session, message_entity_1.Message],
            synchronize: true,
        });
        await ds.initialize();
        repo = ds.getRepository(message_entity_1.Message);
    });
    afterEach(() => ds.destroy());
    it('clears a row stored under the other dialect of the same chat', async () => {
        await stored('628111@s.whatsapp.net');
        const cleared = await run([tombstone('628111@c.us')]);
        const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'W1' });
        expect(row).toMatchObject({ type: 'revoked', body: '', chatId: '628111@s.whatsapp.net' });
        expect(cleared.map(m => m.id)).toEqual(['W1']);
    });
    it.each([false, true])('retimes a tombstone only while its engine stays live (retired=%s)', async (retired) => {
        await stored('628111@c.us');
        await repo.update({ sessionId: 's1', waMessageId: 'W1' }, { type: 'revoked', body: '' });
        const before = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'W1' });
        let entered;
        const waiting = new Promise(resolve => (entered = resolve));
        let answer;
        const phone = new Promise(resolve => (answer = resolve));
        const lookup = jest.fn(() => {
            entered();
            return phone;
        });
        let live = true;
        const notify = jest.fn();
        const pending = (0, message_history_projector_1.persistHistoryMessages)(repo, undefined, 's1', [{ ...tombstone('484848@lid'), type: 'text', body: 'earlier original' }], logger, () => live, notify, lookup);
        try {
            await waiting;
            live = !retired;
            answer('628111');
            const cleared = await pending;
            expect(cleared.map(message => message.id)).toEqual(retired ? [] : ['W1']);
            const after = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'W1' });
            expect(after.timestamp).toBe(retired ? before.timestamp : 5);
            expect(after.createdAt).toEqual(retired ? before.createdAt : new Date(5_000));
            expect(after).toMatchObject({ type: 'revoked', body: '' });
            expect(notify).not.toHaveBeenCalled();
        }
        finally {
            answer('628111');
            await pending;
        }
    });
    it('leaves a row of another chat alone', async () => {
        await stored('120363000000000001@g.us');
        const cleared = await run([tombstone('628111@c.us')]);
        const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'W1' });
        expect(row).toMatchObject({ type: 'text', body: 'secret text' });
        expect(cleared).toEqual([]);
    });
});
