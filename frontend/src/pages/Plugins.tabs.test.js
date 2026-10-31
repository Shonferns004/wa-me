// The plugin config dialog (Configuration / Sessions) and the install dialog (Upload / Catalog) switch their content
// with a row of buttons. A screen reader must hear that these are tabs and which one is showing, as it does for the
// pairing tabs on the Sessions page and the mode tabs on the Number Checker.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const PLUGIN = {
    id: 'greeter',
    name: 'Greeter',
    version: '1.0.0',
    type: 'extension',
    status: 'enabled',
    config: { greeting: 'hello' },
    builtIn: false,
    provides: [],
    ingressCapable: false,
    configSchema: { type: 'object', properties: { greeting: { type: 'string', title: 'Greeting' } } },
    sessionScoped: true,
    activeSessions: ['*'],
    sessionConfig: {},
};
function installFetchStub() {
    globalThis.fetch = ((input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path === '/api/plugins')
            return Promise.resolve(jsonResponse([PLUGIN]));
        if (method === 'GET' && path === '/api/sessions')
            return Promise.resolve(jsonResponse([]));
        return Promise.resolve(jsonResponse([]));
    });
}
let rtl;
let Plugins;
let ToastProvider;
let queryClient;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    window.matchMedia ??= ((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener() { },
        removeListener() { },
        addEventListener() { },
        removeEventListener() { },
        dispatchEvent: () => false,
    }));
    installFetchStub();
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ ToastProvider } = await import('../components/Toast.jsx'));
    ({ default: Plugins } = await import('./Plugins.jsx'));
});
afterEach(() => {
    rtl.cleanup();
    queryClient?.clear();
    queryClient = undefined;
});
function renderPlugins() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(ToastProvider, null, createElement(Plugins))));
}
test('the config dialog exposes Configuration and Sessions as tabs with the shown one selected', async () => {
    renderPlugins();
    rtl.fireEvent.click(await rtl.screen.findByTitle('Configure'));
    await rtl.screen.findByRole('dialog');
    const tabs = rtl.screen.queryAllByRole('tab');
    assert.deepEqual(tabs.map(tab => [tab.textContent, tab.getAttribute('aria-selected')]), [
        ['Configuration', 'true'],
        ['Sessions', 'false'],
    ]);
});
test('the install dialog exposes Upload and Catalog as tabs with the shown one selected', async () => {
    renderPlugins();
    await rtl.screen.findByTitle('Configure');
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: /Install plugin/i }));
    await rtl.screen.findByRole('dialog');
    const tabs = rtl.screen.queryAllByRole('tab');
    assert.equal(tabs.length, 2, 'the install dialog exposes no tabs');
    assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['true', 'false']);
});
