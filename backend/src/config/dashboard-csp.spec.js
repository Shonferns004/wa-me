"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dashboard_csp_1 = require("./dashboard-csp");
describe('injectDashboardCspNonce', () => {
    it('keeps each dashboard document nonce isolated (multi-tab safe)', () => {
        const template = `<meta name="openwa-csp-nonce" content="${dashboard_csp_1.DASHBOARD_CSP_NONCE_PLACEHOLDER}">`;
        expect((0, dashboard_csp_1.injectDashboardCspNonce)(template, 'tab-a')).toContain('content="tab-a"');
        expect((0, dashboard_csp_1.injectDashboardCspNonce)(template, 'tab-b')).toContain('content="tab-b"');
    });
});
describe('injectDashboardCspNonce: every occurrence', () => {
    it('substitutes a placeholder that appears more than once', () => {
        const html = `<meta content="${dashboard_csp_1.DASHBOARD_CSP_NONCE_PLACEHOLDER}"><script nonce="${dashboard_csp_1.DASHBOARD_CSP_NONCE_PLACEHOLDER}">`;
        const out = (0, dashboard_csp_1.injectDashboardCspNonce)(html, 'abc123');
        // A first-occurrence-only replace leaves the script reading the literal placeholder, which the
        // browser then refuses under the document's own CSP.
        expect(out).toBe('<meta content="abc123"><script nonce="abc123">');
        expect(out).not.toContain(dashboard_csp_1.DASHBOARD_CSP_NONCE_PLACEHOLDER);
    });
});
