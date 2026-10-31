"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const http = __importStar(require("http"));
const net = __importStar(require("net"));
const ssrf_guard_1 = require("./ssrf-guard");
const load_remote_media_1 = require("../media/load-remote-media");
const socks_proxy_servers_1 = require("../../../test/helpers/socks-proxy-servers");
/**
 * A guarded fetch made for a proxied session must leave through that session's proxy on EVERY
 * branch, or the gateway's own address reaches the destination for some URLs and not others. The
 * branches are: a hostname with vetted addresses to pin, an IP literal with nothing to pin, a
 * redirect chain, and the guard switched off entirely.
 *
 * Real servers throughout: a real SOCKS5 proxy that relays every tunnel to a local origin whatever
 * destination is named, and requests aimed at TEST-NET-3 addresses, which are unroutable. A request
 * that went direct therefore fails instead of passing quietly, and one that went through the proxy
 * is answered by the origin.
 */
describe('withSafeFetch through a session proxy', () => {
    let origin;
    let originPort;
    let requests;
    let proxy;
    const savedAllowedHosts = process.env.SSRF_ALLOWED_HOSTS;
    const body = (response) => response.text();
    beforeAll(async () => {
        origin = http.createServer((req, res) => {
            requests.push(req.url ?? '');
            if (req.url === '/moved') {
                res.writeHead(302, { location: 'http://203.0.113.9/final' });
                res.end();
                return;
            }
            res.end(`origin saw ${req.url}`);
        });
        await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
        originPort = origin.address().port;
    });
    afterAll(async () => {
        origin.closeAllConnections();
        await new Promise(resolve => origin.close(() => resolve()));
    });
    beforeEach(async () => {
        requests = [];
        proxy = await (0, socks_proxy_servers_1.startSocks5Proxy)({ relayTo: originPort });
    });
    afterEach(async () => {
        await proxy.close();
        if (savedAllowedHosts === undefined)
            delete process.env.SSRF_ALLOWED_HOSTS;
        else
            process.env.SSRF_ALLOWED_HOSTS = savedAllowedHosts;
        delete process.env.WEBHOOK_SSRF_REDIRECTS;
    });
    it('sends a vetted hostname to the proxy as the address the guard checked', async () => {
        // Allowlisted so the loopback origin passes the guard; an allowlisted host is still resolved,
        // so there IS a vetted address to pin, which is the branch under test.
        process.env.SSRF_ALLOWED_HOSTS = 'localhost';
        const text = await (0, ssrf_guard_1.withSafeFetch)(`http://localhost:${originPort}/named`, {}, body, { proxyUrl: proxy.url });
        expect(text).toBe('origin saw /named');
        expect(proxy.destinations).toHaveLength(1);
        expect(net.isIP(proxy.destinations[0].split(':').slice(0, -1).join(':'))).toBeGreaterThan(0);
    });
    // The guard hands over the vetted list in resolver order, which is family-mixed: a dual-stack host
    // resolves AAAA first on any gateway with IPv6 connectivity, and SOCKS4 has no IPv6 form at all.
    // Handing over only the head of that list left such a session unable to fetch any dual-stack URL.
    it('sends a socks4 proxy an IPv4 entry of a dual-stack vetted host', async () => {
        process.env.SSRF_ALLOWED_HOSTS = 'localhost';
        const socks4 = await (0, socks_proxy_servers_1.startSocks4Proxy)({ relayTo: originPort });
        try {
            const text = await (0, ssrf_guard_1.withSafeFetch)(`http://localhost:${originPort}/dual`, {}, body, { proxyUrl: socks4.url });
            expect(text).toBe('origin saw /dual');
            expect(socks4.destinations).toEqual([`127.0.0.1:${originPort}`]);
        }
        finally {
            await socks4.close();
        }
    });
    // An IP literal leaves the guard with nothing to pin, which used to mean "no dispatcher": exactly
    // the branch where a proxied session's fetch would have gone direct.
    it('proxies an IP-literal URL, which has no resolved target to pin', async () => {
        const text = await (0, ssrf_guard_1.withSafeFetch)('http://203.0.113.7/literal', {}, body, { proxyUrl: proxy.url });
        expect(text).toBe('origin saw /literal');
        expect(proxy.destinations).toEqual(['203.0.113.7:80']);
    });
    // Turning the SSRF guard off says nothing about which address the request may leave from.
    it('proxies an unguarded fetch', async () => {
        const text = await (0, ssrf_guard_1.withSafeFetch)('http://203.0.113.7/unguarded', {}, body, {
            proxyUrl: proxy.url,
            guard: false,
        });
        expect(text).toBe('origin saw /unguarded');
        expect(proxy.destinations).toEqual(['203.0.113.7:80']);
    });
    it('proxies every hop of a followed redirect chain', async () => {
        const text = await (0, ssrf_guard_1.withSafeFetch)('http://203.0.113.7/moved', {}, body, {
            proxyUrl: proxy.url,
            followRedirects: true,
        });
        expect(text).toBe('origin saw /final');
        expect(proxy.destinations).toEqual(['203.0.113.7:80', '203.0.113.9:80']);
    });
    // The media loader is the path a send-by-URL and POST /media/convert both take.
    it('fetches caller-supplied media through the proxy', async () => {
        const media = await (0, load_remote_media_1.loadRemoteMediaBuffer)('http://203.0.113.7/photo.png', proxy.url);
        expect(media.data.toString()).toBe('origin saw /photo.png');
        expect(proxy.destinations).toEqual(['203.0.113.7:80']);
    });
    it('fails the fetch rather than going direct when the proxy value is unusable', async () => {
        await expect((0, ssrf_guard_1.withSafeFetch)('http://203.0.113.7/literal', {}, body, { proxyUrl: 'ftp://proxy.example:21' })).rejects.toThrow(/unsupported proxy/i);
        expect(requests).toEqual([]);
    });
    it('leaves an unproxied fetch exactly as it was: direct, and never near the proxy', async () => {
        process.env.SSRF_ALLOWED_HOSTS = 'localhost';
        const text = await (0, ssrf_guard_1.withSafeFetch)(`http://localhost:${originPort}/direct`, {}, body);
        expect(text).toBe('origin saw /direct');
        expect(proxy.destinations).toEqual([]);
    });
});
