"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const logger_service_1 = require("../../common/services/logger.service");
const wwebjs_message_events_1 = require("./wwebjs-message-events");
/**
 * whatsapp-web.js stamps an own message in a LID chat (and in a LID-addressing-mode group) with
 * `from` = the account's own LID, while the account wid is the phone dialect. The chat of a revoked
 * message therefore follows the direction flag, as `Message._getChatId` does, not a comparison of
 * `from` against the account wid.
 */
function wire() {
    const client = new events_1.EventEmitter();
    const onMessageRevoked = jest.fn();
    const host = {
        logger: (0, logger_service_1.createLogger)('wwebjs-revoke-chat-id.spec'),
        getCallbacks: () => ({ onMessageRevoked }),
    };
    (0, wwebjs_message_events_1.registerWwebjsMessageEvents)(client, host);
    return { client, onMessageRevoked };
}
describe('wwebjs message_revoke_everyone chatId', () => {
    it('reports the peer when the account revokes its own message in a LID chat', () => {
        const { client, onMessageRevoked } = wire();
        client.emit('message_revoke_everyone', {
            id: { _serialized: 'R', fromMe: true },
            fromMe: true,
            from: '777000@lid',
            to: '99999@lid',
            timestamp: 1,
        });
        expect(onMessageRevoked).toHaveBeenCalledWith(expect.objectContaining({ chatId: '99999@lid' }));
    });
    it('reports the group when a member revokes a message there', () => {
        const { client, onMessageRevoked } = wire();
        client.emit('message_revoke_everyone', {
            id: { _serialized: 'R2', fromMe: false },
            fromMe: false,
            from: '120363000@g.us',
            to: '628111@c.us',
            timestamp: 2,
        });
        expect(onMessageRevoked).toHaveBeenCalledWith(expect.objectContaining({ chatId: '120363000@g.us' }));
    });
});
