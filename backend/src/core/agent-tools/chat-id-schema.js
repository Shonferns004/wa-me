"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatJidSchema = exports.chatIdSchema = void 0;
const zod_1 = require("zod");
const send_message_dto_1 = require("../../modules/message/dto/send-message.dto");
/**
 * A chat id taken by a tool, bounded as the REST bodies bound it: the id is stored under a btree index,
 * and PostgreSQL answers a value past about 2.7 KB with a 500 that the MCP client reads as an internal
 * tool error.
 */
exports.chatIdSchema = zod_1.z.string().min(1).max(send_message_dto_1.CHAT_ID_MAX_LENGTH);
/**
 * A chat id for a tool whose REST body also checks the form of the id (localpart@host, no whitespace),
 * so a malformed id is refused here as it is there instead of failing in the engine.
 */
exports.chatJidSchema = exports.chatIdSchema.regex(send_message_dto_1.CHAT_JID_PATTERN, send_message_dto_1.CHAT_JID_MESSAGE);
