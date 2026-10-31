"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const message_entity_1 = require("../message/entities/message.entity");
const message_send_service_1 = require("../message/message-send.service");
const message_projector_service_1 = require("./message-projector.service");
const settle = () => new Promise(resolve => setImmediate(resolve));
describe('an own-send echo losing its first insert to the REST writer', () => {
    it.each(['revoke', 'edit', 'reaction', 'ack'])('preserves an in-flight %s', async (change) => {
        jest.useFakeTimers({ doNotFake: ['setImmediate'] });
        const ds = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [message_entity_1.Message],
            synchronize: true,
        }).initialize();
        const repo = ds.getRepository(message_entity_1.Message);
        const engines = new engine_registry_service_1.EngineRegistry();
        let releaseEcho;
        const held = new Promise(resolve => (releaseEcho = resolve));
        const hooks = {
            execute: jest.fn((event, data) => event === 'message:sent' ? held : Promise.resolve({ continue: true, data })),
        };
        const events = {
            emitMessageSent: jest.fn(),
            emitMessageRevoked: jest.fn(),
            emitMessageEdited: jest.fn(),
            emitMessageReaction: jest.fn(),
            emitMessageAck: jest.fn(),
        };
        const engine = {};
        engines.set('s1', engine);
        const projector = new message_projector_service_1.MessageProjector(repo, { update: jest.fn().mockResolvedValue(undefined) }, engines, events, { dispatch: jest.fn().mockResolvedValue(undefined) }, hooks, {}, {});
        const echo = {
            id: 'WA1',
            chatId: '100@c.us',
            from: 'me',
            to: '100@c.us',
            body: 'Question',
            type: 'poll',
            timestamp: 1,
            fromMe: true,
            isGroup: false,
            kind: 'individual',
            poll: { name: 'Question', options: ['A', 'B'], allowMultipleAnswers: false },
        };
        Object.assign(engine, {
            sendPollMessage: async () => {
                projector.handleOwnSendEcho('s1', engine, echo);
                if (change === 'revoke')
                    projector.handleMessageRevoked('s1', engine, { ...echo, type: 'revoked', body: '' });
                if (change === 'edit')
                    projector.applyMessageEditQueued('s1', { messageId: 'WA1', body: 'fixed' });
                if (change === 'reaction')
                    projector.applyReactionQueued('s1', { messageId: 'WA1', senderId: 'peer', reaction: 'ok' });
                if (change === 'ack') {
                    projector.handleMessageAck('s1', engine, 'WA1', 'read');
                    projector.handleMessageAck('s1', engine, 'WA1', 'delivered');
                }
                await settle();
                return { id: 'WA1', timestamp: 1 };
            },
        });
        const sender = new message_send_service_1.MessageSendService(repo, { findOne: () => Promise.resolve({ phone: 'me' }) }, engines, hooks, {}, { assertSendAllowed: () => Promise.resolve(), recordSendSuccess: () => undefined });
        try {
            await sender.sendPoll('s1', { chatId: '100@c.us', name: 'Question', options: ['A', 'B'] });
            const persistedBeforeEcho = hooks.execute.mock.calls.filter(([event]) => event === 'message:persisted').length;
            releaseEcho({ continue: true, data: echo });
            for (let i = 0; i < 8; i++)
                await settle();
            const row = await repo.findOneByOrFail({ sessionId: 's1', waMessageId: 'WA1' });
            if (change === 'revoke') {
                expect(row).toMatchObject({ type: 'revoked', body: '', metadata: null });
                expect(events.emitMessageSent).not.toHaveBeenCalled();
            }
            if (change === 'edit')
                expect(row.body).toBe('fixed');
            if (change === 'reaction')
                expect(row.metadata?.reactions).toEqual({ peer: 'ok' });
            if (change === 'ack')
                expect(row.status).toBe(message_entity_1.MessageStatus.READ);
            expect(await repo.count()).toBe(1);
            // A revoke and an edit change what the stored row holds, so they hand it over again; losing the insert
            // itself does not publish a second copy.
            expect(hooks.execute.mock.calls.filter(([event]) => event === 'message:persisted')).toHaveLength(persistedBeforeEcho + (change === 'revoke' || change === 'edit' ? 1 : 0));
        }
        finally {
            await jest.advanceTimersByTimeAsync(message_projector_service_1.ACK_RECONCILE_DELAY_MS);
            jest.useRealTimers();
            engines.delete('s1');
            await ds.destroy();
        }
    });
});
