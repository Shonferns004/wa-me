// POST /sessions/:id/messages/send-template renders a stored template with the gateway's shared renderer, which
// substitutes the legacy single-brace `{name}` form as well as `{{name}}` (src/common/utils/template-render.ts). The
// Templates page lists and previews the placeholders a send will fill, so it reads both forms with the same pattern,
// and an unfilled one stays as written, as the gateway leaves it.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
let templates = [];
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function installFetchStub() {
    globalThis.fetch = ((input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.replace(/^https?:\/\/[^/]+/, '');
        if (path === '/api/sessions') {
            return Promise.resolve(jsonResponse([
                {
                    id: 'sess-1',
                    name: 'billing-bot',
                    status: 'ready',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            ]));
        }
        if (path === '/api/sessions/sess-1/templates')
            return Promise.resolve(jsonResponse(templates));
        return Promise.resolve(jsonResponse({ message: `unstubbed ${path}` }, 404));
    });
}
const RENDERER = new URL('../../../backend/src/common/utils/template-render.ts', import.meta.url);
let rtl;
let Templates;
let PLACEHOLDER_PATTERN;
let RoleProvider;
let ToastProvider;
let renderer;
let queryClient;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    installFetchStub();
    window.scrollTo = () => { };
    window.sessionStorage.setItem('openwa_user_role', 'operator');
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ RoleProvider } = await import('../components/RoleProvider.jsx'));
    ({ ToastProvider } = await import('../components/Toast.jsx'));
    ({ Templates, PLACEHOLDER_PATTERN } = await import('./Templates.jsx'));
    renderer = await import('../../../backend/src/common/utils/template-render.ts');
});
afterEach(() => {
    rtl.cleanup();
    queryClient?.clear();
    queryClient = undefined;
    templates = [];
});
async function openTemplate(body) {
    templates = [{ id: 'tpl-1', name: 'otp', body }];
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(RoleProvider, null, createElement(ToastProvider, null, createElement(Templates)))));
    rtl.fireEvent.click(await rtl.screen.findByRole('button', { name: /otp/ }));
    return {
        panel: document.querySelector('.template-variable-panel'),
        preview: () => document.querySelector('.template-preview-message pre')?.textContent ?? undefined,
    };
}
test('the page reads placeholders with the pattern the gateway renders with', () => {
    const source = readFileSync(RENDERER, 'utf8');
    const literal = /const PLACEHOLDER_PATTERN = \/(.+)\/([a-z]*);/.exec(source);
    assert.ok(literal, 'the renderer pattern was not found');
    assert.equal(PLACEHOLDER_PATTERN.source, literal[1]);
    assert.equal(PLACEHOLDER_PATTERN.flags, literal[2]);
    const body = 'Hi {{ name }}, {greeting}! {{order-id}} { spaced } {{a}{b}}';
    const read = [...body.matchAll(PLACEHOLDER_PATTERN)].map(match => match[1] ?? match[2]);
    assert.deepEqual(read, renderer.templateVariableNames(body));
});
test('a template using the single-brace form lists that placeholder and previews it', async () => {
    assert.equal(renderer.renderTemplate('Your code is {code}', { code: '4821' }), 'Your code is 4821');
    const { panel, preview } = await openTemplate('Your code is {code}');
    const inputs = panel.querySelectorAll('input');
    assert.equal(inputs.length, 1, `preview inputs offered: ${inputs.length}; panel reads "${panel.textContent}"`);
    assert.ok(rtl.within(panel).getByText('{code}'));
    rtl.fireEvent.change(inputs[0], { target: { value: '4821' } });
    assert.equal(preview(), 'Your code is 4821');
    assert.ok(document.querySelector('.template-list-meta')?.textContent?.includes('{code}'));
});
test('a mixed body lists both forms, and an unfilled legacy placeholder stays as written', async () => {
    const { panel, preview } = await openTemplate('Hi {{name}}, {greeting}');
    assert.deepEqual(Array.from(panel.querySelectorAll('label span')).map(span => span.textContent), ['{greeting}', '{{name}}']);
    rtl.fireEvent.change(rtl.screen.getByLabelText('{{name}}'), { target: { value: 'Ada' } });
    assert.equal(preview(), 'Hi Ada, {greeting}');
    assert.equal(preview(), renderer.renderTemplate('Hi {{name}}, {greeting}', { name: 'Ada' }));
});
