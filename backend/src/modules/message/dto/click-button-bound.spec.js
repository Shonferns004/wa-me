"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const send_message_dto_1 = require("./send-message.dto");
const baileys_message_mapper_1 = require("../../../engine/adapters/baileys-message-mapper");
/**
 * The route's bound on `buttonId` and the engine's bound on a choice id have to be the same number.
 * They live apart on purpose: a DTO must not import from an engine adapter, and the engine must not
 * know about HTTP. This is the seam that keeps them honest.
 *
 * If the engine's cap ever drops below the route's, the route accepts ids the engine refuses to
 * offer, and every such request answers "unknown button" from several layers down instead of a
 * validation error naming the field.
 */
describe('the click-button id bound', () => {
    it('matches the cap the engine applies to an inbound choice id', () => {
        expect(send_message_dto_1.BUTTON_ID_MAX_LENGTH).toBe(baileys_message_mapper_1.BUTTON_TEXT_MAX_LENGTH);
    });
});
