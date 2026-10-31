// A bulk number check stops at the first answer that no later number would change.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
let rtl;
let NumberCheckProvider;
let useNumberCheck;
let ToastContext;
let lookupStatus = 200;
const lookups = [];
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    globalThis.fetch = (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        lookups.push(url.slice(url.lastIndexOf('/') + 1));
        const body = lookupStatus === 200
            ? { number: '', exists: true, whatsappId: null }
            : { statusCode: lookupStatus, message: 'Dummy refusal' };
        return Promise.resolve(new Response(JSON.stringify(body), { status: lookupStatus }));
    };
    rtl = await import('@testing-library/react');
    ({ NumberCheckProvider } = await import('./NumberCheckProvider.jsx'));
    ({ useNumberCheck } = await import('../hooks/useNumberCheck.js'));
    ({ ToastContext } = await import('../hooks/useToast.js'));
});
afterEach(() => {
    rtl.cleanup();
    lookupStatus = 200;
    lookups.length = 0;
});
function renderRun() {
    const noop = () => { };
    const value = {
        toasts: [],
        addToast: noop,
        removeToast: noop,
        success: noop,
        error: noop,
        warning: noop,
        info: noop,
    };
    const wrapper = ({ children }) => createElement(ToastContext.Provider, { value }, createElement(NumberCheckProvider, null, children));
    return rtl.renderHook(() => useNumberCheck(), { wrapper });
}
for (const status of [403, 429]) {
    test(`a ${status} on the first lookup stops the run before the second number is sent`, async () => {
        lookupStatus = status;
        const { result } = renderRun();
        await rtl.act(() => result.current.start(['628111111111', '628222222222', '628333333333'], 'dummy-session', 0));
        assert.equal(lookups.length, 1);
        assert.equal(result.current.running, false);
        assert.equal(result.current.stopped?.status, status);
        assert.equal(result.current.stopped?.attempted, 1);
    });
}
test('a 404 fails that number only and the run goes on', async () => {
    lookupStatus = 404;
    const { result } = renderRun();
    await rtl.act(() => result.current.start(['628111111111', '628222222222'], 'dummy-session', 0));
    assert.equal(lookups.length, 2);
    assert.equal(result.current.stopped, null);
});
