// The "Messages by type" pie names each slice in its legend. Those names are message type keys from
// the stats API (voice, masked, unknown), which must read as words, not as the raw keys. Each type
// also keeps a color of its own, so no two slices can look alike.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
let rtl;
let DashboardCharts;
let queryClient;
let byType = {};
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    // jsdom lays nothing out, so report a real box or ResponsiveContainer never draws the chart.
    globalThis.ResizeObserver = class {
        cb;
        constructor(cb) {
            this.cb = cb;
        }
        observe(target) {
            this.cb([{ target, contentRect: { width: 400, height: 260 } }], this);
        }
        unobserve() { }
        disconnect() { }
    };
    globalThis.fetch = (() => Promise.resolve(jsonResponse({ timeSeries: [], byType, topChats: [] })));
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ DashboardCharts } = await import('./DashboardCharts.jsx'));
});
afterEach(() => {
    rtl.cleanup();
    queryClient?.clear();
});
function byTypeCard() {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardCharts)));
    return rtl.screen.findByText('Messages by type').then(n => n.closest('.chart-card'));
}
test('the by-type pie legend names message types in words', async () => {
    byType = { voice: 3, masked: 2, unknown: 1 };
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtl.render(createElement(QueryClientProvider, { client: queryClient }, createElement(DashboardCharts)));
    const card = (await rtl.screen.findByText('Messages by type')).closest('.chart-card');
    await rtl.waitFor(() => {
        const legend = Array.from(card.querySelectorAll('.recharts-legend-item-text')).map(n => n.textContent);
        assert.deepEqual(legend.sort(), ['Hidden message', 'Unknown type', 'Voice message']);
    });
});
test('every message type gets a slice color no other type uses', async () => {
    const { MESSAGE_TYPES } = await import('../services/api.js');
    // Plus one type this build has no color for, as a newer gateway could send.
    const types = [...MESSAGE_TYPES, 'future-type'];
    byType = Object.fromEntries(types.map((type, i) => [type, i + 1]));
    const card = await byTypeCard();
    await rtl.waitFor(() => {
        const fills = Array.from(card.querySelectorAll('.recharts-legend-item .recharts-legend-icon')).map(n => n.getAttribute('fill'));
        assert.equal(fills.length, types.length);
        assert.equal(new Set(fills).size, types.length, `shared colors: ${fills.join(', ')}`);
    });
});
