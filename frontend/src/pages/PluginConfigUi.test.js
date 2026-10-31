import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { i18nReady } from '../i18n/index.js';
import i18next from 'i18next';
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const pluginHtml = '<p>Editor</p>';
let pluginsList = [];
// What the config route answered, and every body it was sent.
let putReply = { success: true };
let putBodies = [];
function installFetchStub() {
    globalThis.fetch = ((input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (init?.method === 'PUT' && path === '/api/plugins/p1/config') {
            putBodies.push(JSON.parse(String(init.body)));
            return Promise.resolve(jsonResponse(putReply));
        }
        if (path === '/api/plugins')
            return Promise.resolve(jsonResponse(pluginsList));
        if (path.startsWith('/api/plugins/p1/config-ui'))
            return Promise.resolve(new Response(pluginHtml, { status: 200 }));
        if (path === '/api/plugins/catalog')
            return Promise.resolve(jsonResponse([]));
        return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
    });
}
let rtl;
let Plugins;
let ToastProvider;
let queryClient;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    // Mock matchMedia for useTheme
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: (query) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: () => { }, // Deprecated
            removeListener: () => { }, // Deprecated
            addEventListener: () => { },
            removeEventListener: () => { },
            dispatchEvent: () => false,
        }),
    });
    installFetchStub();
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ ToastProvider } = await import('../components/Toast.jsx'));
    ({ default: Plugins } = await import('./Plugins.jsx'));
});
afterEach(() => {
    rtl.cleanup();
    queryClient?.clear();
    queryClient = undefined;
    pluginsList = [];
    putReply = { success: true };
    putBodies = [];
});
function renderPlugins() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(ToastProvider, null, createElement(Plugins))));
}
test('PluginConfigUi localizes its frame title and replies to config:get with localized schema and locale', async () => {
    // Set the dashboard language so we can verify the schema gets localized
    await i18next.changeLanguage('es');
    pluginsList = [
        {
            id: 'p1',
            name: 'Plugin 1',
            type: 'extension',
            config: {},
            configUi: { entry: 'ui.html' },
            configSchema: {
                type: 'object',
                properties: {
                    field1: { type: 'string', title: 'English Title' },
                },
            },
            i18n: {
                es: {
                    name: 'Mi complemento',
                    config: {
                        field1: { title: 'Spanish Title' },
                    },
                },
            },
        },
    ];
    renderPlugins();
    // Wait for plugin list to load by finding the Configure button
    const configureButton = await rtl.screen.findByTitle('Configurar');
    // Open the configuration modal
    rtl.fireEvent.click(configureButton);
    // Wait for the iframe to be rendered
    const iframe = await rtl.waitFor(() => {
        const el = document.querySelector('iframe');
        assert.ok(el, 'ConfigUi iframe not found in DOM');
        return el;
    });
    // The frame's accessible name follows the localized modal title, not the raw manifest name.
    assert.equal(iframe.getAttribute('title'), 'Mi complemento', 'iframe title was not localized');
    let postedMessage = null;
    iframe.contentWindow.postMessage = (message) => {
        postedMessage = message;
    };
    // Dispatch the handshake message from the iframe to the window
    const messageEvent = new window.MessageEvent('message', {
        source: iframe.contentWindow,
        data: { type: 'config:get' },
    });
    window.dispatchEvent(messageEvent);
    // Assert that PluginConfigUi replied with the correct schema and locale
    assert.ok(postedMessage, 'No postMessage received by iframe');
    const msg = postedMessage;
    assert.equal(msg.type, 'config:value');
    // Bug #1522: The schema must be localized and locale must be present
    assert.equal(msg.locale, 'es', 'locale was not sent in config:value');
    assert.equal(msg.schema?.properties.field1.title, 'Spanish Title', 'schema was not localized in config:value');
});
// The editor runs in a sandboxed frame; the bridge answers only that frame, because a save carries the operator's key.
async function openConfigUi() {
    await i18next.changeLanguage('en');
    pluginsList = [
        {
            id: 'p1',
            name: 'Plugin 1',
            type: 'extension',
            config: {},
            configUi: { entry: 'ui.html' },
            configSchema: { type: 'object', properties: { field1: { type: 'string', title: 'Field' } } },
        },
    ];
    renderPlugins();
    rtl.fireEvent.click(await rtl.screen.findByTitle('Configure'));
    const iframe = await rtl.waitFor(() => {
        const el = document.querySelector('iframe');
        assert.ok(el, 'ConfigUi iframe not found in DOM');
        return el;
    });
    const posted = [];
    iframe.contentWindow.postMessage = (message) => {
        posted.push(message);
    };
    return { iframe, posted };
}
const messageFrom = (source, data) => window.dispatchEvent(new window.MessageEvent('message', { source, data }));
test('PluginConfigUi ignores a save that does not come from its own frame', async () => {
    const { iframe, posted } = await openConfigUi();
    messageFrom(window, { type: 'config:save', config: { field1: 'foreign' } });
    messageFrom(iframe.contentWindow, { type: 'config:save', config: { field1: 'own' } });
    await rtl.waitFor(() => assert.equal(putBodies.length, 1));
    assert.deepEqual(putBodies, [{ config: { field1: 'own' } }]);
    await rtl.waitFor(() => assert.deepEqual(posted, [{ type: 'config:saved' }]));
});
test('PluginConfigUi answers config:error with the gateway message when a save is rejected', async () => {
    putReply = { success: false, message: 'Rejected by the plugin' };
    const { iframe, posted } = await openConfigUi();
    messageFrom(iframe.contentWindow, { type: 'config:save', config: { field1: 'x' } });
    await rtl.waitFor(() => assert.deepEqual(posted, [{ type: 'config:error', message: 'Rejected by the plugin' }]));
    assert.deepEqual(putBodies, [{ config: { field1: 'x' } }]);
});
