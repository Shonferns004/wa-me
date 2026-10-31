"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const label_controller_1 = require("./label.controller");
const chat_scope_service_1 = require("../auth/chat-scope.service");
describe('LabelController - GET :labelId/chats for a chat-restricted key', () => {
    const getChatsByLabel = jest.fn();
    const controller = new label_controller_1.LabelController({ getChatsByLabel }, new chat_scope_service_1.ChatScopeService());
    const chats = [{ id: '999@g.us' }, { id: '123@g.us' }, { id: '62811@c.us' }];
    beforeEach(() => getChatsByLabel.mockReset());
    it('returns only the chats inside the key allowlist', async () => {
        getChatsByLabel.mockResolvedValue(chats);
        const out = await controller.getChatsByLabel('s1', 'l1', { allowedChats: ['123@g.us'] });
        expect(getChatsByLabel).toHaveBeenCalledWith('s1', 'l1');
        expect(out).toEqual([{ id: '123@g.us' }]);
    });
    it('passes every chat through for an unrestricted key', async () => {
        getChatsByLabel.mockResolvedValue(chats);
        await expect(controller.getChatsByLabel('s1', 'l1', { allowedChats: null })).resolves.toEqual(chats);
    });
    it('lets an engine refusal through unchanged', async () => {
        getChatsByLabel.mockRejectedValue(new common_1.NotImplementedException('no label query'));
        await expect(controller.getChatsByLabel('s1', 'l1', { allowedChats: ['123@g.us'] })).rejects.toThrow(common_1.NotImplementedException);
    });
});
// Every label route reaches the engine through EngineRegistry.require(), which answers 400 for a
// session with no live engine; clients generated from the OpenAPI contract need it declared.
describe('LabelController OpenAPI error responses', () => {
    it.each([
        'findAll',
        'findOne',
        'getChatsByLabel',
        'upsertLabel',
        'deleteLabel',
        'getChatLabels',
        'addLabelToChat',
        'removeLabelFromChat',
    ])('%s declares 400', method => {
        const responses = Reflect.getMetadata('swagger/apiResponse', Object.getOwnPropertyDescriptor(label_controller_1.LabelController.prototype, method).value);
        expect(Object.keys(responses)).toContain('400');
    });
});
