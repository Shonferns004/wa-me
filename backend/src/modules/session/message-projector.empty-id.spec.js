"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const message_entity_1 = require("../message/entities/message.entity");
const message_projector_service_1 = require("./message-projector.service");
const inbound_room_1 = require("./inbound-room");
const flush = async () => {
    for (let n = 0; n < 10; n++)
        await new Promise(resolve => setImmediate(resolve));
};
// An engine that cannot read a message's id reports the empty sentinel for it. Such an id names no message, so
// a change that carries it must not reach a message that is still being written under the same sentinel.
describe('a change that names no message id', () => {
    let db;
    let repository;
    let engine;
    let projector;
    let announced;
    let release;
    beforeEach(async () => {
        db = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message],
            synchronize: true,
        }).initialize();
        repository = db.getRepository(message_entity_1.Message);
        const engines = new engine_registry_service_1.EngineRegistry();
        engine = {};
        engines.set('s1', engine);
        announced = [];
        const gate = (0, inbound_room_1.deferred)();
        release = () => gate.resolve();
        projector = new message_projector_service_1.MessageProjector(repository, { update: jest.fn().mockResolvedValue({ affected: 1 }) }, engines, { emitMessage: jest.fn(), emitMessageRevoked: jest.fn() }, {
            dispatch: jest.fn((_session, event) => {
                announced.push(event);
                return Promise.resolve();
            }),
        }, {
            execute: jest.fn(async (event, data) => {
                if (event === 'message:received' || event === 'message:sent')
                    await gate.promise;
                return { continue: true, data };
            }),
        }, {}, { resolveSenderPhone: jest.fn().mockResolvedValue(null) });
    });
    afterEach(async () => {
        await db.destroy();
    });
    it.each([
        ['received', false],
        ['sent', true],
    ])('does not take back an unrelated message %s that is still in its hook chain', async (event, fromMe) => {
        const chatId = '628111@c.us';
        const message = {
            id: '',
            chatId,
            from: fromMe ? '620000@c.us' : chatId,
            to: fromMe ? chatId : '620000@c.us',
            fromMe,
            body: 'hello',
            type: 'text',
            timestamp: 1_700_000_000,
            isGroup: false,
            kind: 'individual',
        };
        if (fromMe)
            projector.handleOwnSendEcho('s1', engine, message);
        else
            projector.handleInboundMessage('s1', engine, message);
        await flush();
        projector.handleMessageRevoked('s1', engine, { id: '', chatId });
        await flush();
        release();
        await flush();
        expect(await repository.find()).toEqual([expect.objectContaining({ body: 'hello', type: 'text' })]);
        expect(announced).toContain(`message.${event}`);
    });
});
