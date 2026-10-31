"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GroupNotFoundError = void 0;
const common_1 = require("@nestjs/common");
/**
 * Thrown by the engine layer when a group id does not resolve to a group chat — the id is unknown
 * (whatsapp-web.js `getChatById` resolves undefined rather than throwing) or it addresses a 1:1
 * chat instead of a group. Same message shape as GroupService.getGroupInfo's 404.
 *
 * Extends NestJS `NotFoundException` so it maps to **HTTP 404** through the built-in exception
 * handler — no custom global filter required. Mirrors {@link MessageNotFoundError}.
 */
class GroupNotFoundError extends common_1.NotFoundException {
    constructor(groupId) {
        super(`Group ${groupId} not found`);
    }
}
exports.GroupNotFoundError = GroupNotFoundError;
