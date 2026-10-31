"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const capability_router_1 = require("./capability-router");
describe('dispatchCapabilityVerb conversation.send', () => {
    it('routes conversation.send to context.conversations.send with the envelope POJO', async () => {
        const env = { type: 'text', text: 'hi', source: { provider: 'chatwoot', externalConversationId: '42' } };
        const send = jest.fn().mockResolvedValue({ id: 'm1' });
        const context = { conversations: { send } };
        const result = await (0, capability_router_1.dispatchCapabilityVerb)(context, 'conversation.send', [env]);
        expect(send).toHaveBeenCalledWith(env);
        expect(result).toEqual({ id: 'm1' });
    });
});
