// A contact's status items all mount at once. The gateway answers a route ten times a second per IP and
// refuses the rest with a 429, so fetching every item together left the newest ones as "Media unavailable"
// for good; they take their turns now, and a refusal that still arrives is retried.
import '../../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
let rtl;
let StatusMedia;
let sessionApi;
before(async () => {
    const { installJsdomGlobals } = await import('../../test-helpers/jsdom.js');
    await installJsdomGlobals();
    const { i18nReady } = await import('../../i18n/index.js');
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ default: StatusMedia } = await import('./StatusMedia.jsx'));
    ({ sessionApi } = await import('../../services/api.js'));
    URL.createObjectURL = () => 'blob:status';
    URL.revokeObjectURL = () => undefined;
});
afterEach(() => rtl.cleanup());
test('twelve status items mounted together all end up with their media when the gateway refuses past ten a second', async () => {
    const startedAt = [];
    const api = sessionApi;
    const original = api.getStatusMediaBlob;
    api.getStatusMediaBlob = () => {
        const now = Date.now();
        startedAt.push(now);
        const inWindow = startedAt.filter(t => now - t < 1000).length;
        return inWindow > 10
            ? Promise.reject(Object.assign(new Error('Too Many Requests'), { status: 429 }))
            : Promise.resolve(new Blob(['x'], { type: 'image/jpeg' }));
    };
    try {
        const { container } = rtl.render(createElement('div', null, Array.from({ length: 12 }, (_, i) => createElement(StatusMedia, { key: i, sessionId: 's1', statusId: `st-${i}`, type: 'image' }))));
        await rtl.waitFor(() => {
            assert.equal(container.querySelectorAll('img.channel-media').length, 12);
        }, { timeout: 6000 });
        assert.equal(container.querySelectorAll('.status-media-placeholder').length, 0);
    }
    finally {
        api.getStatusMediaBlob = original;
    }
});
