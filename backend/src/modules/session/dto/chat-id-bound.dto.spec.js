"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const class_transformer_1 = require("class-transformer");
const class_validator_1 = require("class-validator");
const app_validation_1 = require("../../../config/app-validation");
const send_product_dto_1 = require("../../catalog/dto/send-product.dto");
const archive_chat_dto_1 = require("./archive-chat.dto");
const delete_chat_dto_1 = require("./delete-chat.dto");
const mark_chat_read_dto_1 = require("./mark-chat-read.dto");
const mark_chat_unread_dto_1 = require("./mark-chat-unread.dto");
const mute_chat_dto_1 = require("./mute-chat.dto");
const pin_chat_dto_1 = require("./pin-chat.dto");
const presence_dto_1 = require("./presence.dto");
const send_chat_state_dto_1 = require("./send-chat-state.dto");
// The send routes store a chat id in an indexed column, and PostgreSQL refuses an index entry past about
// 2.7 KB, which used to surface as a 500 where SQLite stored the value. They bound it at 255, and so does
// every other request body that names a chat, so one limit holds across the API: a product send stores
// the id like the send routes, and a chat action hands it to the engine.
describe('chatId is bounded at 255 characters on the chat action bodies', () => {
    const exact = `${'1'.repeat(250)}@c.us`;
    const over = `${'1'.repeat(251)}@c.us`;
    it.each([
        ['ArchiveChatDto', archive_chat_dto_1.ArchiveChatDto, { archive: true }],
        ['DeleteChatDto', delete_chat_dto_1.DeleteChatDto, {}],
        ['MarkChatReadDto', mark_chat_read_dto_1.MarkChatReadDto, {}],
        ['MarkChatUnreadDto', mark_chat_unread_dto_1.MarkChatUnreadDto, {}],
        ['MuteChatDto', mute_chat_dto_1.MuteChatDto, {}],
        ['PinChatDto', pin_chat_dto_1.PinChatDto, { pin: true }],
        ['SubscribePresenceDto', presence_dto_1.SubscribePresenceDto, {}],
        ['SendChatStateDto', send_chat_state_dto_1.SendChatStateDto, { state: 'typing' }],
        ['SendProductDto', send_product_dto_1.SendProductDto, { productId: 'p1' }],
    ])('%s', async (_name, Dto, rest) => {
        const constraintsOf = async (chatId) => {
            const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(Dto, { ...rest, chatId }));
            return errors.filter(e => e.property === 'chatId').flatMap(e => Object.keys(e.constraints ?? {}));
        };
        expect(await constraintsOf(over)).toContain('maxLength');
        expect(await constraintsOf(exact)).not.toContain('maxLength');
    });
});
// docs/06 states one structural rule for the chat id of a chat action: localpart@host with no whitespace.
// It is engine-neutral on purpose (@c.us, @s.whatsapp.net, @g.us and @lid all pass), so it only turns away
// ids that cannot name a chat on any engine. Dropping it from one body lets that garbage reach the engine.
describe('chatId must be localpart@host on the chat action bodies', () => {
    const accepted = ['628123456789@c.us', '628123456789@s.whatsapp.net', '120363000000000000@g.us', '1234567890@lid'];
    const rejected = [
        ['no host separator', '628123456789'],
        ['no local part', '@c.us'],
        ['no host', '628123456789@'],
        ['two separators', '628123456789@@c.us'],
        ['whitespace in the local part', '6281 23@c.us'],
        ['whitespace in the host', '628123456789@c .us'],
        ['leading whitespace', ' 628123456789@c.us'],
        ['trailing newline', '628123456789@c.us\n'],
    ];
    it.each([
        ['ArchiveChatDto', archive_chat_dto_1.ArchiveChatDto, { archive: true }],
        ['DeleteChatDto', delete_chat_dto_1.DeleteChatDto, {}],
        ['MarkChatReadDto', mark_chat_read_dto_1.MarkChatReadDto, {}],
        ['MarkChatUnreadDto', mark_chat_unread_dto_1.MarkChatUnreadDto, {}],
        ['MuteChatDto', mute_chat_dto_1.MuteChatDto, { muteUntil: 1_800_000_000_000 }],
        ['PinChatDto', pin_chat_dto_1.PinChatDto, { pin: true }],
        ['SubscribePresenceDto', presence_dto_1.SubscribePresenceDto, {}],
    ])('%s', async (_name, Dto, rest) => {
        const constraintsOf = async (chatId) => {
            const errors = await (0, class_validator_1.validate)((0, class_transformer_1.plainToInstance)(Dto, { ...rest, chatId }, app_validation_1.GLOBAL_VALIDATION_OPTIONS.transformOptions), app_validation_1.GLOBAL_VALIDATION_OPTIONS);
            return errors.filter(e => e.property === 'chatId').flatMap(e => Object.keys(e.constraints ?? {}));
        };
        for (const chatId of accepted)
            expect({ chatId, failing: await constraintsOf(chatId) }).toEqual({ chatId, failing: [] });
        for (const [why, chatId] of rejected)
            expect({ why, chatId, failing: await constraintsOf(chatId) }).toEqual({ why, chatId, failing: ['matches'] });
    });
});
