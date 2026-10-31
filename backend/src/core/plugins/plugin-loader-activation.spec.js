"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin_loader_service_1 = require("./plugin-loader.service");
const hooks_1 = require("../hooks");
const plugin_interfaces_1 = require("./plugin.interfaces");
function makePlugin(opts) {
    const manifest = {
        id: 'act-ext',
        name: 'Activation Ext',
        version: '1.0.0',
        type: plugin_interfaces_1.PluginType.EXTENSION,
        main: 'index.js',
        sessionScoped: opts.sessionScoped,
    };
    return { manifest, status: plugin_interfaces_1.PluginStatus.ENABLED, config: {}, instance: null, activeSessions: opts.activeSessions };
}
describe('PluginLoaderService — per-session activation gate (hook delivery)', () => {
    let loader;
    let hookManager;
    let setSessions;
    beforeEach(() => {
        hookManager = new hooks_1.HookManager();
        const configService = { get: jest.fn().mockReturnValue(undefined) };
        setSessions = jest.fn();
        const pluginStorage = {
            createPluginStorage: jest.fn().mockReturnValue({}),
            setPluginSessions: setSessions,
        };
        loader = new plugin_loader_service_1.PluginLoaderService(configService, hookManager, pluginStorage, {
            get: jest.fn(),
        });
    });
    const seed = (plugin) => {
        loader.plugins.set(plugin.manifest.id, plugin);
    };
    function register(plugin, handler) {
        const ctx = loader.capabilities.createPluginContext(plugin);
        ctx.registerHook('message:received', handler);
    }
    const fire = (sessionId) => hookManager.execute('message:received', {}, { sessionId, source: 'Engine' });
    it('delivers a hook only for the sessions a session-scoped plugin is activated for', async () => {
        const handler = jest.fn().mockResolvedValue({ continue: true });
        register(makePlugin({ activeSessions: ['sess-1'] }), handler);
        await fire('sess-1');
        expect(handler).toHaveBeenCalledTimes(1);
        await fire('sess-2');
        expect(handler).toHaveBeenCalledTimes(1); // not delivered for the inactive session
    });
    it("delivers for every session when activeSessions is ['*']", async () => {
        const handler = jest.fn().mockResolvedValue({ continue: true });
        register(makePlugin({ activeSessions: ['*'] }), handler);
        await fire('a');
        await fire('b');
        expect(handler).toHaveBeenCalledTimes(2);
    });
    it('defaults to all sessions when activeSessions is unset', async () => {
        const handler = jest.fn().mockResolvedValue({ continue: true });
        register(makePlugin({}), handler); // no activeSessions
        await fire('anything');
        expect(handler).toHaveBeenCalledTimes(1);
    });
    it('a global plugin (sessionScoped:false) always receives the hook, even with no active sessions', async () => {
        const handler = jest.fn().mockResolvedValue({ continue: true });
        register(makePlugin({ sessionScoped: false, activeSessions: [] }), handler);
        await fire('x');
        expect(handler).toHaveBeenCalledTimes(1);
    });
    describe('setPluginSessions', () => {
        it('updates a session-scoped plugin and persists the new active set', () => {
            const plugin = makePlugin({ activeSessions: ['*'] });
            seed(plugin);
            loader.setPluginSessions('act-ext', ['sess-1', 'sess-2']);
            expect(plugin.activeSessions).toEqual(['sess-1', 'sess-2']);
            // No write options: a best-effort write, as every caller but the plugin API uses.
            expect(setSessions).toHaveBeenCalledWith('act-ext', ['sess-1', 'sess-2'], undefined);
        });
        it('rejects activating a global (non-session-scoped) plugin per session', () => {
            seed(makePlugin({ sessionScoped: false }));
            expect(() => loader.setPluginSessions('act-ext', ['sess-1'])).toThrow(/global/i);
            expect(setSessions).not.toHaveBeenCalled();
        });
    });
});
// A built-in/bundled plugin must read its persisted per-session activation + config back into the
// runtime on boot, exactly like a directory plugin (loadPlugin) — otherwise the gate falls back to
// all-sessions/base-config after every restart, silently widening delivery for a plugin the operator
// had restricted.
describe('PluginLoaderService — registerBuiltInPlugin restart read-back', () => {
    it('seeds activeSessions and sessionConfig from persisted storage', () => {
        const hookManager = new hooks_1.HookManager();
        const configService = { get: jest.fn().mockReturnValue(undefined) };
        const pluginStorage = {
            getPluginConfig: jest.fn().mockReturnValue({}),
            getPluginSessions: jest.fn().mockReturnValue(['sess-1']),
            getPluginSessionConfig: jest.fn().mockReturnValue({ 'sess-1': { lang: 'id' } }),
            getPluginEntry: jest.fn().mockReturnValue(undefined),
            setPluginEntry: jest.fn(),
        };
        const loader = new plugin_loader_service_1.PluginLoaderService(configService, hookManager, pluginStorage, {
            get: jest.fn(),
        });
        const manifest = {
            id: 'builtin-ext',
            name: 'Built-in Ext',
            version: '1.0.0',
            type: plugin_interfaces_1.PluginType.EXTENSION,
            main: 'index.js',
            sessionScoped: true,
        };
        loader.registerBuiltInPlugin(manifest, {});
        const plugin = loader.plugins.get('builtin-ext');
        expect(plugin?.activeSessions).toEqual(['sess-1']);
        expect(plugin?.sessionConfig).toEqual({ 'sess-1': { lang: 'id' } });
    });
});
