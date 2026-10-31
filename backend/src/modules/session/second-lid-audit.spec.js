"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const session_engine_lifecycle_service_1 = require("./session-engine-lifecycle.service");
const engine_registry_service_1 = require("../../engine/engine-registry.service");
const audit_service_1 = require("../audit/audit.service");
const audit_log_entity_1 = require("../audit/entities/audit-log.entity");
const lid_mapping_store_service_1 = require("../../engine/identity/lid-mapping-store.service");
const request_context_1 = require("../../common/services/request-context");
const ID = '55555555-5555-4555-8555-555555555555';
/**
 * The lid table cannot import the audit log, so the lifecycle registers the listener that turns a phone
 * reported under a second lid into a WARN row naming the phone, both lids and the reporting session.
 */
describe('a phone reported under a second lid', () => {
    it('is written to the audit log by the listener the lifecycle registers', () => {
        let listener;
        const lidMappingStore = { onSecondLid: jest.fn((fn) => (listener = fn)) };
        const auditService = { logWarn: jest.fn().mockResolvedValue(null) };
        new session_engine_lifecycle_service_1.SessionEngineLifecycle({}, {}, {}, new engine_registry_service_1.EngineRegistry(), {}, {}, {}, {}, {}, {}, {}, {}, {}, undefined, undefined, auditService, undefined, lidMappingStore);
        listener({ phone: '628999', previousLid: '111', newLid: '222', sessionId: ID });
        expect(auditService.logWarn).toHaveBeenCalledWith(audit_log_entity_1.AuditAction.PHONE_SECOND_LID_REPORTED, {
            sessionId: ID,
            metadata: { phone: '628999', previousLid: '111', newLid: '222' },
            errorMessage: expect.stringMatching(/628999.*222.*111/),
        });
    });
    // A whatsapp-web.js send resolves its recipient inside the REST call, so the report starts in that request.
    it('is written with no API key, IP or request id of the request whose send reported the lid', async () => {
        const rows = [{ lid: '111', phone: '628999', sessionId: 's1', isReported: true }];
        const repo = {
            find: jest.fn(() => Promise.resolve(rows.map(row => ({ ...row })))),
            findOne: jest.fn(() => Promise.resolve(null)),
            upsert: jest.fn((values) => {
                rows.push(values);
                return Promise.resolve({});
            }),
        };
        const store = new lid_mapping_store_service_1.LidMappingStoreService(repo);
        await store.onModuleInit();
        store.secondLidWindowMs = 0;
        jest
            .spyOn(store.logger, 'warn')
            .mockImplementation(() => undefined);
        const save = jest.fn((row) => Promise.resolve(row));
        const audit = new audit_service_1.AuditService({
            create: (row) => row,
            save,
        });
        const x = {};
        new session_engine_lifecycle_service_1.SessionEngineLifecycle(x, x, x, new engine_registry_service_1.EngineRegistry(), x, x, x, x, x, x, x, x, x, undefined, undefined, audit, undefined, store);
        await (0, request_context_1.runWithRequestId)('req-send-1', () => {
            (0, request_context_1.setRequestActor)({ apiKeyId: 'key-crm', apiKeyName: 'crm-bot', ipAddress: '203.0.113.9' });
            return store.remember('222', '628999', ID);
        });
        await new Promise(resolve => setTimeout(resolve, 20)); // the check's window, set to 0 above
        expect(save).toHaveBeenCalledTimes(1);
        expect(save.mock.calls[0][0]).toEqual(expect.objectContaining({
            action: audit_log_entity_1.AuditAction.PHONE_SECOND_LID_REPORTED,
            sessionId: ID,
            apiKeyId: null,
            apiKeyName: null,
            ipAddress: null,
            metadata: { phone: '628999', previousLid: '111', newLid: '222' },
        }));
    });
});
