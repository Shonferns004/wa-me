"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarkChatUnreadDto = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const send_message_dto_1 = require("../../message/dto/send-message.dto");
const strict_boolean_1 = require("../../../common/utils/strict-boolean");
/**
 * Deliberately separate from {@link MarkChatReadDto}, which the unread route used to share. The read
 * route accepts `messageIds`; the unread route has nothing to do with them and ignores them, so
 * sharing the class published a field on `POST /chats/unread` that it silently discarded.
 */
class MarkChatUnreadDto {
    chatId;
}
exports.MarkChatUnreadDto = MarkChatUnreadDto;
__decorate([
    (0, swagger_1.ApiProperty)({
        maxLength: send_message_dto_1.CHAT_ID_MAX_LENGTH,
        description: 'Chat ID in the neutral form the gateway returns, on either engine (e.g. 1234567890@c.us)',
        example: '1234567890@c.us',
    }),
    (0, strict_boolean_1.ToStrictString)(),
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    (0, class_validator_1.MaxLength)(send_message_dto_1.CHAT_ID_MAX_LENGTH)
    // Engine-neutral structural check (localpart@host, no whitespace) so a different engine's JID
    // scheme (e.g. Baileys 1234@s.whatsapp.net) is accepted too; the adapter normalises further.
    ,
    (0, class_validator_1.Matches)(send_message_dto_1.CHAT_JID_PATTERN, { message: send_message_dto_1.CHAT_JID_MESSAGE }),
    __metadata("design:type", String)
], MarkChatUnreadDto.prototype, "chatId", void 0);
