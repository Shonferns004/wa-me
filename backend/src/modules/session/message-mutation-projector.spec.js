"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const message_entity_1 = require("../message/entities/message.entity");
const keyed_mutation_queue_1 = require("../../common/utils/keyed-mutation-queue");
const message_mutation_projector_1 = require("./message-mutation-projector");
const settle = async () => {
    for (let n = 0; n < 5; n++)
        await new Promise(resolve => setImmediate(resolve));
};
// The stored copy of a reaction is best-effort; the notification is not (see applyReaction).
describe('a reaction whose stored copy cannot be written', () => {
    let db;
    let emitMessageReaction;
    let dispatch;
    let projector;
    let logger;
    beforeEach(async () => {
        db = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message],
            synchronize: true,
        }).initialize();
        const repository = db.getRepository(message_entity_1.Message);
        await repository.insert({
            sessionId: 's1',
            waMessageId: 'WA1',
            chatId: '628111@c.us',
            from: '628111@c.us',
            to: '620000@c.us',
            direction: 'incoming',
            body: 'hello',
            type: 'text',
            timestamp: 1_700_000_000,
        });
        jest.spyOn(repository, 'update').mockRejectedValue(new Error('database is locked'));
        emitMessageReaction = jest.fn();
        dispatch = jest.fn().mockResolvedValue(undefined);
        logger = { error: jest.fn(), warn: jest.fn() };
        projector = new message_mutation_projector_1.MessageMutationProjector(repository, { emitMessageReaction }, { dispatch }, new keyed_mutation_queue_1.KeyedMutationQueue(), logger);
    });
    afterEach(async () => {
        await db.destroy();
    });
    it('is still announced, without the full list of reactions it could not compute', async () => {
        const event = { messageId: 'WA1', chatId: '628111@c.us', senderId: '628111@c.us', reaction: '👍' };
        projector.applyReactionQueued('s1', event);
        await settle();
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(emitMessageReaction).toHaveBeenCalledWith('s1', event);
        expect(dispatch).toHaveBeenCalledWith('s1', 'message.reaction', event);
    });
});
