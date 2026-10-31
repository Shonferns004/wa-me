"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("reflect-metadata");
const auth_controller_1 = require("./auth.controller");
const auth_decorators_1 = require("./decorators/auth.decorators");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
// Key-lifecycle routes carry no session dimension, so the guard's allowedSessions fence can never
// bite on them — the class-level @RequireUnscopedKey marker is what keeps a session-scoped ADMIN
// key from minting or widening credentials here. Lock that the marker stays on the controller.
describe('AuthController — scoped-key confinement marker', () => {
    it('requires unscoped keys at the class level', () => {
        expect(Reflect.getMetadata(auth_decorators_1.UNSCOPED_KEY, auth_controller_1.AuthController)).toBe(true);
    });
});
// Every route that loads a key by id answers 404 for an unknown one, and every route with a body
// answers 400 on validation: the contract must say so, or a generated client has no case for them.
describe('AuthController OpenAPI error responses', () => {
    const declared = (handler) => Object.keys((Reflect.getMetadata('swagger/apiResponse', Object.getOwnPropertyDescriptor(auth_controller_1.AuthController.prototype, handler)?.value) ?? {}));
    it.each(['findOne', 'update', 'delete', 'revoke'])('declares 404 on %s', handler => {
        expect(declared(handler)).toContain('404');
    });
    it.each(['create', 'update'])('declares 400 on %s', handler => {
        expect(declared(handler)).toContain('400');
    });
});
// API-key lifecycle operations (create / delete / revoke) must leave an audit trail — they were
// previously unrecorded. These assert the controller emits the matching audit action with the acting
// admin key, the resolved client IP, and the target key in metadata.
describe('AuthController — API-key lifecycle audit logging', () => {
    const actor = { id: 'admin-key', name: 'admin' };
    const makeReq = () => ({ method: 'POST', path: '/auth/api-keys', clientIp: '203.0.113.7' });
    let authService;
    let auditService;
    let controller;
    beforeEach(() => {
        const createdKey = {
            id: 'k1',
            name: 'new-key',
            role: 'user',
            keyPrefix: 'ow_',
            isActive: true,
            usageCount: 0,
            createdAt: new Date(),
        };
        authService = {
            createApiKey: jest.fn().mockResolvedValue({ apiKey: createdKey, rawKey: 'raw-secret' }),
            findOne: jest.fn().mockResolvedValue({
                id: 'k1',
                name: 'target-key',
                role: 'viewer',
                allowedIps: null,
                allowedSessions: null,
                expiresAt: null,
            }),
            update: jest.fn().mockResolvedValue({ ...createdKey, role: 'admin' }),
            delete: jest.fn().mockResolvedValue(undefined),
            revoke: jest.fn().mockResolvedValue({ ...createdKey, isActive: false }),
        };
        auditService = { logInfo: jest.fn().mockResolvedValue(null) };
        controller = new auth_controller_1.AuthController(authService, auditService);
    });
    const lastContextFor = (action) => {
        const calls = auditService.logInfo.mock.calls;
        return calls.find(c => c[0] === action)?.[1];
    };
    it('logs API_KEY_CREATED on create, with the acting key, IP, and target id', async () => {
        await controller.create({ name: 'new-key' }, makeReq(), actor);
        const ctx = lastContextFor(audit_log_entity_1.AuditAction.API_KEY_CREATED);
        expect(ctx).toBeDefined();
        expect(ctx?.apiKey).toBe(actor);
        expect(ctx?.ipAddress).toBe('203.0.113.7');
        expect(ctx?.metadata?.targetKeyId).toBe('k1');
        expect(JSON.stringify(auditService.logInfo.mock.calls)).not.toContain('raw-secret');
    });
    it("records the created key's full authorization scope on API_KEY_CREATED", async () => {
        const expiresAt = new Date('2027-01-01T00:00:00Z');
        authService.createApiKey.mockResolvedValue({
            apiKey: {
                id: 'k2',
                name: 'scoped',
                role: 'operator',
                allowedIps: ['10.0.0.1'],
                allowedSessions: ['s1'],
                allowedChats: ['628123@c.us'],
                expiresAt,
            },
            rawKey: 'raw-secret',
        });
        await controller.create({ name: 'scoped' }, makeReq(), actor);
        const metadata = lastContextFor(audit_log_entity_1.AuditAction.API_KEY_CREATED)?.metadata;
        expect(metadata?.role).toBe('operator');
        expect(metadata?.scope).toEqual({
            role: 'operator',
            allowedIps: ['10.0.0.1'],
            allowedSessions: ['s1'],
            allowedChats: ['628123@c.us'],
            expiresAt,
        });
    });
    it('logs API_KEY_DELETED on delete', async () => {
        await controller.delete('k1', makeReq(), actor);
        expect(authService.delete).toHaveBeenCalledWith('k1');
        expect(lastContextFor(audit_log_entity_1.AuditAction.API_KEY_DELETED)?.metadata?.targetKeyId).toBe('k1');
    });
    it('logs API_KEY_UPDATED with before/after authorization state', async () => {
        await controller.update('k1', { role: 'admin' }, makeReq(), actor);
        const ctx = lastContextFor(audit_log_entity_1.AuditAction.API_KEY_UPDATED);
        expect(ctx?.apiKey).toBe(actor);
        expect(ctx?.metadata?.targetKeyId).toBe('k1');
        expect(ctx?.metadata?.before?.role).toBe('viewer');
        expect(ctx?.metadata?.after?.role).toBe('admin');
    });
    it('logs API_KEY_REVOKED on revoke', async () => {
        await controller.revoke('k1', makeReq(), actor);
        expect(lastContextFor(audit_log_entity_1.AuditAction.API_KEY_REVOKED)?.metadata?.targetKeyId).toBe('k1');
    });
});
// A key stored before expiresAt was validated can hold an unparseable expiry, which SQLite reads back as
// an Invalid Date. The gateway refuses such a key as expired, so every response must report it as expired
// too, not serialize the expiry as null (no expiry) and leave the key looking active.
describe('AuthController: unparseable stored expiry', () => {
    const stored = {
        id: 'k1',
        name: 'legacy',
        keyPrefix: 'ow_',
        role: 'user',
        isActive: true,
        usageCount: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        expiresAt: new Date('2026-W40-1'),
    };
    const epoch = '1970-01-01T00:00:00.000Z';
    const makeReq = () => ({ method: 'PUT', path: '/auth/api-keys/k1' });
    let authService;
    let auditService;
    let controller;
    beforeEach(() => {
        authService = {
            createApiKey: jest.fn().mockResolvedValue({ apiKey: stored, rawKey: 'raw' }),
            findAll: jest.fn().mockResolvedValue([stored]),
            findOne: jest.fn().mockResolvedValue(stored),
            update: jest.fn().mockResolvedValue(stored),
            revoke: jest.fn().mockResolvedValue(stored),
        };
        auditService = { logInfo: jest.fn().mockResolvedValue(null) };
        controller = new auth_controller_1.AuthController(authService, auditService);
    });
    it('records the expiry as a past instant in the audited scope', async () => {
        await controller.create({ name: 'legacy' }, makeReq());
        await controller.update('k1', {}, makeReq());
        const [created, updated] = JSON.parse(JSON.stringify(auditService.logInfo.mock.calls.map(call => call[1]))).map(ctx => ctx.metadata);
        expect(created.scope.expiresAt).toBe(epoch);
        expect(updated.before.expiresAt).toBe(epoch);
        expect(updated.after.expiresAt).toBe(epoch);
    });
    it('reports the expiry as a past instant in every key response', async () => {
        const responses = [
            await controller.create({ name: 'legacy' }, makeReq()),
            ...(await controller.findAll()),
            await controller.findOne('k1'),
            await controller.update('k1', {}, makeReq()),
            await controller.revoke('k1', makeReq()),
        ];
        for (const res of responses) {
            expect(JSON.parse(JSON.stringify(res)).expiresAt).toBe(epoch);
        }
    });
    it('passes a valid expiry and an unset one through unchanged', async () => {
        const expiresAt = new Date('2027-01-01T00:00:00Z');
        authService.findOne.mockResolvedValueOnce({ ...stored, expiresAt });
        expect((await controller.findOne('k1')).expiresAt).toBe(expiresAt);
        authService.findOne.mockResolvedValueOnce({ ...stored, expiresAt: null });
        expect((await controller.findOne('k1')).expiresAt).toBeUndefined();
    });
});
