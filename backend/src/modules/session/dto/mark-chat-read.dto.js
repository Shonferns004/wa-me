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
exports.MarkChatReadDto = exports.MARK_READ_MESSAGE_ID_MESSAGE = exports.MARK_READ_MESSAGE_ID_PATTERN = exports.MARK_READ_MESSAGE_IDS_MAX = void 0;
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const send_message_dto_1 = require("../../message/dto/send-message.dto");
const strict_boolean_1 = require("../../../common/utils/strict-boolean");
/**
 * Ceiling on one request's receipt batch, so a single call cannot hand the engine an unbounded key
 * list to round-trip. A caller with more than this to acknowledge is catching up on history rather
 * than marking a conversation read.
 */
exports.MARK_READ_MESSAGE_IDS_MAX = 100;
/**
 * The shape of one message id: a single non-whitespace token. Exported for the same reason as the
 * cap above, so the agent tool holds the rule rather than restating it. Restating it is how the two
 * surfaces drifted: the tool copied the count and left `['  ']` reaching the engine as a receipt key.
 */
exports.MARK_READ_MESSAGE_ID_PATTERN = /^\S{1,128}$/;
/** Rejection message for {@link MARK_READ_MESSAGE_ID_PATTERN}, shared so both surfaces answer alike. */
exports.MARK_READ_MESSAGE_ID_MESSAGE = 'each messageIds entry must be a non-empty id with no whitespace';
class MarkChatReadDto {
    chatId;
    messageIds;
}
exports.MarkChatReadDto = MarkChatReadDto;
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
    // scheme (e.g. Baileys 1234@s.whatsapp.net) is accepted too; the adapter validates/normalises
    // further for its own engine. Keeps the early-400 on obvious garbage without coupling to wwebjs.
    ,
    (0, class_validator_1.Matches)(send_message_dto_1.CHAT_JID_PATTERN, { message: send_message_dto_1.CHAT_JID_MESSAGE }),
    __metadata("design:type", String)
], MarkChatReadDto.prototype, "chatId", void 0);
__decorate([
    (0, swagger_1.ApiPropertyOptional)({
        description: 'Specific message IDs to mark read. Baileys acknowledges individual messages, so without this ' +
            'only the newest received message the engine still holds in memory gets a receipt — a burst leaves its ' +
            'earlier messages unread forever, and a restarted session has no message to acknowledge at all. ' +
            'Callers that persist inbound message IDs should send them here. Ignored by whatsapp-web.js, ' +
            'whose own sendSeen is chat-level.',
        type: [String],
        // @ArrayMaxSize is runtime-only; @nestjs/swagger does not derive maxItems from it, so without
        // this the published schema advertises an unbounded array and a caller batching more than the
        // cap discovers the limit as a 400.
        maxItems: exports.MARK_READ_MESSAGE_IDS_MAX,
        // @ArrayNotEmpty rejects [], so the published schema has to say so too; without minItems the
        // contract advertised an empty array as valid against a server that answers 400.
        minItems: 1,
        example: ['3EB0C767D26B8A3F1A2B', '3EB0C767D26B8A3F1A2C'],
    })
    // Not @IsOptional: that skips every validator for null as well as undefined, so an explicit
    // `"messageIds": null` reached the engine unchecked and dereferenced there as a 500. Absent stays
    // absent; present-but-null falls through to @IsArray and answers 400.
    ,
    (0, class_validator_1.ValidateIf)((_object, value) => value !== undefined),
    (0, strict_boolean_1.ToStrictArray)(),
    (0, class_validator_1.IsArray)()
    // An empty array asks for nothing to be acknowledged. Rejected rather than accepted, because the
    // engine reads a missing list as "the newest message" and the two must not collapse: a caller that
    // computed its unread set and got none back would otherwise acknowledge a message it never named.
    ,
    (0, class_validator_1.ArrayNotEmpty)(),
    (0, class_validator_1.ArrayMaxSize)(exports.MARK_READ_MESSAGE_IDS_MAX),
    (0, class_validator_1.IsString)({ each: true }),
    (0, class_validator_1.IsNotEmpty)({ each: true }),
    (0, class_validator_1.Matches)(exports.MARK_READ_MESSAGE_ID_PATTERN, { each: true, message: exports.MARK_READ_MESSAGE_ID_MESSAGE }),
    __metadata("design:type", Array)
], MarkChatReadDto.prototype, "messageIds", void 0);
