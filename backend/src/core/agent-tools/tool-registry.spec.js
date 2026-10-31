"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tools_1 = require("./tools");
const tool_registry_service_1 = require("./tool-registry.service");
const zod_1 = require("zod");
const r = {
    name: 'R',
    description: 'd',
    tier: 'read',
    inputSchema: zod_1.z.object({}),
    handler: () => Promise.resolve(1),
};
const w = {
    name: 'W',
    description: 'd',
    tier: 'write',
    inputSchema: zod_1.z.object({}),
    handler: () => Promise.resolve(1),
};
describe('ToolRegistryService', () => {
    it('throws on duplicate tool names', () => {
        expect(() => new tool_registry_service_1.ToolRegistryService([r, r])).toThrow(/duplicate/i);
    });
    it('list() returns all; list({readOnly}) returns only read tools', () => {
        const reg = new tool_registry_service_1.ToolRegistryService([r, w]);
        expect(reg
            .list()
            .map(t => t.name)
            .sort()).toEqual(['R', 'W']);
        expect(reg.list({ readOnly: true }).map(t => t.name)).toEqual(['R']);
    });
    it('get() resolves by name', () => {
        expect(new tool_registry_service_1.ToolRegistryService([r]).get('R')).toBe(r);
    });
});
describe('v1 tool surface snapshot', () => {
    it('exposes exactly the v1 tool surface (locks the agent contract)', () => {
        const expected = [
            'SessionFindAll',
            'SessionFindOne',
            'SessionGetChats',
            'SessionGetStats',
            'SessionSubscribePresence',
            'SessionGetPresence',
            'SessionMarkChatRead',
            'SessionMarkChatUnread',
            'SessionSendChatState',
            'MessageList',
            'MessageHistory',
            'MessageGetReactions',
            'MessageSearch',
            'MessageSendText',
            'MessageSendImage',
            'MessageSendVideo',
            'MessageSendAudio',
            'MessageSendDocument',
            'MessageSendLocation',
            'MessageSendContact',
            'MessageSendSticker',
            'MessageSendTemplate',
            'MessageReply',
            'MessageForward',
            'MessageReact',
            'ContactFindAll',
            'ContactFindOne',
            'ContactCheckNumber',
            'ContactResolvePhone',
            'ContactGetProfilePicture',
            'ContactBlock',
            'ContactUnblock',
            'GroupFindAll',
            'GroupFindOne',
            'GroupGetInviteCode',
            'GroupCreate',
            'GroupAddParticipants',
            'GroupSetSubject',
            'GroupSetDescription',
            'WebhooksList',
            'WebhookFindBySession',
            'WebhookFindOne',
            'LabelFindAll',
            'LabelFindOne',
            'LabelListChats',
            'LabelListForChat',
            'LabelUpsert',
            'LabelDelete',
            'LabelAddToChat',
            'LabelRemoveFromChat',
            'AutomationRuleFindAll',
            'AutomationRuleFindOne',
        ].sort();
        const actualNames = [...(0, tools_1.allAgentTools)({})].map(t => t.name).sort();
        expect(actualNames).toEqual(expected);
        expect(expected).toHaveLength(52);
    });
});
