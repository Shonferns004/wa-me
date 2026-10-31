// The key list names each key's role in the dashboard's language, as the role selects on the same page do; a role
// this build has no name for still shows as the API sends it.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
const operatorKey = {
    id: 'key-1',
    name: 'billing-bot',
    keyPrefix: 'owa_k1ab',
    role: 'operator',
    isActive: true,
    usageCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
};
let keyList = [operatorKey];
function installFetchStub() {
    globalThis.fetch = ((input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (path === '/api/sessions')
            return Promise.resolve(jsonResponse([]));
        if (init?.method === 'POST' && path === '/api/auth/api-keys') {
            return Promise.resolve(jsonResponse({ ...operatorKey, id: 'key-new', apiKey: 'owa_k1_new_plaintext' }, 201));
        }
        if (path === '/api/auth/api-keys')
            return Promise.resolve(jsonResponse(keyList));
        return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
    });
}
let rtl;
let i18n;
let ApiKeys;
let ToastProvider;
let queryClient;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    installFetchStub();
    const mod = await import('../i18n/index.js');
    await mod.i18nReady;
    i18n = mod.default;
    rtl = await import('@testing-library/react');
    ({ ToastProvider } = await import('../components/Toast.jsx'));
    ({ ApiKeys } = await import('./ApiKeys.jsx'));
});
afterEach(async () => {
    rtl.cleanup();
    queryClient?.clear();
    queryClient = undefined;
    keyList = [operatorKey];
    await i18n.changeLanguage('en');
});
function renderApiKeys() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(ToastProvider, null, createElement(ApiKeys))));
}
const roleBadge = async () => {
    await rtl.screen.findByText('billing-bot');
    return document.querySelector('.permission-badge')?.textContent ?? null;
};
test('the key list names a role in the dashboard language', async () => {
    await i18n.changeLanguage('zh-CN');
    renderApiKeys();
    assert.equal(await roleBadge(), i18n.t('apiKeys.roles.operator'));
});
test('the key list names a role in English as the role select does', async () => {
    renderApiKeys();
    assert.equal(await roleBadge(), 'Operator');
});
test('a role this build does not know is shown as the API sends it', async () => {
    keyList = [{ ...operatorKey, role: 'billing' }];
    renderApiKeys();
    assert.equal(await roleBadge(), 'billing');
});
