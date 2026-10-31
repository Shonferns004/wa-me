"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const testing_1 = require("@nestjs/testing");
const core_1 = require("@nestjs/core");
const webhook_controller_1 = require("./webhook.controller");
const webhooks_list_controller_1 = require("./webhooks-list.controller");
const webhook_service_1 = require("./webhook.service");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const webhook_redrive_service_1 = require("./webhook-redrive.service");
const audit_service_1 = require("../audit/audit.service");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
/**
 * Regression locks for the secret/headers leak and read authorization at the controller level.
 */
function createSecretWebhook(overrides = {}) {
    return {
        id: 'wh-uuid-1',
        sessionId: 'sess-1',
        url: 'https://example.com/webhook',
        events: ['message.received'],
        secret: 's3cr3t-hmac-key',
        headers: { Authorization: 'Bearer receiver-token' },
        filters: null,
        active: true,
        retryCount: 3,
        lastTriggeredAt: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
        session: undefined,
        ...overrides,
    };
}
describe('Webhook controllers (secret leak + read authz)', () => {
    let controller;
    let listController;
    let reflector;
    let service;
    let redrive;
    let audit;
    beforeEach(async () => {
        service = {
            create: jest.fn(),
            findBySession: jest.fn(),
            findOne: jest.fn(),
            findAll: jest.fn(),
            update: jest.fn(),
        };
        redrive = { redrive: jest.fn() };
        audit = { logInfo: jest.fn().mockResolvedValue(null) };
        const module = await testing_1.Test.createTestingModule({
            controllers: [webhook_controller_1.WebhookController, webhooks_list_controller_1.WebhooksListController],
            providers: [
                { provide: webhook_service_1.WebhookService, useValue: service },
                { provide: webhook_redrive_service_1.WebhookRedriveService, useValue: redrive },
                { provide: audit_service_1.AuditService, useValue: audit },
            ],
        }).compile();
        controller = module.get(webhook_controller_1.WebhookController);
        listController = module.get(webhooks_list_controller_1.WebhooksListController);
        reflector = new core_1.Reflector();
    });
    // ── secret/headers must never appear in any response body ──────
    it('findOne does not return secret or headers, but keeps safe fields', async () => {
        service.findOne.mockResolvedValue(createSecretWebhook());
        const result = await controller.findOne('sess-1', 'wh-uuid-1');
        expect(result).not.toHaveProperty('secret');
        expect(result).not.toHaveProperty('headers');
        expect(JSON.stringify(result)).not.toContain('s3cr3t');
        expect(result.id).toBe('wh-uuid-1');
        expect(result.url).toBe('https://example.com/webhook');
        expect(result.events).toEqual(['message.received']);
        expect(result.active).toBe(true);
    });
    it('findBySession strips secret/headers from every item', async () => {
        service.findBySession.mockResolvedValue([
            createSecretWebhook(),
            createSecretWebhook({ id: 'wh-2' }),
        ]);
        const result = await controller.findBySession('sess-1');
        expect(result).toHaveLength(2);
        for (const w of result) {
            expect(w).not.toHaveProperty('secret');
            expect(w).not.toHaveProperty('headers');
        }
        expect(JSON.stringify(result)).not.toContain('s3cr3t');
    });
    it('cross-session findAll strips secret/headers', async () => {
        service.findAll.mockResolvedValue([createSecretWebhook()]);
        const result = await listController.findAll();
        expect(result[0]).not.toHaveProperty('secret');
        expect(result[0]).not.toHaveProperty('headers');
        expect(JSON.stringify(result)).not.toContain('Bearer receiver-token');
    });
    it('create response echoes no secret/headers', async () => {
        service.create.mockResolvedValue(createSecretWebhook());
        const result = await controller.create('sess-1', { url: 'https://example.com/webhook', secret: 's3cr3t-hmac-key' });
        expect(result).not.toHaveProperty('secret');
        expect(result).not.toHaveProperty('headers');
        expect(result.id).toBe('wh-uuid-1');
    });
    it('update response returns no secret/headers', async () => {
        service.update.mockResolvedValue(createSecretWebhook({ url: 'https://new.example.com/hook' }));
        const result = await controller.update('sess-1', 'wh-uuid-1', { url: 'https://new.example.com/hook' });
        expect(result).not.toHaveProperty('secret');
        expect(result).not.toHaveProperty('headers');
        expect(result.url).toBe('https://new.example.com/hook');
    });
    // ── read routes require OPERATOR+ (VIEWER → 403 via guard) ─────
    it('findBySession requires OPERATOR role', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, controller.findBySession);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.OPERATOR);
    });
    it('findOne requires OPERATOR role', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, controller.findOne);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.OPERATOR);
    });
    it('cross-session findAll requires OPERATOR role', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, listController.findAll);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.OPERATOR);
    });
    // ── redrive sends real events: ADMIN only, scoped by the key, audited ─────
    it('delivery-failure redrive requires ADMIN role', () => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- reading route metadata, not invoking
        const role = reflector.get(auth_decorators_1.REQUIRED_ROLE_KEY, listController.redriveDeliveryFailures);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
    it("delivery-failure redrive passes the key's allowedSessions and audits the counts", async () => {
        const result = { redriven: 2, delivered: 2, enqueued: 0, failed: 1, skipped: 0, remaining: 4 };
        redrive.redrive.mockResolvedValue(result);
        const apiKey = { id: 'key-1', allowedSessions: ['sess-1'] };
        await expect(listController.redriveDeliveryFailures({ sessionId: 'sess-1', limit: 10 }, apiKey)).resolves.toBe(result);
        expect(redrive.redrive).toHaveBeenCalledWith({ sessionId: 'sess-1', limit: 10 }, ['sess-1']);
        expect(audit.logInfo).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.WEBHOOK_DELIVERIES_REDRIVEN, {
            apiKey,
            sessionId: 'sess-1',
            metadata: { webhookId: undefined, ids: undefined, redriven: 2, failed: 1, skipped: 0, remaining: 4 },
        });
    });
});
