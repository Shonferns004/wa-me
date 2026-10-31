"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocksProxyAgent = void 0;
/**
 * Unit-test stub for `socks-proxy-agent` (ESM-only since v9). ts-jest runs in CommonJS mode, so any
 * source file that imports it — directly (baileys-lifecycle) or transitively (anything that pulls in
 * the engine adapters) — fails to load without this stub once the package lands in the unit test
 * graph. Jest applies this stub in the e2e lane too (test/ is that config's rootDir, so test/__mocks__
 * stubs node modules there automatically), and no e2e suite calls jest.unmock('socks-proxy-agent'),
 * so the real module runs in no test lane. No suite opens a real SOCKS connection, so a class that
 * records the proxy URL and satisfies the `Agent` return type of createProxyAgent is sufficient, and
 * because the spec's `instanceof` checks import the same mapped module, they run against this very
 * class. `proxy` mirrors the library's parsed object (parseSocksURL: `host` is URL.hostname, brackets
 * included for an IPv6 literal).
 */
const node_https_1 = require("node:https");
class SocksProxyAgent extends node_https_1.Agent {
    proxy;
    proxyUrl;
    constructor(proxy) {
        super();
        const url = typeof proxy === 'string' ? new URL(proxy) : proxy;
        this.proxy = { host: url.hostname, port: Number(url.port) || 1080, type: url.protocol === 'socks4:' ? 4 : 5 };
        this.proxyUrl = url.href;
    }
}
exports.SocksProxyAgent = SocksProxyAgent;
