// A control's spoken name holds the words it shows (WCAG 2.5.3, Label in Name): a speech-input user says what they
// see ("click System", "click EN"), and a screen reader user hears the same words a sighted colleague reads out.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
let rtl;
let Layout;
let MemoryRouter;
let RoleContext;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    globalThis.__APP_VERSION__ = '0.0.0-test';
    window.matchMedia = ((query) => ({
        matches: false,
        media: query,
        addEventListener() { },
        removeEventListener() { },
    }));
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({ message: 'unstubbed' }), { status: 404 })));
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ MemoryRouter } = await import('react-router-dom'));
    ({ Layout } = await import('./Layout.jsx'));
    ({ RoleContext } = await import('../hooks/useRole.jsx'));
});
afterEach(() => rtl.cleanup());
function renderSidebar() {
    const role = {
        role: 'admin',
        setRole: () => undefined,
        isAdmin: true,
        isOperator: false,
        isViewer: false,
        canWrite: true,
        engineType: 'baileys',
        setEngineType: () => undefined,
        scoped: false,
        setScoped: () => undefined,
    };
    return rtl.render(createElement(RoleContext.Provider, { value: role }, createElement(MemoryRouter, null, createElement(Layout, { onLogout: () => undefined, userRole: 'admin' })))).container;
}
test('the sidebar theme and language buttons are named with the words they show', () => {
    localStorage.removeItem('openwa_theme');
    const footer = renderSidebar().querySelector('.sidebar-footer');
    const named = Array.from(footer.querySelectorAll('.theme-toggle-btn')).map(button => ({
        shows: button.textContent?.trim() ?? '',
        name: button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '',
    }));
    assert.equal(named.length, 2);
    // The name starts with the words shown and goes on to say what a press does.
    const mismatched = named.filter(({ shows, name }) => !name.startsWith(`${shows}, `));
    assert.deepEqual(mismatched.map(({ shows, name }) => `shows "${shows}" but is named "${name}"`), []);
    assert.deepEqual(named.map(({ name }) => name), ['EN, Change language', 'System, Switch to Light']);
});
