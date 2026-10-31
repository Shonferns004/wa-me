"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const common_1 = require("@nestjs/common");
const core_1 = require("@nestjs/core");
const audit_controller_1 = require("./audit.controller");
const audit_log_entity_1 = require("./entities/audit-log.entity");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
// the audit log is a security event trail; without a role gate any active key (incl. a
// read-only VIEWER) could read the entire trail. It must require ADMIN, matching the infra
// secrets/export routes.
describe('AuditController access control', () => {
    it('GET /audit requires the ADMIN role', () => {
        // Read the handler off the prototype as an opaque object so the lint unbound-method rule
        // (which guards against detached method `this`) doesn't fire on a metadata-only lookup.
        const proto = audit_controller_1.AuditController.prototype;
        const role = new core_1.Reflector().get(auth_decorators_1.REQUIRED_ROLE_KEY, proto.findAll);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
});
// ?action=a&action=b reaches the handler as an array (an enum-typed query param is left alone by the
// global pipe) and bound as one SQL parameter it failed with a driver error, a 500. An unknown value
// silently matched nothing. Both are a malformed filter, so both answer 400.
describe('AuditController filter validation', () => {
    const findAll = jest.fn().mockResolvedValue({ data: [], total: 0 });
    const controller = new audit_controller_1.AuditController({ findAll });
    beforeEach(() => findAll.mockClear());
    it('rejects a repeated action or severity with 400', async () => {
        await expect(controller.findAll(undefined, [audit_log_entity_1.AuditAction.SESSION_CREATED, audit_log_entity_1.AuditAction.SESSION_DELETED])).rejects.toBeInstanceOf(common_1.BadRequestException);
        await expect(controller.findAll(undefined, undefined, [audit_log_entity_1.AuditSeverity.INFO, audit_log_entity_1.AuditSeverity.WARN])).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(findAll).not.toHaveBeenCalled();
    });
    it('rejects an unknown action or severity with 400', async () => {
        await expect(controller.findAll(undefined, 'nope')).rejects.toBeInstanceOf(common_1.BadRequestException);
        await expect(controller.findAll(undefined, undefined, 'fatal')).rejects.toBeInstanceOf(common_1.BadRequestException);
        expect(findAll).not.toHaveBeenCalled();
    });
    it('passes a known action and severity through', async () => {
        await controller.findAll(undefined, audit_log_entity_1.AuditAction.SESSION_CREATED, audit_log_entity_1.AuditSeverity.WARN);
        expect(findAll).toHaveBeenCalledWith({ action: audit_log_entity_1.AuditAction.SESSION_CREATED, severity: audit_log_entity_1.AuditSeverity.WARN }, undefined);
    });
    // Dropping the apiKeyId pass-through would make ?apiKeyId= silently return every key's rows.
    it('passes the sessionId and apiKeyId filters through, and parses limit and offset as integers', async () => {
        await controller.findAll(undefined, undefined, undefined, 's1', 'key-1', '25', '50');
        expect(findAll).toHaveBeenCalledWith({ sessionId: 's1', apiKeyId: 'key-1', limit: 25, offset: 50 }, undefined);
    });
});
