"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const automation_rule_dto_1 = require("./automation-rule.dto");
const app_validation_1 = require("../../../config/app-validation");
describe('UpdateAutomationRuleDto', () => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const through = (value) => pipe.transform(value, { type: 'body', metatype: automation_rule_dto_1.UpdateAutomationRuleDto });
    // These four columns are NOT NULL: a null that got past validation reached save() and answered 500.
    it.each(['name', 'replyText', 'cooldownSeconds', 'enabled'])('rejects %s: null with a 400', async (key) => {
        await expect(through({ [key]: null })).rejects.toBeInstanceOf(common_1.BadRequestException);
    });
    it('still accepts an empty body and conditions: null, which clears the conditions', async () => {
        await expect(through({})).resolves.toEqual({});
        await expect(through({ conditions: null })).resolves.toEqual({ conditions: null });
    });
});
// PostgreSQL text and varchar columns cannot store U+0000; a NUL that got past validation failed the
// write with a 500.
describe.each([
    ['CreateAutomationRuleDto', automation_rule_dto_1.CreateAutomationRuleDto],
    ['UpdateAutomationRuleDto', automation_rule_dto_1.UpdateAutomationRuleDto],
])('%s NUL characters', (_name, metatype) => {
    const pipe = new common_1.ValidationPipe(app_validation_1.GLOBAL_VALIDATION_OPTIONS);
    const valid = { name: 'greeting', replyText: 'hi there' };
    it.each(['name', 'replyText'])('rejects a NUL in %s with a 400', async (key) => {
        await expect(pipe.transform({ ...valid, [key]: 'a\u0000b' }, { type: 'body', metatype })).rejects.toBeInstanceOf(common_1.BadRequestException);
        await expect(pipe.transform(valid, { type: 'body', metatype })).resolves.toEqual(valid);
    });
});
