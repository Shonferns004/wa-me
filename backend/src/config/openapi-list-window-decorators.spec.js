"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const swagger_1 = require("@nestjs/swagger");
const audit_controller_1 = require("../modules/audit/audit.controller");
const channel_controller_1 = require("../modules/channel/channel.controller");
const message_controller_1 = require("../modules/message/message.controller");
/**
 * These handlers read `limit` and `offset` with parseInt, so the parameters are integer counts. Published as
 * `number`, a generated Go or Java client types them as floating point.
 */
describe('list routes publish limit and offset as integers', () => {
    const typeOf = (handler, name) => Reflect.getMetadata(swagger_1.DECORATORS.API_PARAMETERS, handler).find(p => p.name === name)?.type;
    /* eslint-disable @typescript-eslint/unbound-method -- reading route metadata, not invoking */
    it.each([
        ['GET /api/audit', audit_controller_1.AuditController.prototype.findAll, ['limit', 'offset']],
        ['GET /sessions/{sessionId}/messages', message_controller_1.MessageController.prototype.getMessages, ['limit', 'offset']],
        ['GET /sessions/{sessionId}/messages/{chatId}/history', message_controller_1.MessageController.prototype.getChatHistory, ['limit']],
        ['GET /sessions/{sessionId}/channels/{channelId}/messages', channel_controller_1.ChannelController.prototype.getMessages, ['limit']],
    ])('%s', (_route, handler, names) => {
        for (const name of names)
            expect([name, typeOf(handler, name)]).toEqual([name, 'integer']);
    });
    /* eslint-enable @typescript-eslint/unbound-method */
});
