"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const is_chat_id_validator_1 = require("./is-chat-id.validator");
describe('isChatId', () => {
    it('accepts well-formed group, contact and lid ids', () => {
        expect((0, is_chat_id_validator_1.isChatId)('120363000000000000@g.us')).toBe(true);
        expect((0, is_chat_id_validator_1.isChatId)('1234567890-1234567890@g.us')).toBe(true);
        expect((0, is_chat_id_validator_1.isChatId)('919999999999@c.us')).toBe(true);
        expect((0, is_chat_id_validator_1.isChatId)('919999999999@s.whatsapp.net')).toBe(true);
        expect((0, is_chat_id_validator_1.isChatId)('555000111@lid')).toBe(true);
        expect((0, is_chat_id_validator_1.isChatId)('919999999999')).toBe(true);
    });
    it('rejects the simple-array footguns (empty, comma, surrounding whitespace)', () => {
        expect((0, is_chat_id_validator_1.isChatId)('')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)('   ')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)(' 919999999999@c.us')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)('919999999999@c.us ')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)('919999999999@c.us,555@lid')).toBe(false);
    });
    it('rejects non-chat ids and special channels', () => {
        expect((0, is_chat_id_validator_1.isChatId)('not-a-jid')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)('status@broadcast')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)('123@newsletter')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)('123@broadcast')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)('abc@c.us')).toBe(false);
        expect((0, is_chat_id_validator_1.isChatId)(42)).toBe(false);
    });
});
