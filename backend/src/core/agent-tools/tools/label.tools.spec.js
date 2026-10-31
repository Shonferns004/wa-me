"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const tool_invoker_1 = require("../tool-invoker");
const label_tools_1 = require("./label.tools");
const tool_result_1 = require("../../../modules/mcp/tool-result");
function makeAuth() {
    return {
        validateApiKey: jest.fn().mockResolvedValue({ id: 'k1', role: 'operator', allowedSessions: null }),
        hasPermission: jest.fn().mockReturnValue(true),
    };
}
// The engine's four label writes resolve void. Every write tool must map that to an object result:
// the MCP mount formats results with smartToolResult, and an undefined result used to throw there —
// reported to the agent as `Internal error` AFTER the write had already executed on WhatsApp, so
// the agent retried an operation that had succeeded.
describe('label write tools', () => {
    const writes = [
        ['LabelUpsert', 'upsertLabel', { sessionId: 's1', labelId: '7', name: 'VIP' }],
        ['LabelDelete', 'deleteLabel', { sessionId: 's1', labelId: '7' }],
        ['LabelAddToChat', 'addLabelToChat', { sessionId: 's1', chatId: '628111@c.us', labelId: '7' }],
        ['LabelRemoveFromChat', 'removeLabelFromChat', { sessionId: 's1', chatId: '628111@c.us', labelId: '7' }],
    ];
    it.each(writes)('%s resolves an object result the MCP mount can format', async (toolName, method, input) => {
        const svc = { [method]: jest.fn().mockResolvedValue(undefined) };
        const tool = (0, label_tools_1.labelTools)(svc).find(t => t.name === toolName);
        const out = await (0, tool_invoker_1.invokeTool)(tool, input, 'key', makeAuth());
        expect(out).toEqual({ success: true });
        // The exact formatting step the MCP server runs on the result (mcp.server.ts).
        const formatted = (0, tool_result_1.smartToolResult)(out);
        expect(formatted.content[0]).toEqual({ type: 'text', text: '{"success":true}' });
    });
    it('LabelUpsert forwards only name/color to the service', async () => {
        const upsertLabel = jest.fn().mockResolvedValue(undefined);
        const svc = { upsertLabel };
        const tool = (0, label_tools_1.labelTools)(svc).find(t => t.name === 'LabelUpsert');
        await (0, tool_invoker_1.invokeTool)(tool, { sessionId: 's1', labelId: '7', name: 'VIP', color: 3 }, 'key', makeAuth());
        expect(upsertLabel).toHaveBeenCalledWith('s1', '7', { name: 'VIP', color: 3 });
    });
    // An upsert on an existing id replaces the whole label (an omitted name is not kept), so MCP
    // clients must see it as destructive, like LabelDelete.
    it.each(['LabelUpsert', 'LabelDelete'])('%s is flagged destructive', toolName => {
        const tool = (0, label_tools_1.labelTools)({}).find(t => t.name === toolName);
        expect(tool.destructive).toBe(true);
    });
});
