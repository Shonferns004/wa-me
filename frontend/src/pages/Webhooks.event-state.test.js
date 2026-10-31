// The webhook form's event tags are a multi-select: which events a webhook subscribes to is the one thing the form
// exists to set, so a screen reader must hear which tags are on.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
const webhook = {
    id: 'w1',
    sessionId: 'sess-1',
    url: 'https://receiver.example/hook',
    events: ['message.received'],
    filters: null,
    active: true,
    retryCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function installFetchStub() {
    globalThis.fetch = ((input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (path === '/api/sessions')
            return Promise.resolve(jsonResponse([{ id: 'sess-1', name: 'main', status: 'ready' }]));
        if (path === '/api/webhooks')
            return Promise.resolve(jsonResponse([webhook]));
        if (path === '/api/sessions/sess-1/chats')
            return Promise.resolve(jsonResponse([]));
        if (init?.method === 'POST' && path === '/api/sessions/sess-1/webhooks/w1/test') {
            // The receiver answered 500: the gateway reports the status and no error text.
            return Promise.resolve(jsonResponse({ success: false, statusCode: 500 }));
        }
        return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
    });
}
let rtl;
let i18n;
let Webhooks;
let RoleProvider;
let ToastProvider;
let queryClient;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    installFetchStub();
    window.sessionStorage.setItem('openwa_user_role', 'operator');
    const mod = await import('../i18n/index.js');
    await mod.i18nReady;
    i18n = mod.default;
    rtl = await import('@testing-library/react');
    ({ RoleProvider } = await import('../components/RoleProvider.jsx'));
    ({ ToastProvider } = await import('../components/Toast.jsx'));
    ({ Webhooks } = await import('./Webhooks.jsx'));
});
afterEach(async () => {
    rtl.cleanup();
    queryClient?.clear();
    queryClient = undefined;
    await i18n.changeLanguage('en');
});
function renderWebhooks() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Webhooks)))));
}
const pressedState = (button) => button.getAttribute('aria-pressed') ?? button.getAttribute('aria-checked');
test('the create form tells assistive tech which event tags are selected', async () => {
    renderWebhooks();
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /Add Webhook/i }));
    const dialog = await rtl.screen.findByRole('dialog');
    const selected = rtl.within(dialog).getByRole('button', { name: 'message.received' });
    const unselected = rtl.within(dialog).getByRole('button', { name: 'message.sent' });
    assert.equal(pressedState(selected), 'true', 'the selected message.received tag exposes no selected state');
    assert.equal(pressedState(unselected), 'false', 'the unselected message.sent tag exposes no state');
});
test('the edit form tells assistive tech which event tags are selected', async () => {
    renderWebhooks();
    rtl.fireEvent.click(await rtl.screen.findByTitle('Edit'));
    const dialog = await rtl.screen.findByRole('dialog');
    const selected = rtl.within(dialog).getByRole('button', { name: 'message.received' });
    assert.equal(pressedState(selected), 'true', 'the selected message.received tag exposes no selected state');
    const unselected = rtl.within(dialog).getByRole('button', { name: 'message.ack' });
    assert.equal(pressedState(unselected), 'false', 'the unselected message.ack tag exposes no state');
    // Toggling a tag moves its state with it.
    rtl.fireEvent.click(unselected);
    assert.equal(pressedState(rtl.within(dialog).getByRole('button', { name: 'message.ack' })), 'true');
});
