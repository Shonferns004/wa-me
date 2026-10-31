"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsSessionIdConstraint = void 0;
exports.isSessionId = isSessionId;
const class_validator_1 = require("class-validator");
/**
 * Whether a string can survive the round trip into `allowedSessions` and still mean what was sent.
 *
 * The column is `simple-array`, which TypeORM stores as a comma join and reads back with a comma
 * split. Two shapes therefore do not survive it, and both fail OPEN rather than closed:
 *
 * - An empty or whitespace-only entry. `[""]` joins to `''`, reads back as `[]`, and every
 *   enforcement site treats a zero-length list as "every session". A request that looked like a
 *   scoping landed as a widening, which is the opposite of what the caller asked for.
 * - An entry containing a comma. `["a,b"]` reads back as two entries, so the stored allowlist is
 *   not the one that was sent.
 *
 * Deliberately NOT a UUID rule, even though session ids are always server-generated UUIDs. A
 * non-UUID entry fails CLOSED (it matches no session), so it is a usability wart rather than a
 * security hole, while a UUID rule would reject an operator re-saving a key whose allowlist holds a
 * legacy or imported id.
 */
function isSessionId(value) {
    return typeof value === 'string' && value.trim() === value && value.length > 0 && !value.includes(',');
}
let IsSessionIdConstraint = class IsSessionIdConstraint {
    validate(value) {
        return isSessionId(value);
    }
    defaultMessage() {
        return 'each allowedSessions entry must be a non-empty session id with no surrounding whitespace and no comma';
    }
};
exports.IsSessionIdConstraint = IsSessionIdConstraint;
exports.IsSessionIdConstraint = IsSessionIdConstraint = __decorate([
    (0, class_validator_1.ValidatorConstraint)({ name: 'isSessionId', async: false })
], IsSessionIdConstraint);
