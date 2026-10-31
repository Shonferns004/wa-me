"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const tool_invoker_1 = require("../tool-invoker");
const contact_tools_1 = require("./contact.tools");
const api_key_entity_1 = require("../../../modules/auth/entities/api-key.entity");
// Covers every contactTools execute() handler via the real invokeTool path (auth → zod → handler).
// agent-tools.module.ts is pure Nest wiring, stays at 0% coverage, and is intentionally not a target.
function makeAuth() {
    return {
        validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', allowedSessions: null }),
        hasPermission: jest.fn().mockReturnValue(true),
    };
}
function makeTools(svc) {
    return new Map((0, contact_tools_1.contactTools)(svc).map(t => [t.name, t]));
}
async function run(tool, input) {
    return (0, tool_invoker_1.invokeTool)(tool, input, 'key', makeAuth());
}
describe('contactTools', () => {
    it('ContactFindAll delegates to getContacts with paging', async () => {
        const getContacts = jest.fn().mockResolvedValue([{ id: 'c1' }]);
        const out = await run(makeTools({ getContacts }).get('ContactFindAll'), {
            sessionId: 's1',
            limit: 10,
            offset: 5,
        });
        expect(getContacts).toHaveBeenCalledWith('s1', { limit: 10, offset: 5 });
        expect(out).toEqual([{ id: 'c1' }]);
    });
    it('ContactFindOne delegates to getContactById', async () => {
        const getContactById = jest.fn().mockResolvedValue({ id: 'c1' });
        const out = await run(makeTools({ getContactById }).get('ContactFindOne'), {
            sessionId: 's1',
            contactId: '628123@c.us',
        });
        expect(getContactById).toHaveBeenCalledWith('s1', '628123@c.us');
        expect(out).toEqual({ id: 'c1' });
    });
    it('ContactCheckNumber maps a found JID to exists:true', async () => {
        const getNumberId = jest.fn().mockResolvedValue('628123@c.us');
        const out = await run(makeTools({ getNumberId }).get('ContactCheckNumber'), {
            sessionId: 's1',
            number: '628123',
        });
        expect(getNumberId).toHaveBeenCalledWith('s1', '628123');
        expect(out).toEqual({ number: '628123', exists: true, whatsappId: '628123@c.us' });
    });
    it('ContactCheckNumber maps a null JID to exists:false', async () => {
        const getNumberId = jest.fn().mockResolvedValue(null);
        const out = await run(makeTools({ getNumberId }).get('ContactCheckNumber'), {
            sessionId: 's1',
            number: '628123',
        });
        expect(out).toEqual({ number: '628123', exists: false, whatsappId: null });
    });
    it('ContactCheckNumber requires OPERATOR: a below-role key is refused before the lookup runs', async () => {
        const getNumberId = jest.fn().mockResolvedValue('628123@c.us');
        const tool = makeTools({ getNumberId }).get('ContactCheckNumber');
        expect(tool.requiredRole).toBe(api_key_entity_1.ApiKeyRole.OPERATOR);
        const auth = makeAuth();
        auth.hasPermission.mockReturnValue(false);
        await expect((0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', number: '628123' }, 'key', auth)).rejects.toBeInstanceOf(common_1.ForbiddenException);
        expect(getNumberId).not.toHaveBeenCalled();
    });
    it.each(['ContactResolvePhone', 'ContactGetProfilePicture'])('%s stays open to any valid key', name => {
        expect(makeTools({}).get(name).requiredRole).toBeUndefined();
    });
    it('ContactResolvePhone delegates to resolveContactPhone', async () => {
        const resolveContactPhone = jest.fn().mockResolvedValue('628123');
        const out = await run(makeTools({ resolveContactPhone }).get('ContactResolvePhone'), {
            sessionId: 's1',
            contactId: '12345@lid',
        });
        expect(resolveContactPhone).toHaveBeenCalledWith('s1', '12345@lid');
        expect(out).toEqual({ contactId: '12345@lid', phone: '628123' });
    });
    it('ContactGetProfilePicture maps the service result to a url field', async () => {
        const getProfilePicture = jest.fn().mockResolvedValue('https://example.com/pic.jpg');
        const out = await run(makeTools({ getProfilePicture }).get('ContactGetProfilePicture'), { sessionId: 's1', contactId: '628123@c.us' });
        expect(getProfilePicture).toHaveBeenCalledWith('s1', '628123@c.us');
        expect(out).toEqual({ url: 'https://example.com/pic.jpg' });
    });
    it('ContactBlock delegates to blockContact and reports success', async () => {
        const blockContact = jest.fn().mockResolvedValue(undefined);
        const out = await run(makeTools({ blockContact }).get('ContactBlock'), {
            sessionId: 's1',
            contactId: '628123@c.us',
        });
        expect(blockContact).toHaveBeenCalledWith('s1', '628123@c.us');
        expect(out).toEqual({ success: true, message: 'Contact blocked' });
    });
    it('ContactUnblock delegates to unblockContact and reports success', async () => {
        const unblockContact = jest.fn().mockResolvedValue(undefined);
        const out = await run(makeTools({ unblockContact }).get('ContactUnblock'), {
            sessionId: 's1',
            contactId: '628123@c.us',
        });
        expect(unblockContact).toHaveBeenCalledWith('s1', '628123@c.us');
        expect(out).toEqual({ success: true, message: 'Contact unblocked' });
    });
});
