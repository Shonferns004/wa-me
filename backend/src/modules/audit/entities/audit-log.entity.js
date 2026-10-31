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
exports.AuditLog = exports.AuditSeverity = exports.AuditAction = void 0;
const typeorm_1 = require("typeorm");
var AuditAction;
(function (AuditAction) {
    // API Key events
    AuditAction["API_KEY_CREATED"] = "api_key_created";
    AuditAction["API_KEY_UPDATED"] = "api_key_updated";
    AuditAction["API_KEY_USED"] = "api_key_used";
    AuditAction["API_KEY_REVOKED"] = "api_key_revoked";
    AuditAction["API_KEY_DELETED"] = "api_key_deleted";
    AuditAction["API_KEY_AUTH_FAILED"] = "api_key_auth_failed";
    // Rate-limit enforcement (sampled: at most one row per subject+kind per minute — see
    // EventsGateway — so enforcing a limit never becomes an audit-write flood of its own).
    AuditAction["RATE_LIMIT_EXCEEDED"] = "rate_limit_exceeded";
    // Queue dashboard (Bull Board) events
    AuditAction["QUEUE_BOARD_MUTATED"] = "queue_board_mutated";
    // Session events
    AuditAction["SESSION_CREATED"] = "session_created";
    AuditAction["SESSION_STARTED"] = "session_started";
    AuditAction["SESSION_STOPPED"] = "session_stopped";
    AuditAction["SESSION_FORCE_KILLED"] = "session_force_killed";
    AuditAction["SESSION_LOGGED_OUT"] = "session_logged_out";
    AuditAction["SESSION_DELETED"] = "session_deleted";
    AuditAction["SESSION_CONFIG_UPDATED"] = "session_config_updated";
    AuditAction["SESSION_QR_GENERATED"] = "session_qr_generated";
    AuditAction["SESSION_CONNECTED"] = "session_connected";
    AuditAction["SESSION_DISCONNECTED"] = "session_disconnected";
    // WhatsApp's own judgement of the account, not our connection to it. Unlike SESSION_CONNECTED (never
    // emitted) and SESSION_DISCONNECTED (emitted only for a terminal unlink), these are always audited:
    // they are rare, they are not reconnect noise, and the in-memory store that serves
    // them to the API does not survive a restart — so the audit log is the only durable record of when
    // an account was restricted and for how long.
    AuditAction["SESSION_RESTRICTED"] = "session_restricted";
    AuditAction["SESSION_RESTRICTION_LIFTED"] = "session_restriction_lifted";
    // A ready link was refused because a different WhatsApp number scanned a session already bound to
    // another. Rare, security-relevant, and the in-memory error store that serves the reason to the API
    // does not survive a restart, so the audit row is the only durable record that a rebind was blocked.
    AuditAction["SESSION_REBIND_REJECTED"] = "session_rebind_rejected";
    // A session reported a phone number under a second privacy id (lid) while the earlier lid still maps to
    // it: the number changed hands or its holder moved lid, and a chat-restricted key naming either lid or
    // the number reaches both. Pairs the table already held are not reported, unless a lid has left the
    // gateway's mapping cache, which counts as new. Filed under the session that made the report.
    AuditAction["PHONE_SECOND_LID_REPORTED"] = "phone_second_lid_reported";
    // Message events
    AuditAction["MESSAGE_SENT"] = "message_sent";
    AuditAction["MESSAGE_FAILED"] = "message_failed";
    // Send-pacing enforcement. SEND_PACING_BLOCKED is sampled per session (at most one row per
    // session per minute, carrying the suppressed count) on the RATE_LIMIT_EXCEEDED precedent: a
    // session that hits its daily cap keeps being refused for the rest of the day, and one row per
    // refused send would make enforcing the limit an audit flood of its own. A breaker trip is rare
    // and alert-worthy, so it is never sampled.
    AuditAction["SEND_PACING_BLOCKED"] = "send_pacing_blocked";
    AuditAction["SEND_BREAKER_TRIPPED"] = "send_breaker_tripped";
    // Webhook events
    AuditAction["WEBHOOK_CREATED"] = "webhook_created";
    AuditAction["WEBHOOK_DELETED"] = "webhook_deleted";
    AuditAction["WEBHOOK_TRIGGERED"] = "webhook_triggered";
    AuditAction["WEBHOOK_FAILED"] = "webhook_failed";
    AuditAction["WEBHOOK_DELIVERIES_REDRIVEN"] = "webhook_deliveries_redriven";
    // Integration plugin-instance events
    AuditAction["INTEGRATION_INSTANCE_CREATED"] = "integration_instance_created";
    AuditAction["INTEGRATION_INSTANCE_UPDATED"] = "integration_instance_updated";
    AuditAction["INTEGRATION_INSTANCE_SECRET_REGENERATED"] = "integration_instance_secret_regenerated";
    AuditAction["INTEGRATION_INSTANCE_DELETED"] = "integration_instance_deleted";
    AuditAction["INTEGRATION_INSTANCE_REDRIVEN"] = "integration_instance_redriven";
    // Plugin management (ADMIN-only: a plugin is third-party code that runs in the gateway process).
    AuditAction["PLUGIN_INSTALLED"] = "plugin_installed";
    AuditAction["PLUGIN_UPDATED"] = "plugin_updated";
    AuditAction["PLUGIN_UNINSTALLED"] = "plugin_uninstalled";
    AuditAction["PLUGIN_ENABLED"] = "plugin_enabled";
    AuditAction["PLUGIN_DISABLED"] = "plugin_disabled";
    AuditAction["PLUGIN_CONFIG_UPDATED"] = "plugin_config_updated";
    AuditAction["PLUGIN_SESSIONS_UPDATED"] = "plugin_sessions_updated";
    // Infrastructure events (ADMIN-only operations on the infra module: credential-bearing config
    // mutation, server restart / Docker orchestration, and full-DB / storage export+import).
    AuditAction["INFRA_CONFIG_SAVED"] = "infra_config_saved";
    AuditAction["INFRA_RESTART_REQUESTED"] = "infra_restart_requested";
    AuditAction["INFRA_DATA_EXPORTED"] = "infra_data_exported";
    AuditAction["INFRA_DATA_IMPORTED"] = "infra_data_imported";
    AuditAction["INFRA_STORAGE_EXPORTED"] = "infra_storage_exported";
    AuditAction["INFRA_STORAGE_IMPORTED"] = "infra_storage_imported";
})(AuditAction || (exports.AuditAction = AuditAction = {}));
var AuditSeverity;
(function (AuditSeverity) {
    AuditSeverity["INFO"] = "info";
    AuditSeverity["WARN"] = "warn";
    AuditSeverity["ERROR"] = "error";
})(AuditSeverity || (exports.AuditSeverity = AuditSeverity = {}));
let AuditLog = class AuditLog {
    id;
    action;
    severity;
    apiKeyId;
    apiKeyName;
    sessionId;
    sessionName;
    ipAddress;
    userAgent;
    method;
    path;
    statusCode;
    // The "main" database connection is always SQLite (boot config),
    // so we use simple-json regardless of the user's data DB choice.
    metadata;
    errorMessage;
    createdAt;
};
exports.AuditLog = AuditLog;
__decorate([
    (0, typeorm_1.PrimaryGeneratedColumn)('uuid'),
    __metadata("design:type", String)
], AuditLog.prototype, "id", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: 'varchar', length: 50 }),
    __metadata("design:type", String)
], AuditLog.prototype, "action", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10, default: AuditSeverity.INFO }),
    __metadata("design:type", String)
], AuditLog.prototype, "severity", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: 'varchar', length: 36, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "apiKeyId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "apiKeyName", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.Column)({ type: 'varchar', length: 36, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "sessionId", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 100, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "sessionName", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 45, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "ipAddress", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "userAgent", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 10, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "method", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'varchar', length: 500, nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "path", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'int', nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "statusCode", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'simple-json', nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "metadata", void 0);
__decorate([
    (0, typeorm_1.Column)({ type: 'text', nullable: true }),
    __metadata("design:type", Object)
], AuditLog.prototype, "errorMessage", void 0);
__decorate([
    (0, typeorm_1.Index)(),
    (0, typeorm_1.CreateDateColumn)(),
    __metadata("design:type", Date)
], AuditLog.prototype, "createdAt", void 0);
exports.AuditLog = AuditLog = __decorate([
    (0, typeorm_1.Entity)('audit_logs')
], AuditLog);
