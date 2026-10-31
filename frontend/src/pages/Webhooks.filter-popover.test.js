// A webhook card's filter badge shows its conditions in a popover while the badge is hovered or focused. Content that
// appears on hover or focus has to be dismissible without moving the pointer or focus (WCAG 1.4.13): Escape closes
// it, so it can be put away when it covers the card below.
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
    filters: { conditions: [{ field: 'body', operator: 'contains', value: 'order' }] },
    active: true,
    retryCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
};
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
let rtl;
let Webhooks;
let RoleProvider;
let ToastProvider;
let queryClient;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    globalThis.fetch = ((input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (path === '/api/sessions')
            return Promise.resolve(jsonResponse([{ id: 'sess-1', name: 'main', status: 'ready' }]));
        if (path === '/api/webhooks')
            return Promise.resolve(jsonResponse([webhook]));
        return Promise.resolve(jsonResponse([]));
    });
    window.sessionStorage.setItem('openwa_user_role', 'operator');
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ RoleProvider } = await import('../components/RoleProvider.jsx'));
    ({ ToastProvider } = await import('../components/Toast.jsx'));
    ({ Webhooks } = await import('./Webhooks.jsx'));
});
afterEach(() => {
    rtl.cleanup();
    queryClient?.clear();
    queryClient = undefined;
});
async function renderBadge() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Webhooks)))));
    const badge = (await rtl.screen.findByText('1 filter')).closest('.filter-badge');
    await rtl.waitFor(() => assert.equal(queryClient?.isFetching(), 0));
    return badge;
}
const popoverShown = () => document.querySelector('[role="tooltip"]') !== null;
test('Escape closes the filter popover a focused badge opened, with focus left on the badge', async () => {
    const badge = await renderBadge();
    rtl.act(() => badge.focus());
    rtl.fireEvent.focus(badge);
    assert.ok(popoverShown(), 'focusing the badge opened no popover');
    rtl.fireEvent.keyDown(badge, { key: 'Escape' });
    assert.ok(!popoverShown(), 'Escape left the popover open');
    assert.ok(document.activeElement === badge, 'Escape moved focus off the badge');
});
test('Escape closes the filter popover the pointer opened, wherever focus is', async () => {
    const badge = await renderBadge();
    rtl.fireEvent.mouseEnter(badge);
    assert.ok(popoverShown(), 'hovering the badge opened no popover');
    rtl.fireEvent.keyDown(document.body, { key: 'Escape' });
    assert.ok(!popoverShown(), 'Escape left the popover open');
});
test('an Escape that ends an IME composition leaves the filter popover open', async () => {
    const badge = await renderBadge();
    rtl.fireEvent.mouseEnter(badge);
    rtl.fireEvent.keyDown(document.body, { key: 'Escape', isComposing: true });
    assert.ok(popoverShown(), 'the composition Escape closed the popover');
});
