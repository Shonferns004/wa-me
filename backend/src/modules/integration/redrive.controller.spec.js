"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const core_1 = require("@nestjs/core");
const common_1 = require("@nestjs/common");
const redrive_controller_1 = require("./redrive.controller");
const api_key_entity_1 = require("../auth/entities/api-key.entity");
const auth_decorators_1 = require("../auth/decorators/auth.decorators");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const redrive_service_1 = require("./redrive.service");
describe('RedriveController authz', () => {
    it('is ADMIN-gated (re-dispatching DLQ payloads can cause real sends; a VIEWER/OPERATOR key must not)', () => {
        // The ApiKeyGuard only enforces a role when REQUIRED_ROLE_KEY metadata is present; without this
        // decorator any authenticated key (incl. read-only VIEWER) could POST the redrive action.
        const role = new core_1.Reflector().get(auth_decorators_1.REQUIRED_ROLE_KEY, redrive_controller_1.RedriveController);
        expect(role).toBe(api_key_entity_1.ApiKeyRole.ADMIN);
    });
});
// The instance's session binding lives in the persisted row, which the ApiKeyGuard's route-param
// fence never sees — the controller must confine a session-scoped key itself.
describe('RedriveController session-scope fence', () => {
    const scopedKey = { allowedSessions: ['sess-1'] };
    function build(sessionScope, enabled) {
        const redrive = { redriveInstance: jest.fn().mockResolvedValue({ redriven: 0, remaining: 0, batchSize: 100 }) };
        const instances = {
            resolve: jest
                .fn()
                .mockResolvedValue(sessionScope === undefined ? null : { pluginId: 'chatwoot', instanceId: 'acct1', sessionScope, enabled }),
        };
        const audit = { logInfo: jest.fn() };
        const controller = new redrive_controller_1.RedriveController(redrive, instances, audit);
        return { controller, redrive, audit };
    }
    it('lets a scoped key redrive an instance bound to one of its sessions, passing the current binding as a provenance filter', async () => {
        // A scoped key is authorized against the instance's CURRENT sessionScope, but the DLQ also holds
        // historical rows from prior bindings. The controller must thread that authorized binding down so
        // the service can filter by it — otherwise the key replays foreign (sess-old) rows.
        const { controller, redrive } = build('sess-1');
        await controller.redriveInstance('chatwoot', 'acct1', scopedKey);
        expect(redrive.redriveInstance).toHaveBeenCalledWith('chatwoot', 'acct1', 'sess-1');
    });
    it('answers 404 when a scoped key redrives an out-of-scope instance (and never dispatches)', async () => {
        const { controller, redrive } = build('sess-2');
        await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(common_1.NotFoundException);
        expect(redrive.redriveInstance).not.toHaveBeenCalled();
    });
    it('answers 404 when a scoped key redrives a missing instance (its retained DLQ rows still carry a sessionId that may be out of scope)', async () => {
        // build(undefined) makes resolve() return null (the instance row is gone). The old guard's
        // `inst && ...` short-circuit let a scoped key through to redriveInstance here, re-dispatching
        // the deleted instance's retained DLQ rows unscoped. It must fail closed instead.
        const { controller, redrive } = build(undefined);
        await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(common_1.NotFoundException);
        expect(redrive.redriveInstance).not.toHaveBeenCalled();
    });
    it('answers 409 when an unrestricted key redrives a missing instance (dispatch would refuse every row)', async () => {
        // Dispatch refuses a deleted instance, so a replay could only fail again, and a queued replay
        // would still retire its DLQ row as redriven. Refused before the service is reached.
        const { controller, redrive, audit } = build(undefined);
        await expect(controller.redriveInstance('chatwoot', 'acct1', { allowedSessions: null })).rejects.toThrow(common_1.ConflictException);
        expect(redrive.redriveInstance).not.toHaveBeenCalled();
        expect(audit.logInfo).not.toHaveBeenCalled();
    });
    it('answers 409 when redriving a disabled instance, for scoped and unrestricted keys alike', async () => {
        for (const apiKey of [scopedKey, { allowedSessions: null }]) {
            const { controller, redrive } = build('sess-1', false);
            await expect(controller.redriveInstance('chatwoot', 'acct1', apiKey)).rejects.toThrow(common_1.ConflictException);
            expect(redrive.redriveInstance).not.toHaveBeenCalled();
        }
    });
    it('keeps answering 404, not 409, when a scoped key redrives an out-of-scope disabled instance', async () => {
        // The scope fence runs first so a disabled instance in another session is not revealed.
        const { controller } = build('sess-2', false);
        await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(common_1.NotFoundException);
    });
    it('answers 404 when a scoped key redrives an all-sessions (null scope) instance', async () => {
        const { controller, redrive } = build(null);
        await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(common_1.NotFoundException);
        expect(redrive.redriveInstance).not.toHaveBeenCalled();
    });
    it('lets an unrestricted key redrive any instance, passing the current binding as the provenance filter', async () => {
        const { controller, redrive } = build('sess-2');
        await controller.redriveInstance('chatwoot', 'acct1', { allowedSessions: null });
        expect(redrive.redriveInstance).toHaveBeenCalledWith('chatwoot', 'acct1', 'sess-2');
    });
    it('passes null for an instance bound to all sessions', async () => {
        const { controller, redrive } = build(null);
        await controller.redriveInstance('chatwoot', 'acct1', { allowedSessions: null });
        expect(redrive.redriveInstance).toHaveBeenCalledWith('chatwoot', 'acct1', null);
    });
    it('audits a successful redrive with its outcome counts (a redrive can cause real sends)', async () => {
        const { controller, redrive, audit } = build('sess-1');
        redrive.redriveInstance.mockResolvedValue({ redriven: 3, remaining: 7, batchSize: 100 });
        await controller.redriveInstance('chatwoot', 'acct1', scopedKey);
        expect(audit.logInfo).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.INTEGRATION_INSTANCE_REDRIVEN, {
            metadata: { pluginId: 'chatwoot', instanceId: 'acct1', redriven: 3, remaining: 7 },
        });
    });
    it('does not audit a rejected (out-of-scope) redrive', async () => {
        const { controller, audit } = build('sess-2');
        await expect(controller.redriveInstance('chatwoot', 'acct1', scopedKey)).rejects.toThrow(common_1.NotFoundException);
        expect(audit.logInfo).not.toHaveBeenCalled();
    });
});
// A redrive runs the real service against a stored dead letter. The queue is on, so an accepted replay
// retires its row at once and the job fails later: what the answer says is all the operator sees.
describe('RedriveController after an instance was rebound', () => {
    const key = { allowedSessions: null };
    const dead = (id, sessionId) => ({ id, sessionId, redriven: false });
    function build(scope, rows) {
        // The where clause as the service writes it: a session id, IsNull(), or a list of alternatives.
        const matchesSession = (row, sessionId) => typeof sessionId === 'string' ? row.sessionId === sessionId : row.sessionId === null;
        const matches = (row, where) => row.redriven === where.redriven && (!('sessionId' in where) || matchesSession(row, where.sessionId));
        const repo = {
            find: jest.fn((opts) => {
                const alternatives = Array.isArray(opts.where) ? opts.where : [opts.where];
                return Promise.resolve(rows
                    .filter(row => alternatives.some(where => matches(row, where)))
                    .map(row => ({
                    ...row,
                    direction: 'inbound',
                    deliveryId: `d-${row.id}`,
                    attempts: 0,
                    payload: { route: 'r', ingress: { headers: {}, query: {}, body: '{}', rawBody: '{}' } },
                })));
            }),
            update: jest.fn((where, patch) => {
                Object.assign(rows.find(row => row.id === where.id) ?? {}, patch);
                return Promise.resolve();
            }),
            count: jest.fn(() => Promise.resolve(rows.filter(row => !row.redriven).length)),
            increment: jest.fn(),
        };
        const events = { update: jest.fn().mockResolvedValue(undefined) };
        const enqueue = jest
            .fn()
            .mockResolvedValue({
            outcome: 'queued',
        });
        const service = new redrive_service_1.RedriveService(repo, events, { enqueue });
        const instances = {
            resolve: jest
                .fn()
                .mockResolvedValue({ pluginId: 'chatwoot', instanceId: 'acct1', sessionScope: scope, enabled: true }),
        };
        const audit = { logInfo: jest.fn() };
        const controller = new redrive_controller_1.RedriveController(service, instances, audit);
        return { controller, enqueue, rows };
    }
    it('does not replay or retire a dead letter of an earlier session binding', async () => {
        const { controller, enqueue, rows } = build('sess-new', [dead('old', 'sess-old'), dead('current', 'sess-new')]);
        const result = await controller.redriveInstance('chatwoot', 'acct1', key);
        expect(enqueue).toHaveBeenCalledTimes(1);
        expect(enqueue.mock.calls[0][0]).toMatchObject({ sessionId: 'sess-new' });
        expect(result.redriven).toBe(1);
        expect(rows.find(row => row.id === 'old')?.redriven).toBe(false);
    });
    it('does not replay a dead letter of a session binding once the instance serves all sessions', async () => {
        const { controller, enqueue } = build(null, [dead('old', 'sess-old'), dead('all', null), dead('star', '*')]);
        const result = await controller.redriveInstance('chatwoot', 'acct1', key);
        expect(result.redriven).toBe(2);
        expect(enqueue.mock.calls.map(call => call[0].deliveryId).sort()).toEqual(['d-all', 'd-star']);
    });
});
