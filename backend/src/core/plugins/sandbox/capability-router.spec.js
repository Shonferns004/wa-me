"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const capability_router_1 = require("./capability-router");
function makeContext() {
    return {
        messages: {
            sendText: jest.fn().mockResolvedValue({ messageId: 'm1' }),
            reply: jest.fn().mockResolvedValue({ messageId: 'm2' }),
        },
        engine: {
            getGroupInfo: jest.fn().mockResolvedValue({ id: 'g' }),
            getContacts: jest.fn().mockResolvedValue([]),
            getContactById: jest.fn().mockResolvedValue(null),
            checkNumberExists: jest.fn().mockResolvedValue(true),
            getChats: jest.fn().mockResolvedValue([]),
            getChatHistory: jest.fn().mockResolvedValue([]),
            canonicalChatId: jest.fn().mockResolvedValue('628@c.us'),
        },
        storage: {
            get: jest.fn().mockResolvedValue('v'),
            set: jest.fn().mockResolvedValue(undefined),
            delete: jest.fn().mockResolvedValue(undefined),
            list: jest.fn().mockResolvedValue([]),
        },
        net: {
            fetch: jest.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK', headers: {}, body: 'x' }),
        },
        conversations: {
            send: jest.fn().mockResolvedValue({ id: 'm3' }),
        },
        handover: {
            set: jest.fn().mockResolvedValue(undefined),
        },
        mappings: {
            upsert: jest.fn().mockResolvedValue(undefined),
            get: jest.fn().mockResolvedValue(null),
            getByProvider: jest.fn().mockResolvedValue(null),
        },
    };
}
describe('dispatchCapabilityVerb', () => {
    it('routes messages.sendText to the context with positional args', async () => {
        const ctx = makeContext();
        const out = await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'messages.sendText', ['s', 'c', 'hi']);
        expect(ctx.messages.sendText).toHaveBeenCalledWith('s', 'c', 'hi');
        expect(out).toEqual({ messageId: 'm1' });
    });
    it('routes messages.reply', async () => {
        const ctx = makeContext();
        await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'messages.reply', ['s', 'c', 'q', 'hi']);
        expect(ctx.messages.reply).toHaveBeenCalledWith('s', 'c', 'q', 'hi');
    });
    it('routes engine.getGroupInfo', async () => {
        const ctx = makeContext();
        await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'engine.getGroupInfo', ['s', 'g']);
        expect(ctx.engine.getGroupInfo).toHaveBeenCalledWith('s', 'g');
    });
    it('routes engine.getChatHistory with chatId, limit and includeMedia', async () => {
        const ctx = makeContext();
        await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'engine.getChatHistory', ['s', 'c@c.us', 20, true]);
        expect(ctx.engine.getChatHistory).toHaveBeenCalledWith('s', 'c@c.us', 20, true);
    });
    it('routes engine.canonicalChatId and returns the resolved id', async () => {
        const ctx = makeContext();
        const out = await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'engine.canonicalChatId', ['s', '111@lid']);
        expect(ctx.engine.canonicalChatId).toHaveBeenCalledWith('s', '111@lid');
        expect(out).toBe('628@c.us');
    });
    it('routes storage.get and returns its value', async () => {
        const ctx = makeContext();
        const out = await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'storage.get', ['k']);
        expect(ctx.storage.get).toHaveBeenCalledWith('k');
        expect(out).toBe('v');
    });
    it('routes net.fetch with the url + init and returns the serialized response', async () => {
        const ctx = makeContext();
        const init = { method: 'POST', body: '{}' };
        const out = await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'net.fetch', ['https://api.example.com/t', init]);
        expect(ctx.net.fetch).toHaveBeenCalledWith('https://api.example.com/t', init);
        expect(out).toMatchObject({ ok: true, status: 200, body: 'x' });
    });
    it('routes mappings verbs to the context', async () => {
        const calls = [];
        const ctx = {
            ...makeContext(),
            mappings: {
                upsert: (...a) => {
                    calls.push(['upsert', a]);
                    return Promise.resolve();
                },
                get: (...a) => {
                    calls.push(['get', a]);
                    return Promise.resolve(null);
                },
                getByProvider: (...a) => {
                    calls.push(['getByProvider', a]);
                    return Promise.resolve(null);
                },
            },
        };
        await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'mappings.upsert', [{ sessionId: 's', chatId: 'c', instanceId: 'i' }, 'conv1']);
        await (0, capability_router_1.dispatchCapabilityVerb)(ctx, 'mappings.getByProvider', ['i', 'conv1']);
        expect(calls).toEqual([
            ['upsert', [{ sessionId: 's', chatId: 'c', instanceId: 'i' }, 'conv1']],
            ['getByProvider', ['i', 'conv1']],
        ]);
    });
    it('rejects malformed worker args before they reach the ORM (undefined/empty criteria)', async () => {
        const ctx = makeContext();
        // Missing positional string args — the 0.3-era silent-drop would have matched arbitrary rows.
        await expect((0, capability_router_1.dispatchCapabilityVerb)(ctx, 'mappings.getByProvider', [])).rejects.toThrow(/non-empty string/i);
        await expect((0, capability_router_1.dispatchCapabilityVerb)(ctx, 'messages.sendText', ['s', undefined, 'hi'])).rejects.toThrow(/non-empty string/i);
        // Mapping keys must be complete { sessionId, chatId, instanceId } string triples.
        await expect((0, capability_router_1.dispatchCapabilityVerb)(ctx, 'mappings.get', [{ sessionId: 's' }])).rejects.toThrow(/sessionId, chatId, instanceId/);
        await expect((0, capability_router_1.dispatchCapabilityVerb)(ctx, 'handover.set', [undefined, 'agent'])).rejects.toThrow(/sessionId, chatId, instanceId/);
        await expect((0, capability_router_1.dispatchCapabilityVerb)(ctx, 'mappings.upsert', [
            { sessionId: 's', chatId: 'c', instanceId: 'i' },
            undefined,
        ])).rejects.toThrow(/non-empty string/i);
    });
    it('rejects an unknown verb — only allowlisted capabilities are reachable', async () => {
        const ctx = makeContext();
        await expect((0, capability_router_1.dispatchCapabilityVerb)(ctx, 'process.exit', [0])).rejects.toThrow(/unknown capability verb/i);
        await expect((0, capability_router_1.dispatchCapabilityVerb)(ctx, 'storage.constructor', [])).rejects.toThrow(/unknown capability verb/i);
    });
});
