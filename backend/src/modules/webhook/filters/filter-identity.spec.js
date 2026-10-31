"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const typeorm_1 = require("typeorm");
const logger_service_1 = require("../../../common/services/logger.service");
const hooks_1 = require("../../../core/hooks");
const plugin_capability_context_1 = require("../../../core/plugins/plugin-capability-context");
const plugin_interfaces_1 = require("../../../core/plugins/plugin.interfaces");
const lid_mapping_entity_1 = require("../../../engine/identity/lid-mapping.entity");
const lid_mapping_store_service_1 = require("../../../engine/identity/lid-mapping-store.service");
const automation_rules_service_1 = require("../../automation/automation-rules.service");
const webhook_delivery_service_1 = require("../webhook-delivery.service");
const LID = '484848@lid';
const P = '628111@c.us';
const Q = '628222@c.us';
const filtersFor = (jid, field = 'sender', operator = 'is') => ({
    conditions: [{ field, operator, value: [jid] }],
});
const message = { from: LID, to: '620000@c.us', chatId: LID, mentionedIds: [LID], body: 'hello', type: 'text' };
describe('Identity readers after a peer changes a mapping', () => {
    let db;
    let reader;
    let peer;
    beforeEach(async () => {
        db = await new typeorm_1.DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [lid_mapping_entity_1.LidMapping],
            synchronize: true,
        }).initialize();
        const repo = db.getRepository(lid_mapping_entity_1.LidMapping);
        reader = new lid_mapping_store_service_1.LidMappingStoreService(repo);
        peer = new lid_mapping_store_service_1.LidMappingStoreService(repo);
        await reader.remember('484848', '628111', 'reader');
        await peer.reload();
    });
    afterEach(async () => {
        await db.destroy();
    });
    async function webhookMatches(jid, field = 'sender', operator = 'is') {
        const delivery = new webhook_delivery_service_1.WebhookDeliveryService({}, {}, { get: (_key, value) => value }, new hooks_1.HookManager(), {}, reader);
        return delivery.filterMatchingWebhooks([{ id: 'w', events: ['message.received'], filters: filtersFor(jid, field, operator) }], 'message.received', message);
    }
    async function automationSends(jid, field = 'sender', operator = 'is') {
        const sendText = jest.fn().mockResolvedValue({});
        const rules = new automation_rules_service_1.AutomationRulesService({
            find: () => Promise.resolve([
                { id: 'r', conditions: filtersFor(jid, field, operator), replyText: 'reply', cooldownSeconds: 0 },
            ]),
        }, {}, { get: () => ({ sendText }) }, reader);
        await rules.evaluateInbound('s', message);
        return sendText;
    }
    function pluginCapability() {
        const context = new plugin_capability_context_1.PluginCapabilityContext((0, logger_service_1.createLogger)('PluginIdentity'), { getSessionPort: () => ({ getEngine: () => ({}) }) }, new hooks_1.HookManager(), {}, reader);
        const plugin = {
            manifest: {
                id: 'identity',
                name: 'Identity',
                version: '1.0.0',
                type: plugin_interfaces_1.PluginType.EXTENSION,
                main: 'index.js',
                permissions: ['engine:read'],
                sessions: ['s'],
            },
            status: plugin_interfaces_1.PluginStatus.INSTALLED,
            config: {},
            instance: null,
            activeSessions: ['s'],
        };
        return context.buildEngineReadCapability(plugin);
    }
    it('does not deliver a phone-filtered webhook after a peer revokes the alias', async () => {
        await peer.rememberIfUnknown('484848', '628222', 'peer');
        expect(reader.getCached('484848')).toBe('628111');
        expect(await webhookMatches(P)).toHaveLength(0);
        expect(await webhookMatches(LID)).toHaveLength(1);
    });
    it('does not reply under a phone rule after a peer revokes the alias', async () => {
        await peer.rememberIfUnknown('484848', '628222', 'peer');
        expect(await automationSends(P)).not.toHaveBeenCalled();
        expect(await automationSends(LID)).toHaveBeenCalledTimes(1);
    });
    it('returns the raw LID to a plugin after a peer revokes the alias', async () => {
        await peer.rememberIfUnknown('484848', '628222', 'peer');
        expect(await pluginCapability().canonicalChatId('s', LID)).toBe(LID);
    });
    it('uses the peer reported phone without reloading the resident mirror', async () => {
        await peer.remember('484848', '628222', 'peer');
        expect(reader.getCached('484848')).toBe('628111');
        expect(await webhookMatches(P)).toHaveLength(0);
        expect(await webhookMatches(Q)).toHaveLength(1);
        expect(await automationSends(P)).not.toHaveBeenCalled();
        expect(await automationSends(Q)).toHaveBeenCalledTimes(1);
        expect(await pluginCapability().canonicalChatId('s', LID)).toBe(Q);
    });
    it('preserves matching reported aliases and exact phone inputs', async () => {
        expect(await webhookMatches(P)).toHaveLength(1);
        expect(await automationSends(P)).toHaveBeenCalledTimes(1);
        expect(await pluginCapability().canonicalChatId('s', LID)).toBe(P);
        expect(await pluginCapability().canonicalChatId('s', Q)).toBe(Q);
    });
    it.each([
        ['sender', 'is'],
        ['sender', 'isNot'],
        ['mentions', 'is'],
        ['mentions', 'isNot'],
    ])('keeps distinct reported LIDs separate for %s %s rules', async (field, operator) => {
        const other = '595959@lid';
        await peer.remember('595959', '628111', 'peer');
        const matches = operator === 'is' ? 0 : 1;
        expect(await webhookMatches(other, field, operator)).toHaveLength(matches);
        expect(await automationSends(other, field, operator)).toHaveBeenCalledTimes(matches);
        expect(await webhookMatches(P, field)).toHaveLength(1);
        expect(await automationSends(P, field)).toHaveBeenCalledTimes(1);
        expect(await webhookMatches(LID, field)).toHaveLength(1);
        expect(await automationSends(LID, field)).toHaveBeenCalledTimes(1);
    });
});
