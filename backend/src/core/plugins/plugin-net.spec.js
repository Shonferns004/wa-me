"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin_net_1 = require("./plugin-net");
/** A stand-in for withSafeFetch that hands `use` a canned Response and records the init it was given. */
function fakeSafeFetch(response, sink) {
    return ((_url, init, use) => {
        sink.init = init;
        return Promise.resolve(use(response));
    });
}
function cannedResponse(body, headers, status = 200) {
    const bytes = new TextEncoder().encode(body);
    let read = false;
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 200 ? 'OK' : 'ERR',
        headers: new Headers(headers),
        // Minimal ReadableStream-like body: yields the bytes once, then done.
        body: {
            getReader: () => ({
                read: () => Promise.resolve(read ? { done: true, value: undefined } : ((read = true), { done: false, value: bytes })),
                cancel: () => Promise.resolve(),
            }),
        },
    };
}
describe('isNetHostAllowed', () => {
    it('denies by default (no allowlist)', () => {
        expect((0, plugin_net_1.isNetHostAllowed)(undefined, 'https://api.example.com/x')).toBe(false);
        expect((0, plugin_net_1.isNetHostAllowed)([], 'https://api.example.com/x')).toBe(false);
    });
    it("'*' allows any public host (the SSRF guard still blocks internal IPs at fetch time)", () => {
        expect((0, plugin_net_1.isNetHostAllowed)(['*'], 'https://api.example.com/x')).toBe(true);
        expect((0, plugin_net_1.isNetHostAllowed)(['*'], 'http://other.example.org:8080/y')).toBe(true);
    });
    it('matches host:port, defaulting the port from the scheme', () => {
        expect((0, plugin_net_1.isNetHostAllowed)(['api.example.com:443'], 'https://api.example.com/x')).toBe(true);
        expect((0, plugin_net_1.isNetHostAllowed)(['api.example.com:80'], 'http://api.example.com/x')).toBe(true);
        expect((0, plugin_net_1.isNetHostAllowed)(['api.example.com:443'], 'https://api.example.com:8443/x')).toBe(false);
    });
    it('a bare host (no port) allows any port on that host', () => {
        expect((0, plugin_net_1.isNetHostAllowed)(['api.example.com'], 'https://api.example.com:8443/x')).toBe(true);
        expect((0, plugin_net_1.isNetHostAllowed)(['api.example.com'], 'https://other.example.com/x')).toBe(false);
    });
    it('rejects non-http(s) schemes and unparseable URLs', () => {
        expect((0, plugin_net_1.isNetHostAllowed)(['*'], 'ftp://api.example.com/x')).toBe(false);
        expect((0, plugin_net_1.isNetHostAllowed)(['*'], 'file:///etc/passwd')).toBe(false);
        expect((0, plugin_net_1.isNetHostAllowed)(['*'], 'not a url')).toBe(false);
    });
});
describe('performPluginFetch', () => {
    it('routes through the safe-fetch guard and serializes the response', async () => {
        const sink = {};
        const fetcher = fakeSafeFetch(cannedResponse('{"hello":"hi"}', { 'content-type': 'application/json' }), sink);
        const res = await (0, plugin_net_1.performPluginFetch)('https://api.example.com/t', { method: 'POST', body: '{}', headers: { 'x-k': 'v' } }, { fetch: fetcher });
        expect(res.ok).toBe(true);
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body)).toEqual({ hello: 'hi' });
        expect(res.headers['content-type']).toBe('application/json');
        // method/headers/body are passed to the guarded fetch (which does the SSRF pinning).
        expect(sink.init?.method).toBe('POST');
        expect(sink.init?.body).toBe('{}');
    });
    it('coerces a non-numeric timeoutMs to the default instead of throwing a RangeError', async () => {
        const sink = {};
        const fetcher = fakeSafeFetch(cannedResponse('{}', { 'content-type': 'application/json' }), sink);
        // A string 'abc' would make AbortSignal.timeout(NaN) throw before the request runs; the coercion
        // must fall back to the default so the documented timeout clamp holds and the fetch proceeds.
        await expect((0, plugin_net_1.performPluginFetch)('https://api.example.com/t', { timeoutMs: 'abc' }, { fetch: fetcher })).resolves.toMatchObject({ ok: true });
        expect(sink.init?.signal).toBeInstanceOf(AbortSignal);
    });
    it.each([1.5, 0.4, 2500.9])('accepts a fractional timeoutMs of %s', async (timeoutMs) => {
        // AbortSignal.timeout throws ERR_OUT_OF_RANGE for a non-integer, which failed the plugin's request.
        const fetcher = fakeSafeFetch(cannedResponse('{}', {}), {});
        await expect((0, plugin_net_1.performPluginFetch)('https://api.example.com/t', { timeoutMs }, { fetch: fetcher })).resolves.toMatchObject({ ok: true });
    });
    it('rejects a response whose declared content-length exceeds the cap', async () => {
        const sink = {};
        const big = String(11 * 1024 * 1024);
        const fetcher = fakeSafeFetch(cannedResponse('x', { 'content-length': big }), sink);
        await expect((0, plugin_net_1.performPluginFetch)('https://api.example.com/t', {}, { fetch: fetcher })).rejects.toThrow(/cap/i);
    });
    it('rejects once the global concurrent-fetch cap is reached, and recovers after slots free up', async () => {
        // Each in-flight fetch buffers up to the body cap host-side, so total buffering must stay bounded.
        // Hold all slots open with a gated fetch, prove the next call rejects fast, then drain and recover.
        let release;
        const gate = new Promise(r => (release = r));
        const blocking = ((_url, _init, use) => gate.then(() => use(cannedResponse('{}', {}))));
        const inflight = [];
        for (let i = 0; i < 16; i++) {
            inflight.push((0, plugin_net_1.performPluginFetch)('https://api.example.com/t', {}, { fetch: blocking }));
        }
        // The 17th call reserves no slot — it rejects immediately without awaiting the gate.
        await expect((0, plugin_net_1.performPluginFetch)('https://api.example.com/t', {}, { fetch: blocking })).rejects.toThrow(/too many concurrent/i);
        release();
        await Promise.all(inflight);
        // Slots freed → a fresh fetch succeeds again.
        const sink = {};
        await expect((0, plugin_net_1.performPluginFetch)('https://api.example.com/t', {}, { fetch: fakeSafeFetch(cannedResponse('{}', {}), sink) })).resolves.toMatchObject({ ok: true });
    });
    it('treats a null init as no options and never holds a concurrency slot for it', async () => {
        // A sandboxed plugin can send `null` across the worker bridge; the `= {}` default only covers undefined.
        const sink = {};
        const fetcher = fakeSafeFetch(cannedResponse('{}', {}), sink);
        for (let i = 0; i < 17; i++) {
            await expect((0, plugin_net_1.performPluginFetch)('https://api.example.com/t', null, { fetch: fetcher })).resolves.toMatchObject({
                ok: true,
            });
        }
        expect(sink.init?.method).toBe('GET');
    });
});
describe('effectiveNetAllow', () => {
    it('adds the https origin of each named config URL to the static allowlist', () => {
        expect((0, plugin_net_1.effectiveNetAllow)(['api.static.com'], ['baseUrl'], { baseUrl: 'https://chat.acme.com' })).toEqual([
            'api.static.com',
            'https://chat.acme.com:443',
        ]);
    });
    it('grants a config host over https on its configured port only', () => {
        const allow = (0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'https://chat.example.com' });
        expect((0, plugin_net_1.isNetHostAllowed)(allow, 'https://chat.example.com/api')).toBe(true);
        expect((0, plugin_net_1.isNetHostAllowed)(allow, 'https://chat.example.com:443/api')).toBe(true);
        expect((0, plugin_net_1.isNetHostAllowed)(allow, 'http://chat.example.com/')).toBe(false);
        expect((0, plugin_net_1.isNetHostAllowed)(allow, 'http://chat.example.com:6379/')).toBe(false);
        expect((0, plugin_net_1.isNetHostAllowed)(allow, 'https://chat.example.com:6379/')).toBe(false);
        const withPort = (0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'https://host.com:8443' });
        expect((0, plugin_net_1.isNetHostAllowed)(withPort, 'https://host.com:8443/x')).toBe(true);
        expect((0, plugin_net_1.isNetHostAllowed)(withPort, 'https://host.com/x')).toBe(false);
        expect((0, plugin_net_1.isNetHostAllowed)(withPort, 'http://host.com:8443/x')).toBe(false);
    });
    it('ignores missing / non-string / non-https / credentialed config values', () => {
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], {})).toEqual([]);
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 42 })).toEqual([]);
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'not a url' })).toEqual([]);
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'http://x' })).toEqual([]); // https-only
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'https://u:p@x' })).toEqual([]); // no credentials
    });
    it("never admits the '*' wildcard sentinel from a config value, and preserves an explicit port", () => {
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'https://*' })).toEqual([]); // bare '*' would open all hosts
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'https://%2A' })).toEqual([]); // encoded '*' too
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'https://*:443/x' })).toEqual([]);
        expect((0, plugin_net_1.effectiveNetAllow)([], ['baseUrl'], { baseUrl: 'https://host.com:8443' })).toEqual(['https://host.com:8443']);
    });
});
