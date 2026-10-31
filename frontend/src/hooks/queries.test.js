// The chat list behind the webhook forms' autocomplete is read a page of 1000 at a time, which for an account
// with thousands of chats is many engine calls. The query hands TanStack's abort signal to the request, so
// leaving the page, or moving the form to another session, cuts the load instead of letting it run to the end.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
let rtl;
let useSessionChatsQuery;
const clients = [];
// Every page the gateway was asked for, with the signal the request carried.
const requests = [];
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    // The first page of a session is full, so the next one is asked for. That one never answers on its own: a
    // request that is not cut stays out, as a slow engine call does.
    globalThis.fetch = ((input, init) => {
        const url = new URL(String(input), 'http://localhost');
        const sessionId = /\/sessions\/([^/]+)\/chats/.exec(url.pathname)?.[1] ?? '';
        const offset = Number(url.searchParams.get('offset'));
        requests.push({ sessionId, offset, signal: init?.signal });
        if (offset === 0) {
            const page = Array.from({ length: 1000 }, (_, i) => ({ id: `chat-${i}` }));
            return Promise.resolve(new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
    });
    rtl = await import('@testing-library/react');
    ({ useSessionChatsQuery } = await import('./queries.js'));
});
afterEach(async () => {
    rtl.cleanup();
    // Cancel before clearing: clear() silently cancels a fetch still in flight, whose settling then re-arms the gc
    // timer of the query it just dropped, where nothing can clear it.
    for (const client of clients.splice(0)) {
        await client.cancelQueries();
        client.clear();
    }
    requests.length = 0;
});
function renderChats(sessionId) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 1_000 } } });
    clients.push(client);
    const wrapper = ({ children }) => createElement(QueryClientProvider, { client }, children);
    return rtl.renderHook(({ id }) => useSessionChatsQuery(id, true), {
        wrapper,
        initialProps: { id: sessionId },
    });
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));
test('leaving the page cuts a chat list load that is still paging, and asks for no further page', async () => {
    const { unmount } = renderChats('s1');
    await rtl.waitFor(() => assert.deepEqual(requests.map(r => r.offset), [0, 1000]));
    const pending = requests[1].signal;
    assert.ok(pending, 'the page request carried no signal');
    assert.equal(pending.aborted, false);
    unmount();
    assert.equal(pending.aborted, true, 'the load kept running after the page was left');
    await settle();
    assert.deepEqual(requests.map(r => r.offset), [0, 1000], 'a page was asked for after the load was cut');
});
test('moving the form to another session cuts the load of the session it left', async () => {
    const { rerender } = renderChats('s1');
    await rtl.waitFor(() => assert.deepEqual(requests.map(r => r.offset), [0, 1000]));
    const pending = requests[1].signal;
    assert.ok(pending, 'the page request carried no signal');
    rerender({ id: 's2' });
    assert.equal(pending.aborted, true, "the first session's load kept running");
    await rtl.waitFor(() => assert.ok(requests.some(r => r.sessionId === 's2')));
    assert.equal(requests.filter(r => r.sessionId === 's1').length, 2, 'the first session was asked for another page');
});
