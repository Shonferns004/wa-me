"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const ingress_url_1 = require("./ingress-url");
describe('buildIngressUrls', () => {
    it('builds absolute URLs from BASE_URL for each route', () => {
        expect((0, ingress_url_1.buildIngressUrls)('https://api.example.com', 'chatwoot', 'acct1', ['chatwoot', 'status'])).toEqual([
            { route: 'chatwoot', url: 'https://api.example.com/api/ingress/chatwoot/acct1/chatwoot' },
            { route: 'status', url: 'https://api.example.com/api/ingress/chatwoot/acct1/status' },
        ]);
    });
    it('strips a trailing slash on BASE_URL', () => {
        expect((0, ingress_url_1.buildIngressUrls)('https://api.example.com/', 'p', 'i', ['r'])[0].url).toBe('https://api.example.com/api/ingress/p/i/r');
    });
    it('falls back to a relative path when BASE_URL is unset', () => {
        expect((0, ingress_url_1.buildIngressUrls)(undefined, 'p', 'i', ['r'])).toEqual([{ route: 'r', url: '/api/ingress/p/i/r' }]);
    });
    it('percent-encodes the route so a URL parser keeps it and the router decodes it back', () => {
        for (const route of ['hook ', 'a b', 'caf\u00e9']) {
            const url = (0, ingress_url_1.buildIngressUrls)('https://x', 'p', 'i', [route])[0].url;
            const segment = new URL(url).pathname.split('/').pop() ?? '';
            expect(decodeURIComponent(segment)).toBe(route);
        }
    });
    it('returns an empty array when the plugin declares no routes', () => {
        expect((0, ingress_url_1.buildIngressUrls)('https://x', 'p', 'i', [])).toEqual([]);
    });
});
