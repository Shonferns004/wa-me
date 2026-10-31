"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
jest.mock('../../adapters/whatsapp-web-js.adapter', () => ({
    WhatsAppWebJsAdapter: jest.fn().mockImplementation((config) => ({ config })),
}));
const index_1 = require("./index");
const whatsapp_web_js_adapter_1 = require("../../adapters/whatsapp-web-js.adapter");
describe('WhatsAppWebJsPlugin.createEngine (opaque config)', () => {
    beforeEach(() => {
        whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter.mockClear();
    });
    function withContext(plugin, config) {
        // onLoad sets this.context synchronously; the returned promise can be ignored here.
        void plugin.onLoad({ config, logger: { log: jest.fn() } });
    }
    it('reads browser config from context.config (the opaque engine blob), not per-call', () => {
        const plugin = new index_1.WhatsAppWebJsPlugin();
        withContext(plugin, {
            sessionDataPath: '/data/sessions',
            puppeteer: {
                headless: false,
                args: ['--single-process'],
                executablePath: '/usr/bin/chromium',
                protocolTimeoutMs: 300_000,
            },
        });
        plugin.createEngine({ sessionId: 'sess-1', proxyUrl: 'http://p', proxyType: 'http' });
        expect(whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-1',
            sessionDataPath: '/data/sessions',
            // protocolTimeoutMs is asserted with a value, not just carried: an object with the key
            // present-but-undefined equals one without it, so a dropped hop would pass unnoticed.
            puppeteer: {
                headless: false,
                args: ['--single-process'],
                executablePath: '/usr/bin/chromium',
                protocolTimeoutMs: 300_000,
            },
            proxy: { url: 'http://p', type: 'http' },
        }));
    });
    it('threads the shared lid mapping store to the adapter', () => {
        const lidMappingStore = {};
        new index_1.WhatsAppWebJsPlugin(undefined, lidMappingStore).createEngine({ sessionId: 's' });
        expect(whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter).toHaveBeenCalledWith(expect.objectContaining({ lidMappingStore }));
    });
    it('falls back to safe defaults when context has no config, leaving the flag list to the adapter', () => {
        const plugin = new index_1.WhatsAppWebJsPlugin();
        plugin.createEngine({ sessionId: 'sess-2' });
        const [config] = whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter.mock.calls[0];
        expect(config.sessionId).toBe('sess-2');
        expect(config.sessionDataPath).toBe('./data/sessions');
        expect(config.puppeteer.headless).toBe(true);
        expect(config.puppeteer.args).toBeUndefined();
    });
    it('does not pin a flag list when a persisted puppeteer override carries no args', () => {
        const plugin = new index_1.WhatsAppWebJsPlugin();
        withContext(plugin, { puppeteer: { headless: false } });
        plugin.createEngine({ sessionId: 'sess-4' });
        const [config] = whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter.mock.calls[0];
        expect(config.puppeteer.headless).toBe(false);
        expect(config.puppeteer.args).toBeUndefined();
    });
    it('Uses the constructor-supplied engine config when onLoad never ran (enable-failure path)', () => {
        // EngineFactory now also passes the engine blob at construction. If enablePlugin fails before
        // onLoad runs, this.context is never set — the ctor blob must still supply operator config
        // instead of silently degrading to defaults (which dropped sessionDataPath/executablePath).
        const plugin = new index_1.WhatsAppWebJsPlugin({
            sessionDataPath: '/op/sessions',
            puppeteer: { headless: false, args: ['--flag'], executablePath: '/usr/bin/chromium' },
        });
        plugin.createEngine({ sessionId: 'sess-3' });
        expect(whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'sess-3',
            sessionDataPath: '/op/sessions',
            puppeteer: { headless: false, args: ['--flag'], executablePath: '/usr/bin/chromium' },
        }));
    });
    it('Prefers context.config over the constructor blob on the healthy enable path', () => {
        const plugin = new index_1.WhatsAppWebJsPlugin({ sessionDataPath: '/ctor/path' });
        withContext(plugin, { sessionDataPath: '/context/path' });
        plugin.createEngine({ sessionId: 'sess-4' });
        expect(whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-4', sessionDataPath: '/context/path' }));
    });
    // The factory hardens and purges credential dirs under its own base, so the engine must write there
    // even when a persisted plugin-config override names another directory.
    it('Prefers the per-call sessionDataPath over a context.config override', () => {
        const plugin = new index_1.WhatsAppWebJsPlugin();
        withContext(plugin, { sessionDataPath: '/override/sessions' });
        plugin.createEngine({ sessionId: 'sess-5', sessionDataPath: '/factory/sessions' });
        expect(whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sess-5', sessionDataPath: '/factory/sessions' }));
    });
});
describe('WhatsAppWebJsPlugin.getFeatures', () => {
    it('does not advertise catalog — the wwjs adapter 501s every catalog method', () => {
        const features = new index_1.WhatsAppWebJsPlugin().getFeatures();
        expect(features).not.toContain('catalog');
        expect(features).toEqual(expect.arrayContaining(['text-messages', 'media-messages', 'group-management', 'labels', 'channels']));
    });
});
