"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const app_validation_1 = require("../../../config/app-validation");
const send_chat_state_dto_1 = require("./send-chat-state.dto");
// The indicator the typing route sends is one of the three ChatState words. Anything else, `composing`
// (the word a presence report uses) included, would reach the engines as a state they do not know.
describe('SendChatStateDto state', () => {
    const failing = async (body) => (await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(send_chat_state_dto_1.SendChatStateDto, { chatId: '1234567890@c.us', ...body }, app_validation_1.GLOBAL_VALIDATION_OPTIONS.transformOptions), app_validation_1.GLOBAL_VALIDATION_OPTIONS)).map(error => error.property);
    it.each(['typing', 'recording', 'paused'])('accepts %s', async (state) => {
        expect(await failing({ state })).toEqual([]);
    });
    it.each([
        ['composing', 'composing'],
        ['available', 'available'],
        ['a different case', 'TYPING'],
        ['an empty string', ''],
        ['a number', 1],
        ['null', null],
    ])('rejects %s', async (_label, state) => {
        expect(await failing({ state })).toEqual(['state']);
    });
    it('rejects a missing state', async () => {
        expect(await failing({})).toEqual(['state']);
    });
    it('rejects a missing chatId', async () => {
        const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(send_chat_state_dto_1.SendChatStateDto, { state: 'typing' }, app_validation_1.GLOBAL_VALIDATION_OPTIONS.transformOptions), app_validation_1.GLOBAL_VALIDATION_OPTIONS);
        expect(errors.map(error => error.property)).toEqual(['chatId']);
    });
});
