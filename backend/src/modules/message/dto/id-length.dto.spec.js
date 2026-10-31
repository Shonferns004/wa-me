"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const swagger_1 = require("@nestjs/swagger");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const message_actions_dto_1 = require("./message-actions.dto");
const bulk_message_dto_1 = require("./bulk-message.dto");
const send_message_dto_1 = require("./send-message.dto");
const send_template_dto_1 = require("./send-template.dto");
// A chat id and a batch id are stored under btree indexes, and PostgreSQL refuses an index entry past
// about 2.7 KB, which the client then saw as a 500. The REST bodies refuse them as a 400 first, and
// publish the bound so a client generated from the schema knows it.
const fields = [
    ['SendTextMessageDto', send_message_dto_1.SendTextMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['SendMediaMessageDto', send_message_dto_1.SendMediaMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['SendAudioMessageDto', send_message_dto_1.SendAudioMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['SendLocationDto', message_actions_dto_1.SendLocationDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['SendContactDto', message_actions_dto_1.SendContactDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['SendPollDto', message_actions_dto_1.SendPollDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['SendTemplateMessageDto', send_template_dto_1.SendTemplateMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['ReplyMessageDto', message_actions_dto_1.ReplyMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['ForwardMessageDto', message_actions_dto_1.ForwardMessageDto, 'fromChatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['ForwardMessageDto', message_actions_dto_1.ForwardMessageDto, 'toChatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['ReactMessageDto', message_actions_dto_1.ReactMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['DeleteMessageDto', message_actions_dto_1.DeleteMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['PinMessageDto', message_actions_dto_1.PinMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['UnpinMessageDto', message_actions_dto_1.UnpinMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['StarMessageDto', message_actions_dto_1.StarMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['EditMessageDto', message_actions_dto_1.EditMessageDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['VotePollDto', message_actions_dto_1.VotePollDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['ClickButtonDto', message_actions_dto_1.ClickButtonDto, 'chatId', send_message_dto_1.CHAT_ID_MAX_LENGTH],
    ['SendBulkMessageDto', bulk_message_dto_1.SendBulkMessageDto, 'batchId', send_message_dto_1.BATCH_ID_MAX_LENGTH],
];
describe('caller-chosen id length caps', () => {
    // Only the property under test is read: the other required fields of each body are left out on purpose.
    const constraintsOf = async (dto, field, value) => {
        const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(dto, { [field]: value }, { enableImplicitConversion: true }));
        return errors.find(error => error.property === field)?.constraints;
    };
    it.each(fields)('%s.%s accepts the cap and refuses one more character', async (_name, dto, field, max) => {
        expect((await constraintsOf(dto, field, 'a'.repeat(max)))?.maxLength).toBeUndefined();
        expect((await constraintsOf(dto, field, 'a'.repeat(max + 1)))?.maxLength).toEqual(expect.stringContaining(String(max)));
    });
    // The bulk item class is not exported, so it is reached through the body that holds the list.
    it('caps the chat id of every bulk item, where most ids arrive', async () => {
        const flatten = (errors, prefix = '') => errors.flatMap(error => [
            [prefix + error.property, error.constraints],
            ...flatten(error.children ?? [], `${prefix}${error.property}.`),
        ]);
        const refused = async (chatId) => {
            const body = (0, class_transformer_1.plainToInstance)(bulk_message_dto_1.SendBulkMessageDto, { messages: [{ chatId }] }, { enableImplicitConversion: true });
            const found = flatten(await (0, class_validator_1.validate)(body)).find(([path]) => path === 'messages.0.chatId');
            return found?.[1]?.maxLength !== undefined;
        };
        expect(await refused('a'.repeat(send_message_dto_1.CHAT_ID_MAX_LENGTH))).toBe(false);
        expect(await refused('a'.repeat(send_message_dto_1.CHAT_ID_MAX_LENGTH + 1))).toBe(true);
    });
    it.each(fields)('%s.%s publishes the cap in the schema', (_name, dto, field, max) => {
        const published = Reflect.getMetadata(swagger_1.DECORATORS.API_MODEL_PROPERTIES, dto.prototype, field);
        expect(published?.maxLength).toBe(max);
    });
});
