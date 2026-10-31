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
const undici_1 = require("undici");
const node_http_1 = require("node:http");
const safe_link_preview_1 = require("./safe-link-preview");
const ssrfGuard = __importStar(require("../../common/security/ssrf-guard"));
/**
 * This generator exists because the library's own delegates to a package with an unfixed SSRF
 * advisory, and its input is attacker-influenced — a URL pasted into a message makes this server
 * fetch it. So the tests that matter most are not about parsing: they are that nothing is fetched
 * outside the guard, that non-http schemes never reach the fetch layer at all, and that a hostile or
 * broken response can never turn into a failed send.
 */
describe('generateSafeLinkPreview', () => {
    let withSafeFetch;
    /** Stand in for the guard, handing the callback a response with the given body/headers. */
    const respondWith = (body, contentType = 'text/html', ok = true) => {
        withSafeFetch = jest.spyOn(ssrfGuard, 'withSafeFetch').mockImplementation((_url, _init, use) => Promise.resolve(use({
            ok,
            headers: { get: (name) => (name === 'content-type' ? contentType : null) },
            body: null,
            text: () => Promise.resolve(body),
        })));
    };
    afterEach(() => jest.restoreAllMocks());
    describe('the fetch never escapes the guard', () => {
        it('goes through withSafeFetch, not a bare fetch', async () => {
            respondWith('<title>Example</title>');
            await (0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com/a');
            expect(withSafeFetch).toHaveBeenCalledTimes(1);
            expect(withSafeFetch.mock.calls[0][0]).toBe('https://example.com/a');
        });
        // A URL in a message is caller-supplied, so fetching it is session egress like a media URL: it
        // has to leave through the session's proxy rather than from the gateway's own address (#1626).
        it('hands the guard the session proxy for a proxied session', async () => {
            respondWith('<title>Example</title>');
            await (0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com/a', { sessionProxyUrl: 'socks5://proxy.invalid:1080' });
            expect(withSafeFetch.mock.calls[0][3]).toEqual({
                proxyUrl: 'socks5://proxy.invalid:1080',
                followRedirects: true,
            });
        });
        it('leaves an unproxied session fetching direct', async () => {
            respondWith('<title>Example</title>');
            await (0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com/a');
            expect(withSafeFetch.mock.calls[0][3]).toEqual({ proxyUrl: undefined, followRedirects: true });
        });
        it('fetches direct when the operator switches the session-proxy URL fetch off', async () => {
            process.env.SESSION_PROXY_URL_FETCH = 'false';
            respondWith('<title>Example</title>');
            try {
                await (0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com/a', { sessionProxyUrl: 'socks5://proxy.invalid:1080' });
            }
            finally {
                delete process.env.SESSION_PROXY_URL_FETCH;
            }
            expect(withSafeFetch.mock.calls[0][3]).toEqual({ proxyUrl: undefined, followRedirects: true });
        });
        // The guard rejects a blocked destination by throwing. That must surface as "no preview", never
        // as a failed send — and never as a leaked internal address in an error message.
        it('returns nothing when the guard refuses the destination', async () => {
            jest
                .spyOn(ssrfGuard, 'withSafeFetch')
                .mockRejectedValue(new ssrfGuard.SsrfBlockedError('blocked 169.254.169.254'));
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('http://169.254.169.254/latest/meta-data')).resolves.toBeUndefined();
        });
        // Non-http schemes are the shapes an attacker reaches for, and the fetch layer should never be
        // asked about them at all.
        it.each(['file:///etc/passwd', 'ftp://internal/secrets', 'javascript:alert(1)', 'data:text/html,x'])('refuses %s without fetching', async (raw) => {
            const spy = jest.spyOn(ssrfGuard, 'withSafeFetch');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)(raw)).resolves.toBeUndefined();
            expect(spy).not.toHaveBeenCalled();
        });
        it('does not fetch an unparseable URL', async () => {
            const spy = jest.spyOn(ssrfGuard, 'withSafeFetch');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('http://[not a host]')).resolves.toBeUndefined();
            expect(spy).not.toHaveBeenCalled();
        });
        // A bare host is what people actually paste, and treating it as https is what a reader does.
        it('adds https to a scheme-less URL rather than refusing it', async () => {
            respondWith('<title>Example</title>');
            await (0, safe_link_preview_1.generateSafeLinkPreview)('example.com/path');
            expect(withSafeFetch.mock.calls[0][0]).toBe('https://example.com/path');
        });
    });
    // A bare domain that answers with its www host, an http link moved to https and every short link
    // arrive as a redirect. Each hop is checked by the guard again before it is fetched.
    describe('follows a redirect through the guard', () => {
        let server;
        let origin;
        const allowed = process.env.SSRF_ALLOWED_HOSTS;
        beforeAll(async () => {
            server = (0, node_http_1.createServer)((req, res) => {
                if (req.url === '/short')
                    res.writeHead(301, { location: '/page' }).end();
                // Reachable but not allowlisted: the same server under a hostname the guard refuses, so a hop
                // followed without the guard would land on the page and produce a preview.
                else if (req.url === '/internal')
                    res.writeHead(302, { location: `http://localhost:${server.address().port}/page` }).end();
                else
                    res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Landing</title>');
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            origin = `http://127.0.0.1:${server.address().port}`;
            process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1';
        });
        afterAll(async () => {
            if (allowed === undefined)
                delete process.env.SSRF_ALLOWED_HOSTS;
            else
                process.env.SSRF_ALLOWED_HOSTS = allowed;
            await new Promise(resolve => server.close(resolve));
        });
        it('previews the page a redirect lands on, under the URL that was sent', async () => {
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)(`${origin}/short`)).resolves.toEqual({
                'matched-text': `${origin}/short`,
                'canonical-url': `${origin}/short`,
                title: 'Landing',
            });
        });
        it('returns nothing when a hop points at a blocked address', async () => {
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)(`${origin}/internal`)).resolves.toBeUndefined();
        });
    });
    describe('the HTML byte prefix', () => {
        const bytes = (...chunks) => chunks.map(chunk => Buffer.from(chunk));
        it.each([
            ['an oversized first chunk', bytes(' '.repeat(64) + '<title>Beyond</title>'), undefined],
            ['an oversized final chunk', bytes(' '.repeat(48), ' '.repeat(16) + '<title>Beyond</title>'), undefined],
            ['Open Graph beyond the cap', bytes(' '.repeat(64) + '<meta property="og:title" content="Beyond">'), undefined],
            ['valid prefix metadata', bytes('<title>Within</title>' + ' '.repeat(44) + '<title>Beyond</title>'), 'Within'],
            ['metadata ending at the cap', bytes(' '.repeat(44) + '<title>Exact</title>'), 'Exact'],
            [
                'a split multibyte character',
                [
                    Buffer.concat([Buffer.from(' '.repeat(62)), Buffer.from([0xc3])]),
                    Buffer.concat([Buffer.from([0xa9]), Buffer.from('<title>Beyond</title>')]),
                ],
                undefined,
            ],
        ])('reads only the allowed bytes for %s', async (_name, chunks, title) => {
            let index = 0;
            const cancel = jest.fn();
            const body = new ReadableStream({
                pull(controller) {
                    if (index < chunks.length)
                        controller.enqueue(chunks[index++]);
                    else
                        controller.close();
                },
                cancel,
            }, { highWaterMark: 0 });
            const response = new undici_1.Response(body, { headers: { 'content-type': 'text/html' } });
            jest.spyOn(ssrfGuard, 'withSafeFetch').mockImplementation((_url, _init, use) => Promise.resolve(use(response)));
            const preview = await (0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com', { maxBytes: 64 });
            expect(preview?.title).toBe(title);
            expect(cancel).toHaveBeenCalledTimes(1);
            expect(index).toBe(chunks.length);
        });
    });
    describe('what it extracts', () => {
        it('prefers Open Graph metadata', async () => {
            respondWith(`<html><head><title>Fallback</title>
         <meta property="og:title" content="Real title">
         <meta property="og:description" content="Real description"></head></html>`);
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toEqual({
                'matched-text': 'https://example.com',
                'canonical-url': 'https://example.com/',
                title: 'Real title',
                description: 'Real description',
            });
        });
        it('falls back to the document title', async () => {
            respondWith('<html><head><title>Just a title</title></head></html>');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: 'Just a title',
            });
        });
        // matched-text is what WhatsApp anchors the preview to in the message body, so it must be the
        // text that appeared there — not the normalised URL that was fetched.
        it('keeps the matched text verbatim while reporting the normalised URL separately', async () => {
            respondWith('<title>T</title>');
            const info = await (0, safe_link_preview_1.generateSafeLinkPreview)('example.com');
            expect(info?.['matched-text']).toBe('example.com');
            expect(info?.['canonical-url']).toBe('https://example.com/');
        });
        // WhatsApp requires a title. The hostname is a fact about the URL rather than an invention.
        it('uses the hostname when the page has a description but no title', async () => {
            respondWith('<meta property="og:description" content="Only a description">');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://news.example.com/a')).resolves.toMatchObject({
                title: 'news.example.com',
                description: 'Only a description',
            });
        });
        it('decodes the entities that show up in real metadata', async () => {
            respondWith('<meta property="og:title" content="Tom &amp; Jerry&#39;s &quot;show&quot;">');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: 'Tom & Jerry\'s "show"',
            });
        });
        // WordPress and most CMSs write curly quotes, dashes and ellipses as numeric references, and older
        // pages write accents by name: left as written they reach the recipient as literal text.
        it('decodes numeric references, decimal and hexadecimal, and the common named ones', async () => {
            respondWith('<meta property="og:title" content="Don&#8217;t panic &#8211; a guide &amp; more">' +
                '<meta property="og:description" content="Caf&eacute; &#x2014; 5 min read &hellip; &copy; 2026">');
            // Code points rather than the characters, so the expectation reads the same in any editor.
            const text = (...parts) => parts.map(part => (typeof part === 'number' ? String.fromCodePoint(part) : part)).join('');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: text('Don', 0x2019, 't panic ', 0x2013, ' a guide & more'),
                description: text('Caf', 0xe9, ' ', 0x2014, ' 5 min read ', 0x2026, ' ', 0xa9, ' 2026'),
            });
        });
        it('leaves a reference that names no character, or one it does not know, as written', async () => {
            respondWith('<meta property="og:title" content="&#0; &#xD800; &#1114112; &#9; &#150; &notanentity; &#x;">');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: '&#0; &#xD800; &#1114112; &#9; &#150; &notanentity; &#x;',
            });
        });
        it('does not decode a numeric reference twice', async () => {
            respondWith('<meta property="og:title" content="&amp;#39; &amp;#x41;">');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: '&#39; &#x41;',
            });
        });
        // Decoding the ampersand first would turn `&amp;lt;` into `<`.
        it('does not double-decode', async () => {
            respondWith('<meta property="og:title" content="&amp;lt;script&amp;gt;">');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: '&lt;script&gt;',
            });
        });
        it('reads content written before property, and a ">" inside a value', async () => {
            respondWith('<meta content="Shop > Shoes" property="og:title"/><meta name="description" content="Size 42 > 41">');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: 'Shop > Shoes',
                description: 'Size 42 > 41',
            });
        });
        it('keeps a quote of the other kind inside a value', async () => {
            respondWith(`<meta property="og:title" content="Don't Panic"><meta name='description' content='say "hi"'>`);
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toMatchObject({
                title: "Don't Panic",
                description: 'say "hi"',
            });
        });
    });
    // The scan runs on the event loop, where the fetch timeout cannot interrupt it. A page of unclosed
    // tags made the old attribute patterns backtrack from every tag to the end of the body.
    describe('a hostile page cannot stall the process', () => {
        it.each([
            ['unclosed <meta tags', '<meta '],
            ['unclosed <title tags', '<title'],
        ])('scans a body of %s in linear time', async (_label, unit) => {
            respondWith(unit.repeat((128 * 1024) / unit.length));
            const started = Date.now();
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toBeUndefined();
            expect(Date.now() - started).toBeLessThan(500);
        });
    });
    describe('when there is nothing worth showing', () => {
        it('returns nothing for a page with neither title nor description', async () => {
            respondWith('<html><body>no metadata here</body></html>');
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toBeUndefined();
        });
        // Reading a non-document means pulling an arbitrary binary into memory for no metadata.
        it.each(['image/png', 'application/octet-stream', 'application/pdf'])('returns nothing for a %s response', async (contentType) => {
            respondWith('<title>ignored</title>', contentType);
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toBeUndefined();
        });
        it('returns nothing for a non-ok response', async () => {
            respondWith('<title>Not found</title>', 'text/html', false);
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toBeUndefined();
        });
        // A preview is decoration. A slow or broken site must never turn into a failed message send.
        it('returns nothing when the fetch throws', async () => {
            jest.spyOn(ssrfGuard, 'withSafeFetch').mockRejectedValue(new Error('socket hang up'));
            await expect((0, safe_link_preview_1.generateSafeLinkPreview)('https://example.com')).resolves.toBeUndefined();
        });
    });
});
