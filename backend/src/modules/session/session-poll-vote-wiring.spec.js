"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_engine_event_wiring_1 = require("./session-engine-event-wiring");
const logger_service_1 = require("../../common/services/logger.service");
describe('poll.vote wiring', () => {
    const vote = {
        pollMessageId: 'true_51987654321@c.us_POLL1',
        chatId: '51987654321@c.us',
        voterId: '51987654321@c.us',
        selectedOptions: ['Done'],
        pollName: 'Did you finish the report?',
        timestamp: 1786000000,
        timestampMs: 1786000000123,
    };
    const setup = (live) => {
        const dispatch = jest.fn();
        const emitPollVote = jest.fn();
        const host = {
            isLiveEngine: () => live,
            messages: {},
            webhookService: { dispatch },
            eventsGateway: { emitPollVote },
        };
        const cb = new session_engine_event_wiring_1.SessionEngineEventWiring({ logger: (0, logger_service_1.createLogger)('test') }).buildCallbacks('sess-1', {}, 'sess-1-name', host);
        return { cb, dispatch, emitPollVote };
    };
    it('publishes the vote with its session to the webhook and the WebSocket', () => {
        const { cb, dispatch, emitPollVote } = setup(true);
        cb.onPollVote?.(vote);
        const payload = { sessionId: 'sess-1', ...vote };
        expect(dispatch).toHaveBeenCalledWith('sess-1', 'poll.vote', payload);
        expect(emitPollVote).toHaveBeenCalledWith('sess-1', payload);
    });
    it('publishes a cleared vote too: an empty selection is news', () => {
        const { cb, dispatch } = setup(true);
        cb.onPollVote?.({ ...vote, selectedOptions: [] });
        expect(dispatch).toHaveBeenCalledWith('sess-1', 'poll.vote', expect.objectContaining({ selectedOptions: [] }));
    });
    it('publishes nothing for a vote without a poll message id', () => {
        const { cb, dispatch, emitPollVote } = setup(true);
        cb.onPollVote?.({ ...vote, pollMessageId: '' });
        expect(dispatch).not.toHaveBeenCalled();
        expect(emitPollVote).not.toHaveBeenCalled();
    });
    it('publishes nothing from an engine that is no longer live', () => {
        const { cb, dispatch, emitPollVote } = setup(false);
        cb.onPollVote?.(vote);
        expect(dispatch).not.toHaveBeenCalled();
        expect(emitPollVote).not.toHaveBeenCalled();
    });
});
