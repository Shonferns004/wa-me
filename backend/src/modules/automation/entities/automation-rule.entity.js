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
exports.AutomationRule = void 0;
const typeorm_1 = require("typeorm");
const session_entity_1 = require("../../session/entities/session.entity");
const column_types_1 = require("../../../common/utils/column-types");
/**
 * A single-message autoreply rule: when an inbound message matches `conditions`, the gateway answers
 * the chat with `replyText` through the ordinary send path (send pacing and plugin vetoes included).
 *
 * `conditions` reuses the webhook filter shape (`message` family) verbatim — same JSON, same
 * validator, same evaluator — so a rule matches exactly what a filtered `message.received` webhook
 * would have fired for. Null/empty conditions match every inbound message. One exception: a rule
 * without a `kind` condition never answers a channel, broadcast list or status (see evaluateInbound).
 */
let AutomationRule = class AutomationRule {
    id;
    // varchar (not uuid) to match sessions.id, same reasoning as webhooks.sessionId; indexed because
    // the evaluation path loads a session's rules on every inbound message.
    sessionId;
    session;
    name;
    enabled;
    // Null/absent matches every inbound message except channel, broadcast-list and status chats (those need a
    // kind condition); otherwise mirrors webhook filters' additive default.
    conditions;
    replyText;
    // Per-(rule, chat) quiet period: the same rule will not fire twice into the same chat within the
    // window. Together with the evaluator's freshness gate this rate-bounds (not: terminates) an
    // autoreply-vs-autoreply exchange. 0 disables it — knowingly.
    cooldownSeconds;
    createdAt;
    updatedAt;
};
exports.AutomationRule = AutomationRule;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], AutomationRule.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)('IDX_automation_rules_sessionId'),
    (0, typeorm_1.Column)({ type: 'varchar' }),
    __metadata("design:type", String)
], AutomationRule.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.ManyToOne)(() => session_entity_1.Session, { onDelete: 'CASCADE' }),
    (0, typeorm_1.JoinColumn)({ name: 'sessionId' }),
    __metadata("design:type", session_entity_1.Session)
], AutomationRule.prototype, "session", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100 }),
    __metadata("design:type", String)
], AutomationRule.prototype, "name", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'boolean', default: true }),
    __metadata("design:type", Boolean)
], AutomationRule.prototype, "enabled", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: (0, column_types_1.jsonColumnType)(), nullable: true }),
    __metadata("design:type", Object)
], AutomationRule.prototype, "conditions", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text' }),
    __metadata("design:type", String)
], AutomationRule.prototype, "replyText", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', default: 60 }),
    __metadata("design:type", Number)
], AutomationRule.prototype, "cooldownSeconds", void 0);
__decorate([
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], AutomationRule.prototype, "createdAt", void 0);
__decorate([
    (0, typeorm_1.UpdateDateColumn)(),
    __metadata("design:type", Date)
], AutomationRule.prototype, "updatedAt", void 0);
exports.AutomationRule = AutomationRule = __decorate([
    (0, typeorm_1.Entity)('automation_rules')
], AutomationRule);
