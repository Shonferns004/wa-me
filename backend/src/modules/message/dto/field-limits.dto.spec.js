"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const app_validation_1 = require("../../../config/app-validation");
const send_message_dto_1 = require("./send-message.dto");
const message_actions_dto_1 = require("./message-actions.dto");
// docs/06 and the published OpenAPI schema state these limits, and the DTO decorators enforce them, with
// nothing tying the two together: @nestjs/swagger derives no bound from a validator, so a literal in
// @ApiProperty and a constant in @MaxLength can part without any other check noticing. This table holds
// the validator side to the documented numbers. The limits are written out as literals on purpose: a
// spec that read the DTO's own constant would move with a change to it and keep passing.
const validateDto = (cls, obj) => (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(cls, obj, app_validation_1.GLOBAL_VALIDATION_OPTIONS.transformOptions), app_validation_1.GLOBAL_VALIDATION_OPTIONS);
const CHAT = '628123456789@c.us';
const text = (length) => 'x'.repeat(length);
const PREVIEW = { url: 'https://example.com/launch', title: 'We just launched' };
const ROWS = [
    {
        label: 'SendTextMessageDto.quotedMessageId is non-empty',
        dto: send_message_dto_1.SendTextMessageDto,
        base: { chatId: CHAT, text: 'hi' },
        field: 'quotedMessageId',
        valid: 'wamid.quoted',
        invalid: '',
    },
    {
        label: 'SendTextMessageDto.customLinkPreview is validated as a nested object (title is required)',
        dto: send_message_dto_1.SendTextMessageDto,
        base: { chatId: CHAT, text: 'hi' },
        field: 'customLinkPreview',
        valid: PREVIEW,
        invalid: { url: PREVIEW.url },
    },
    {
        label: 'CustomLinkPreviewDto.url is non-empty',
        dto: send_message_dto_1.CustomLinkPreviewDto,
        base: PREVIEW,
        field: 'url',
        valid: 'https://example.com/a',
        invalid: '',
    },
    {
        label: 'CustomLinkPreviewDto.title is at most 256 characters',
        dto: send_message_dto_1.CustomLinkPreviewDto,
        base: PREVIEW,
        field: 'title',
        valid: text(256),
        invalid: text(257),
    },
    {
        label: 'CustomLinkPreviewDto.description is at most 1024 characters',
        dto: send_message_dto_1.CustomLinkPreviewDto,
        base: PREVIEW,
        field: 'description',
        valid: text(1024),
        invalid: text(1025),
    },
    {
        label: 'SendMediaMessageDto.filename is at most 255 characters',
        dto: send_message_dto_1.SendMediaMessageDto,
        base: { chatId: CHAT, url: 'https://example.com/a.pdf' },
        field: 'filename',
        valid: text(255),
        invalid: text(256),
    },
    {
        label: 'SendMediaMessageDto.caption is at most 1024 characters',
        dto: send_message_dto_1.SendMediaMessageDto,
        base: { chatId: CHAT, url: 'https://example.com/a.jpg' },
        field: 'caption',
        valid: text(1024),
        invalid: text(1025),
    },
    {
        label: 'SendPollDto.name is at most 255 characters',
        dto: message_actions_dto_1.SendPollDto,
        base: { chatId: CHAT, name: 'Where?', options: ['Park', 'Beach'] },
        field: 'name',
        valid: text(255),
        invalid: text(256),
    },
    {
        label: 'SendPollDto.options entries are at most 100 characters',
        dto: message_actions_dto_1.SendPollDto,
        base: { chatId: CHAT, name: 'Where?', options: ['Park', 'Beach'] },
        field: 'options',
        valid: [text(100), 'Beach'],
        invalid: [text(101), 'Beach'],
    },
    {
        label: 'ClickButtonDto.text is at most 4096 characters',
        dto: message_actions_dto_1.ClickButtonDto,
        base: { chatId: CHAT, messageId: 'wamid.prompt', buttonId: 'yes' },
        field: 'text',
        valid: text(4096),
        invalid: text(4097),
    },
    {
        label: 'StarMessageDto.star is a boolean',
        dto: message_actions_dto_1.StarMessageDto,
        base: { chatId: CHAT, messageId: 'wamid.target' },
        field: 'star',
        valid: false,
        invalid: 'maybe',
    },
];
describe('send and action DTO field limits (docs/06 Constraints)', () => {
    const propertiesFailing = async (row, value) => (await validateDto(row.dto, { ...row.base, [row.field]: value })).map(error => error.property);
    it.each(ROWS)('$label', async (row) => {
        expect({ case: 'largest valid value', failing: await propertiesFailing(row, row.valid) }).toEqual({
            case: 'largest valid value',
            failing: [],
        });
        expect({ case: 'smallest invalid value', failing: await propertiesFailing(row, row.invalid) }).toEqual({
            case: 'smallest invalid value',
            failing: [row.field],
        });
    });
});
