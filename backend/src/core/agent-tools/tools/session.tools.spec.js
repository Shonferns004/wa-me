"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const tool_invoker_1 = require("../tool-invoker");
const session_tools_1 = require("./session.tools");
// Covers every sessionTools execute() handler via the real invokeTool path (auth → zod → handler).
// agent-tools.module.ts is pure Nest wiring, stays at 0% coverage, and is intentionally not a target.
function makeAuth() {
    return {
        validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
        hasPermission: jest.fn().mockReturnValue(true),
    };
}
function makeTools(svc) {
    return new Map((0, session_tools_1.sessionTools)(svc).map(t => [t.name, t]));
}
async function run(tool, input) {
    return (0, tool_invoker_1.invokeTool)(tool, input, 'key', makeAuth());
}
describe('sessionTools', () => {
    // engineLoaded, not isActive: a session a live peer node runs has no engine in this process, and
    // an MCP call is never forwarded to the owner, so isActive would report it as stopped.
    it('SessionFindAll scopes by the key allowedSessions and maps entities to DTOs', async () => {
        const row = { id: 's1', name: 'main', status: 'ready' };
        const findAll = jest.fn().mockResolvedValue([row]);
        const isActive = jest.fn().mockReturnValue(false);
        const engineLoaded = jest.fn().mockReturnValue(true);
        const out = (await run(makeTools({ findAll, isActive, engineLoaded }).get('SessionFindAll'), { limit: 5 }));
        expect(findAll).toHaveBeenCalledWith(null, { limit: 5, offset: undefined });
        expect(engineLoaded).toHaveBeenCalledWith(row);
        expect(out).toEqual([expect.objectContaining({ id: 's1', engineLoaded: true })]);
    });
    it('SessionFindAll forwards the name filter together with a scoped key allowlist', async () => {
        const findAll = jest.fn().mockResolvedValue([]);
        const auth = { ...makeAuth(), validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: ['s1'] }) };
        const tool = makeTools({ findAll, isActive: jest.fn() }).get('SessionFindAll');
        await expect((0, tool_invoker_1.invokeTool)(tool, { name: 'other-bot' }, 'key', auth)).resolves.toEqual([]);
        expect(findAll).toHaveBeenCalledWith(['s1'], { limit: undefined, offset: undefined, name: 'other-bot' });
    });
    it('SessionFindAll rejects an empty name before reaching the service', async () => {
        const findAll = jest.fn();
        const tool = makeTools({ findAll }).get('SessionFindAll');
        await expect(run(tool, { name: '' })).rejects.toThrow();
        expect(findAll).not.toHaveBeenCalled();
    });
    it('SessionFindOne delegates to findOne and maps to the response DTO', async () => {
        const row = { id: 's1', name: 'main', status: 'ready' };
        const findOne = jest.fn().mockResolvedValue(row);
        const isActive = jest.fn().mockReturnValue(false);
        const engineLoaded = jest.fn().mockReturnValue(true);
        const out = (await run(makeTools({ findOne, isActive, engineLoaded }).get('SessionFindOne'), { sessionId: 's1' }));
        expect(findOne).toHaveBeenCalledWith('s1');
        expect(engineLoaded).toHaveBeenCalledWith(row);
        expect(out.id).toBe('s1');
        expect(out.engineLoaded).toBe(true);
    });
    it('SessionGetChats delegates to getChats with paging', async () => {
        const getChats = jest.fn().mockResolvedValue([{ id: 'c1' }]);
        const out = await run(makeTools({ getChats }).get('SessionGetChats'), {
            sessionId: 's1',
            limit: 20,
            offset: 10,
        });
        expect(getChats).toHaveBeenCalledWith('s1', { limit: 20, offset: 10 });
        expect(out).toEqual([{ id: 'c1' }]);
    });
    it('SessionGetStats scopes by the key allowedSessions', async () => {
        const stats = { total: 2, active: 1, ready: 1, disconnected: 1 };
        const getStats = jest.fn().mockResolvedValue(stats);
        const out = await run(makeTools({ getStats }).get('SessionGetStats'), {});
        expect(getStats).toHaveBeenCalledWith(null);
        expect(out).toEqual(stats);
    });
    it('SessionSubscribePresence delegates to subscribeToPresence and reports success', async () => {
        const subscribeToPresence = jest.fn().mockResolvedValue(undefined);
        const out = await run(makeTools({ subscribeToPresence }).get('SessionSubscribePresence'), { sessionId: 's1', chatId: '628111@c.us' });
        expect(subscribeToPresence).toHaveBeenCalledWith('s1', '628111@c.us');
        expect(out).toEqual({ success: true });
    });
    it('SessionGetPresence delegates to getPresence and passes the result through', async () => {
        const getPresence = jest.fn().mockResolvedValue({ presence: 'online' });
        const out = await run(makeTools({ getPresence }).get('SessionGetPresence'), {
            sessionId: 's1',
            chatId: '628111@c.us',
        });
        expect(getPresence).toHaveBeenCalledWith('s1', '628111@c.us');
        expect(out).toEqual({ presence: 'online' });
    });
    it('SessionMarkChatRead maps the sendSeen result to a success field', async () => {
        const sendSeen = jest.fn().mockResolvedValue(true);
        const out = await run(makeTools({ sendSeen }).get('SessionMarkChatRead'), {
            sessionId: 's1',
            chatId: '628111@c.us',
        });
        expect(sendSeen).toHaveBeenCalledWith('s1', '628111@c.us', undefined);
        expect(out).toEqual({ success: true });
    });
    it('SessionMarkChatRead forwards the message ids it was given', async () => {
        const sendSeen = jest.fn().mockResolvedValue(true);
        await run(makeTools({ sendSeen }).get('SessionMarkChatRead'), {
            sessionId: 's1',
            chatId: '628111@c.us',
            messageIds: ['M1', 'M2'],
        });
        expect(sendSeen).toHaveBeenCalledWith('s1', '628111@c.us', ['M1', 'M2']);
    });
    // The REST body rejects a whitespace-only id, and this path never sees that DTO: invokeTool parses
    // the tool's own schema and calls the service directly, so an id the schema accepts is sent as a
    // receipt key. Asserting the service was not reached is the point; a 400 that still delegated
    // would leave the defect in place.
    it('SessionMarkChatRead refuses a whitespace-only message id instead of sending it as a key', async () => {
        const sendSeen = jest.fn().mockResolvedValue(true);
        const tool = makeTools({ sendSeen }).get('SessionMarkChatRead');
        const failure = await run(tool, { sessionId: 's1', chatId: '628111@c.us', messageIds: ['  '] }).catch((e) => e);
        expect(failure).toBeInstanceOf(common_1.BadRequestException);
        expect(JSON.stringify(failure.getResponse())).toContain('no whitespace');
        expect(sendSeen).not.toHaveBeenCalled();
        // Control: a well-formed id still reaches the service, so the refusal above is this rule and not
        // a schema that turns everything away.
        await run(tool, { sessionId: 's1', chatId: '628111@c.us', messageIds: ['3EB0C767D26B8A3F1A2B'] });
        expect(sendSeen).toHaveBeenCalledWith('s1', '628111@c.us', ['3EB0C767D26B8A3F1A2B']);
    });
    it('SessionMarkChatUnread maps the markUnread result to a success field', async () => {
        const markUnread = jest.fn().mockResolvedValue(true);
        const out = await run(makeTools({ markUnread }).get('SessionMarkChatUnread'), {
            sessionId: 's1',
            chatId: '628111@c.us',
        });
        expect(markUnread).toHaveBeenCalledWith('s1', '628111@c.us');
        expect(out).toEqual({ success: true });
    });
    it('SessionSendChatState delegates to sendChatState and reports success', async () => {
        const sendChatState = jest.fn().mockResolvedValue(undefined);
        const out = await run(makeTools({ sendChatState }).get('SessionSendChatState'), {
            sessionId: 's1',
            chatId: '628111@c.us',
            state: 'typing',
        });
        expect(sendChatState).toHaveBeenCalledWith('s1', '628111@c.us', 'typing');
        expect(out).toEqual({ success: true });
    });
});
