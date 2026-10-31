"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.IsMentionWidConstraint = void 0;
exports.isMentionWid = isMentionWid;
const class_validator_1 = require("class-validator");
const wa_id_1 = require("../../../engine/identity/wa-id");
/**
 * Whether a string can address an individual in a `mentions` array.
 *
 * A mention names a person, so only the two individual dialects are accepted: `<phone>@c.us` (and
 * its raw-protocol twin `<phone>@s.whatsapp.net`) and `<lid>@lid`, each with a numeric user-part.
 * A `:<device>` suffix is fine — {@link isIndividualWid} strips it.
 *
 * Rejecting the rest is what keeps a malformed entry out of the engine. Nothing validated the shape
 * before, so a bare number or any other junk string reached WhatsApp Web's `createWid` inside
 * `window.WWebJS.sendMessage`, where the unguarded `mentionedJidList.map(createWid)` threw. The page
 * bundle is minified, so the throw arrived as `Error: t: t` and the caller received
 * `500 Internal server error` — undiagnosable from either end (#1068).
 *
 * The first version of this check tested only the DOMAIN, so `NOT A USER@c.us` still satisfied it and
 * still reached `createWid`. Sharing {@link isIndividualWid} with the group-participant guard closes
 * that in both places at once.
 *
 * Group ids are rejected too: `mentions` is the participant list, and mentioning a group is a
 * separate WhatsApp feature (`groupMentions`) that this API does not expose. A `@g.us` here was
 * never honoured — it just failed later and less clearly.
 */
function isMentionWid(value) {
    if (typeof value !== 'string')
        return false;
    return (0, wa_id_1.isIndividualWid)(value);
}
let IsMentionWidConstraint = class IsMentionWidConstraint {
    validate(value) {
        return isMentionWid(value);
    }
    defaultMessage() {
        return 'each mentions entry must be an individual WID — <phone>@c.us or <lid>@lid';
    }
};
exports.IsMentionWidConstraint = IsMentionWidConstraint;
exports.IsMentionWidConstraint = IsMentionWidConstraint = __decorate([
    (0, class_validator_1.ValidatorConstraint)({ name: 'isMentionWid', async: false })
], IsMentionWidConstraint);
