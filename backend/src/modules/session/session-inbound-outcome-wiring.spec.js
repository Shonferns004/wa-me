"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_engine_event_wiring_1 = require("./session-engine-event-wiring");
const logger_service_1 = require("../../common/services/logger.service");
describe('onMessage wiring', () => {
    const message = { id: 'M1', chatId: '628111@c.us', body: 'hi' };
    const setup = (answer) => {
        const engine = {};
        const handleInboundMessage = jest.fn(() => answer);
        const host = { isLiveEngine: () => true, messages: { handleInboundMessage } };
        const callbacks = new session_engine_event_wiring_1.SessionEngineEventWiring({ logger: (0, logger_service_1.createLogger)('test') }).buildCallbacks('sess-1', engine, 'sess-1-name', host);
        return { callbacks, engine, handleInboundMessage };
    };
    it('answers the engine with the receipt the projector gave for the message', () => {
        const receipt = { settled: Promise.resolve({ conflict: true }) };
        const { callbacks, engine, handleInboundMessage } = setup(receipt);
        const returned = callbacks.onMessage?.(message);
        expect(returned).toBe(receipt);
        expect(handleInboundMessage).toHaveBeenCalledWith('sess-1', engine, message, undefined);
    });
    it('answers nothing when the projector commits nothing', () => {
        const { callbacks } = setup(undefined);
        expect(callbacks.onMessage?.(message)).toBeUndefined();
    });
});
