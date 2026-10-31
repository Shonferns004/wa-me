"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const app_validation_1 = require("../../config/app-validation");
const api_key_dto_1 = require("../../modules/auth/dto/api-key.dto");
const automation_rule_dto_1 = require("../../modules/automation/dto/automation-rule.dto");
const create_session_dto_1 = require("../../modules/session/dto/create-session.dto");
const session_proxy_dto_1 = require("../../modules/session/dto/session-proxy.dto");
const webhook_dto_1 = require("../../modules/webhook/dto/webhook.dto");
// Each field lands in a varchar(n) column, which PostgreSQL counts in code points. @MaxLength folds a
// presentation selector (U+FE0F) into the character before it, so a value of up to 2n code points
// passed validation and the INSERT failed as a 500.
describe('varchar-backed fields are bounded in code points', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const emoji = '✔️';
    const url = 'https://example.com/';
    const proxy = (pad) => `http://user:${pad}@proxy.example.com:8080`;
    it.each([
        ['automation rule create name', automation_rule_dto_1.CreateAutomationRuleDto, { replyText: 'hi' }, 'name', 100, (p) => p],
        ['automation rule update name', automation_rule_dto_1.UpdateAutomationRuleDto, {}, 'name', 100, (p) => p],
        ['API key create name', api_key_dto_1.CreateApiKeyDto, {}, 'name', 100, (p) => p],
        ['API key update name', api_key_dto_1.UpdateApiKeyDto, {}, 'name', 100, (p) => p],
        ['webhook create secret', webhook_dto_1.CreateWebhookDto, { url }, 'secret', 255, (p) => p],
        ['webhook update secret', webhook_dto_1.UpdateWebhookDto, {}, 'secret', 255, (p) => p],
        ['webhook create url', webhook_dto_1.CreateWebhookDto, {}, 'url', 2048 - url.length, (p) => url + p],
        ['webhook update url', webhook_dto_1.UpdateWebhookDto, {}, 'url', 2048 - url.length, (p) => url + p],
        ['session create proxyUrl', create_session_dto_1.CreateSessionDto, { name: 'bot' }, 'proxyUrl', 255 - proxy('').length, proxy],
        ['session proxy update proxyUrl', session_proxy_dto_1.UpdateSessionProxyDto, {}, 'proxyUrl', 255 - proxy('').length, proxy],
    ])('%s', async (_label, metatype, rest, field, room, wrap) => {
        const through = (pad) => pipe.transform({ ...rest, [field]: wrap(pad) }, { type: 'body', metatype });
        const half = Math.floor(room / 2);
        await expect(through(emoji.repeat(half + 1))).rejects.toBeInstanceOf(common_1.BadRequestException);
        await expect(through(emoji.repeat(half))).resolves.toMatchObject({ [field]: wrap(emoji.repeat(half)) });
        await expect(through('a'.repeat(room))).resolves.toMatchObject({ [field]: wrap('a'.repeat(room)) });
        await expect(through('a'.repeat(room + 1))).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    it('counts an astral character once, not as the two UTF-16 units it takes', async () => {
        const robot = String.fromCodePoint(0x1f916);
        const through = (name) => pipe.transform({ replyText: 'hi', name }, { type: 'body', metatype: automation_rule_dto_1.CreateAutomationRuleDto });
        await expect(through(robot.repeat(100))).resolves.toMatchObject({ name: robot.repeat(100) });
        await expect(through(robot.repeat(101))).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
});
