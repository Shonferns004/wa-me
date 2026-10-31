"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const logger_service_1 = require("../../common/services/logger.service");
const wwebjs_message_events_1 = require("./wwebjs-message-events");
/**
 * `message.ack` reports a delivery or read receipt of a message the account sent (docs/06 and the
 * `onMessageAck` contract). whatsapp-web.js forwards every `change:ack` of the page's message store,
 * so an ack of a message the account received must stop at the adapter.
 */
function wire() {
    const client = new events_1.EventEmitter();
    const onMessageAck = jest.fn();
    const host = {
        logger: (0, logger_service_1.createLogger)('wwebjs-ack-direction.spec'),
        getCallbacks: () => ({ onMessageAck }),
    };
    (0, wwebjs_message_events_1.registerWwebjsMessageEvents)(client, host);
    return { client, onMessageAck };
}
describe('wwebjs message_ack direction', () => {
    it('forwards the ack of a message the account sent, with its chat', () => {
        const { client, onMessageAck } = wire();
        client.emit('message_ack', { id: { _serialized: 'OUT1' }, fromMe: true, from: 'me@c.us', to: '621@c.us' }, 3);
        expect(onMessageAck).toHaveBeenCalledWith('OUT1', 'read', '621@c.us');
    });
    it('does not forward an ack of a message the account received', () => {
        const { client, onMessageAck } = wire();
        client.emit('message_ack', { id: { _serialized: 'IN1' }, fromMe: false, from: '621@c.us', to: 'me@c.us' }, 3);
        expect(onMessageAck).not.toHaveBeenCalled();
    });
    it('forwards an ack whose direction cannot be read', () => {
        const { client, onMessageAck } = wire();
        client.emit('message_ack', { id: { _serialized: 'ACK2' }, from: 'me@c.us', to: '621@c.us' }, 2);
        expect(onMessageAck).toHaveBeenCalledWith('ACK2', 'delivered', expect.any(String));
    });
});
