"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const tool_invoker_1 = require("../tool-invoker");
const group_tools_1 = require("./group.tools");
const api_key_entity_1 = require("../../../modules/auth/entities/api-key.entity");
function makeAuth() {
    return {
        validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
        hasPermission: jest.fn().mockReturnValue(true),
    };
}
describe('GroupAddParticipants', () => {
    it('returns the engine per-participant results instead of a blanket success', async () => {
        const results = [
            { id: '628111@c.us', success: true, status: 200 },
            { id: '628222@c.us', success: false, status: 403, message: 'invite-only' },
        ];
        const addParticipants = jest.fn().mockResolvedValue(results);
        const groupSvc = { addParticipants };
        const tool = (0, group_tools_1.groupTools)(groupSvc).find(t => t.name === 'GroupAddParticipants');
        const out = (await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us', participants: ['628111@c.us', '628222@c.us'] }, 'key', makeAuth()));
        expect(addParticipants).toHaveBeenCalledWith('s1', '120363@g.us', ['628111@c.us', '628222@c.us']);
        // Partial batch: success stays true (one did join) but the message must not claim a clean run.
        expect(out.success).toBe(true);
        expect(out.message).toContain('1/2');
        expect(out.results).toEqual(results);
    });
    it('reports failure when every participant was refused', async () => {
        // An agent reading only the top-level fields was previously told "Participants added" even when
        // nothing happened.
        const results = [
            { id: '628111@c.us', success: false, status: 404, message: 'not registered' },
            { id: '628222@c.us', success: false, status: 409, message: 'already a member' },
        ];
        const groupSvc = { addParticipants: jest.fn().mockResolvedValue(results) };
        const tool = (0, group_tools_1.groupTools)(groupSvc).find(t => t.name === 'GroupAddParticipants');
        const out = (await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us', participants: ['628111@c.us', '628222@c.us'] }, 'key', makeAuth()));
        expect(out.success).toBe(false);
        expect(out.message).toContain('0/2');
    });
    it('reports a clean success when every participant joined', async () => {
        const results = [{ id: '628111@c.us', success: true, status: 200 }];
        const groupSvc = { addParticipants: jest.fn().mockResolvedValue(results) };
        const tool = (0, group_tools_1.groupTools)(groupSvc).find(t => t.name === 'GroupAddParticipants');
        const out = (await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us', participants: ['628111@c.us'] }, 'key', makeAuth()));
        expect(out).toEqual({ success: true, message: 'Participants added', results });
    });
});
describe('groupTools execute handlers', () => {
    it('GroupFindAll delegates to getGroups with paging', async () => {
        const getGroups = jest.fn().mockResolvedValue([{ id: 'g1' }]);
        const tool = (0, group_tools_1.groupTools)({ getGroups }).find(t => t.name === 'GroupFindAll');
        const out = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', limit: 10, offset: 5 }, 'key', makeAuth());
        expect(getGroups).toHaveBeenCalledWith('s1', { limit: 10, offset: 5 });
        expect(out).toEqual([{ id: 'g1' }]);
    });
    it('GroupFindOne delegates to getGroupInfo', async () => {
        const getGroupInfo = jest.fn().mockResolvedValue({ id: 'g1' });
        const tool = (0, group_tools_1.groupTools)({ getGroupInfo }).find(t => t.name === 'GroupFindOne');
        const out = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us' }, 'key', makeAuth());
        expect(getGroupInfo).toHaveBeenCalledWith('s1', '120363@g.us');
        expect(out).toEqual({ id: 'g1' });
    });
    it('GroupGetInviteCode maps the code to code + link', async () => {
        const getGroupInviteCode = jest.fn().mockResolvedValue('abc123');
        const tool = (0, group_tools_1.groupTools)({ getGroupInviteCode }).find(t => t.name === 'GroupGetInviteCode');
        const out = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us' }, 'key', makeAuth());
        expect(getGroupInviteCode).toHaveBeenCalledWith('s1', '120363@g.us');
        expect(out).toEqual({ inviteCode: 'abc123', inviteLink: 'https://chat.whatsapp.com/abc123' });
    });
    it('GroupGetInviteCode requires OPERATOR: a below-role key is refused before the service is called', async () => {
        // The invite code is a transferable join capability, so this read is gated at OPERATOR even
        // though the tool stays tier: 'read' (the tier says the call mutates nothing, not who may
        // extract a credential).
        const getGroupInviteCode = jest.fn().mockResolvedValue('abc123');
        const tool = (0, group_tools_1.groupTools)({ getGroupInviteCode }).find(t => t.name === 'GroupGetInviteCode');
        expect(tool.requiredRole).toBe(api_key_entity_1.ApiKeyRole.OPERATOR);
        const auth = makeAuth();
        auth.hasPermission.mockReturnValue(false);
        await expect((0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us' }, 'key', auth)).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(getGroupInviteCode).not.toHaveBeenCalled();
    });
    it('GroupCreate delegates to createGroup', async () => {
        const createGroup = jest.fn().mockResolvedValue({ id: 'g1' });
        const tool = (0, group_tools_1.groupTools)({ createGroup }).find(t => t.name === 'GroupCreate');
        const out = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', name: 'New group', participants: ['628111@c.us'] }, 'key', makeAuth());
        expect(createGroup).toHaveBeenCalledWith('s1', 'New group', ['628111@c.us']);
        expect(out).toEqual({ id: 'g1' });
    });
    it('GroupSetSubject delegates to setGroupSubject and reports success', async () => {
        const setGroupSubject = jest.fn().mockResolvedValue(undefined);
        const tool = (0, group_tools_1.groupTools)({ setGroupSubject }).find(t => t.name === 'GroupSetSubject');
        const out = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us', subject: 'Renamed' }, 'key', makeAuth());
        expect(setGroupSubject).toHaveBeenCalledWith('s1', '120363@g.us', 'Renamed');
        expect(out).toEqual({ success: true, message: 'Group subject updated' });
    });
    it('GroupSetDescription delegates to setGroupDescription and reports success', async () => {
        const setGroupDescription = jest.fn().mockResolvedValue(undefined);
        const tool = (0, group_tools_1.groupTools)({ setGroupDescription }).find(t => t.name === 'GroupSetDescription');
        const out = await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', groupId: '120363@g.us', description: 'About us' }, 'key', makeAuth());
        expect(setGroupDescription).toHaveBeenCalledWith('s1', '120363@g.us', 'About us');
        expect(out).toEqual({ success: true, message: 'Group description updated' });
    });
});
