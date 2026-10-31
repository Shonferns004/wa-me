"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const zod_1 = require("zod");
const chat_scope_service_1 = require("../../modules/auth/chat-scope.service");
const message_tools_1 = require("./tools/message.tools");
const session_tools_1 = require("./tools/session.tools");
const contact_tools_1 = require("./tools/contact.tools");
const group_tools_1 = require("./tools/group.tools");
const label_tools_1 = require("./tools/label.tools");
const tool_invoker_1 = require("./tool-invoker");
const tool_descriptor_1 = require("./tool-descriptor");
const CHAT = '628111000111@c.us';
const OTHER = '628222000222@c.us';
const key = { id: 'scoped-key', allowedSessions: ['s1'], allowedChats: [CHAT] };
const auth = {
    validateApiKey: jest.fn().mockResolvedValue(key),
    hasPermission: jest.fn().mockReturnValue(true),
};
const call = (tool, input, scope = new chat_scope_service_1.ChatScopeService()) => (0, tool_invoker_1.invokeTool)(tool, input, 'key', auth, undefined, undefined, scope);
describe('chat-restricted tool calls', () => {
    const sendText = jest.fn().mockResolvedValue({ messageId: 'm1' });
    const forward = jest.fn().mockResolvedValue({ messageId: 'm2' });
    const reply = jest.fn().mockResolvedValue({ messageId: 'm3' });
    const tools = (0, message_tools_1.messageTools)({ sendText, forward, reply });
    const tool = (name) => tools.find(t => t.name === name);
    beforeEach(() => jest.clearAllMocks());
    it('allows a send to an allowed chat through the shared invoker', async () => {
        await expect(call(tool('MessageSendText'), { sessionId: 's1', chatId: CHAT, text: 'hello' })).resolves.toEqual({
            messageId: 'm1',
        });
        expect(sendText).toHaveBeenCalledTimes(1);
    });
    it('refuses an outside destination before sending', async () => {
        await expect(call(tool('MessageSendText'), { sessionId: 's1', chatId: OTHER, text: 'hello' })).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(sendText).not.toHaveBeenCalled();
    });
    it('allows phone dialects and a persisted LID twin but refuses an unmapped LID', async () => {
        const scope = new chat_scope_service_1.ChatScopeService({
            findPhoneForLid: jest.fn(lid => Promise.resolve(lid === '123456' ? '628111000111' : undefined)),
            findLidsForPhone: jest.fn().mockResolvedValue(['123456']),
        });
        for (const chatId of ['628111000111@s.whatsapp.net', '123456@lid']) {
            await call(tool('MessageSendText'), { sessionId: 's1', chatId, text: 'hello' }, scope);
        }
        await expect(call(tool('MessageSendText'), { sessionId: 's1', chatId: '654321@lid', text: 'hello' }, scope)).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(sendText).toHaveBeenCalledTimes(2);
    });
    it('fails closed without the scope service or with an unmarked tool', async () => {
        await expect((0, tool_invoker_1.invokeTool)(tool('MessageSendText'), { sessionId: 's1', chatId: CHAT, text: 'hello' }, 'key', auth)).rejects.toBeInstanceOf(common_1.ForbiddenException);
        const descriptor = (0, session_tools_1.sessionTools)({}).find(t => t.name === 'SessionGetStats');
        await expect(call(descriptor, {})).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(sendText).not.toHaveBeenCalled();
    });
    it('refuses a tool declared with an empty chat scope and never calls its handler', async () => {
        const handler = jest.fn();
        const descriptor = (0, tool_descriptor_1.defineTool)({
            name: 'AccountWideByMistake',
            description: 'Declares a chat scope that names no chat field',
            tier: 'read',
            chatScope: [],
            inputSchema: zod_1.z.object({}),
            handler,
        });
        await expect(call(descriptor, {})).rejects.toThrow(new common_1.ForbiddenException('API key is restricted to selected chats'));
        expect(handler).not.toHaveBeenCalled();
    });
    it('authorizes the parsed destination and records a scope refusal before the handler', async () => {
        const handler = jest.fn();
        const rejected = jest.fn();
        const descriptor = (0, tool_descriptor_1.defineTool)({
            name: 'NormalizedDestination',
            description: 'Send to a normalized destination',
            tier: 'write',
            chatScope: ['chatId'],
            inputSchema: zod_1.z.object({ chatId: zod_1.z.string().transform(() => OTHER) }),
            handler,
        });
        await expect((0, tool_invoker_1.invokeTool)(descriptor, { chatId: CHAT }, 'key', auth, undefined, rejected, new chat_scope_service_1.ChatScopeService())).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(handler).not.toHaveBeenCalled();
        expect(rejected).toHaveBeenCalledWith(expect.any(common_1.ForbiddenException));
    });
    it.each([
        { fromChatId: OTHER, toChatId: CHAT },
        { fromChatId: CHAT, toChatId: OTHER },
    ])('fences both endpoints of a forward: %j', async (endpoints) => {
        await expect(call(tool('MessageForward'), { sessionId: 's1', messageId: 'm1', ...endpoints })).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(forward).not.toHaveBeenCalled();
    });
    it('allows forwarding when both endpoints are inside the allowlist', async () => {
        await expect(call(tool('MessageForward'), { sessionId: 's1', fromChatId: CHAT, toChatId: CHAT, messageId: 'm1' })).resolves.toEqual({ messageId: 'm2' });
    });
    it('refuses ordinary send quotes but permits a reply bound to its allowed chat', async () => {
        const input = { sessionId: 's1', chatId: CHAT, text: 'hello', quotedMessageId: 'quoted' };
        await expect(call(tool('MessageSendText'), input)).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(sendText).not.toHaveBeenCalled();
        await expect(call(tool('MessageReply'), input)).resolves.toEqual({ messageId: 'm3' });
    });
    it('requires a chat for message listing even when its schema makes chatId optional', async () => {
        await expect(call(tool('MessageList'), { sessionId: 's1' })).rejects.toBeInstanceOf(common_1.ForbiddenException);
    });
    it('filters the complete chat list before applying the requested page', async () => {
        const chats = [{ id: OTHER }, { id: CHAT }];
        const listChats = jest.fn().mockResolvedValue(chats);
        const getChats = jest.fn().mockResolvedValue(chats.slice(0, 1));
        const descriptor = (0, session_tools_1.sessionTools)({ listChats, getChats }).find(t => t.name === 'SessionGetChats');
        await expect(call(descriptor, { sessionId: 's1', limit: 1 })).resolves.toEqual([{ id: CHAT }]);
        expect(listChats).toHaveBeenCalledWith('s1', undefined);
        expect(getChats).not.toHaveBeenCalled();
    });
    it.each(['ContactFindAll', 'GroupFindAll'])('filters %s beyond the first thousand rows before pagination', async (name) => {
        const allowed = [{ id: CHAT }, { id: CHAT, name: 'second' }];
        const all = [...Array.from({ length: 1001 }, () => ({ id: OTHER })), ...allowed];
        const list = jest.fn().mockResolvedValue(all);
        const paged = jest.fn();
        const descriptors = name === 'ContactFindAll'
            ? (0, contact_tools_1.contactTools)({ listContacts: list, getContacts: paged })
            : (0, group_tools_1.groupTools)({ listGroups: list, getGroups: paged });
        await expect(call(descriptors.find(t => t.name === name), { sessionId: 's1', limit: 1, offset: 1 })).resolves.toEqual([allowed[1]]);
        // The contact listing takes the offset too, so the later pages of a walk share one engine read.
        expect(list).toHaveBeenCalledWith(...(name === 'ContactFindAll' ? ['s1', 1] : ['s1']));
        expect(paged).not.toHaveBeenCalled();
    });
    it('filters label chat membership', async () => {
        const descriptor = (0, label_tools_1.labelTools)({
            getChatsByLabel: jest.fn().mockResolvedValue([{ id: OTHER }, { id: CHAT }]),
        }).find(t => t.name === 'LabelListChats');
        await expect(call(descriptor, { sessionId: 's1', labelId: '1' })).resolves.toEqual([{ id: CHAT }]);
    });
});
