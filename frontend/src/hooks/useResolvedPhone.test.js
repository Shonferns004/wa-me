// The phone a privacy id resolves to is stable, so a found one is held for a day. A null is not: the route answers
// it both for "the account knows no phone for this id" and for a lookup that failed in the engine, and holding a
// failure for a day left Save contact disabled for the open chat until the tab was reloaded.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
let rtl;
let useResolvedPhone;
const clients = [];
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// What the route answers for the id, and every lookup it was asked for.
let phone = null;
const lookups = [];
function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    globalThis.fetch = ((input) => {
        const match = /\/sessions\/([^/]+)\/contacts\/([^/]+)\/phone$/.exec(String(input));
        if (!match)
            return Promise.resolve(json({ message: `unstubbed ${String(input)}` }, 404));
        lookups.push(decodeURIComponent(match[2]));
        return Promise.resolve(json({ contactId: decodeURIComponent(match[2]), phone }));
    });
    rtl = await import('@testing-library/react');
    ({ useResolvedPhone } = await import('./useResolvedPhone.js'));
});
afterEach(async () => {
    rtl.cleanup();
    for (const client of clients.splice(0)) {
        await client.cancelQueries();
        client.clear();
    }
    lookups.length = 0;
    phone = null;
    focusManager.setFocused(undefined);
});
function renderPhone() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    clients.push(client);
    const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
    return rtl.renderHook(() => useResolvedPhone('s1', '262813461250071@lid'), { wrapper });
}
const regainFocus = () => rtl.act(() => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
});
test('a phone that resolved is held for the day, and asked for again after it', async (t) => {
    let clock = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => clock);
    phone = '628111';
    const { result } = renderPhone();
    await rtl.waitFor(() => assert.equal(result.current.data, '628111'));
    clock += 23 * HOUR;
    regainFocus();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lookups.length, 1, 'a resolved phone was asked for again within the day');
    clock += 2 * HOUR;
    regainFocus();
    await rtl.waitFor(() => assert.equal(lookups.length, 2));
});
test('a null answer is asked for again after a minute, so a failed lookup does not last the day', async (t) => {
    let clock = 1_800_000_000_000;
    t.mock.method(Date, 'now', () => clock);
    phone = null;
    const { result } = renderPhone();
    await rtl.waitFor(() => assert.equal(result.current.isSuccess, true));
    assert.equal(result.current.data, null);
    // Within the minute the null stands, so a restless focus does not hammer the engine.
    clock += 30 * 1000;
    regainFocus();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(lookups.length, 1, 'a null was asked for again within the minute');
    // The engine has recovered by the time the window is focused after it.
    phone = '628111';
    clock += 40 * 1000;
    regainFocus();
    await rtl.waitFor(() => assert.equal(result.current.data, '628111'));
    assert.equal(lookups.length, 2);
});
