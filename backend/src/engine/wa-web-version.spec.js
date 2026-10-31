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
const mockWarn = jest.fn();
jest.mock('../common/services/logger.service', () => ({
    createLogger: () => ({ warn: mockWarn, log: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const wa_web_version_1 = require("./wa-web-version");
// Fixed reference instant (the #684 report timestamp) so the suite never depends on wall-clock time.
const FIXED_NOW = Date.parse('2026-07-11T07:05:00Z');
// Build a registry entry with released/expire relative to FIXED_NOW.
const entry = (version, ageMs, ttlMs, beta = false) => {
    const released = new Date(FIXED_NOW - ageMs).toISOString();
    const expire = new Date(FIXED_NOW + ttlMs).toISOString();
    return { version, beta, released, expire };
};
describe('pickSettledWebVersion', () => {
    const now = FIXED_NOW;
    const settled = (extra = 0) => wa_web_version_1.WEB_VERSION_SETTLE_MS + extra;
    it('falls back to currentVersion when versions is missing or not an array', () => {
        expect((0, wa_web_version_1.pickSettledWebVersion)(undefined, now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
        expect((0, wa_web_version_1.pickSettledWebVersion)(null, now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
        expect((0, wa_web_version_1.pickSettledWebVersion)('nope', now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
    });
    it('falls back to currentVersion (or null) when no build qualifies', () => {
        expect((0, wa_web_version_1.pickSettledWebVersion)([], now, '2.3000.1-alpha')).toBe('2.3000.1-alpha');
        expect((0, wa_web_version_1.pickSettledWebVersion)([], now, null)).toBeNull();
    });
    it('prefers a settled build over a too-fresh currentVersion', () => {
        // currentVersion is 40 minutes old (the #684 scenario); one build is 2 days old.
        const versions = [
            entry('2.3000.1043012667-alpha', 40 * 60 * 1000, 60 * 86_400_000), // fresh — skip
            entry('2.3000.OLD-BUILD-alpha', 2 * 86_400_000, 50 * 86_400_000), // settled — pick
        ];
        expect((0, wa_web_version_1.pickSettledWebVersion)(versions, now, '2.3000.1043012667-alpha')).toBe('2.3000.OLD-BUILD-alpha');
    });
    it('skips builds newer than the settle window even if currentVersion is fresh', () => {
        const versions = [entry('2.3000.FRESH-alpha', 60 * 60 * 1000, 60 * 86_400_000)]; // 1h old
        expect((0, wa_web_version_1.pickSettledWebVersion)(versions, now, '2.3000.FALLBACK-alpha')).toBe('2.3000.FALLBACK-alpha'); // none settled → fallback
    });
    it('picks the NEWEST qualifying (settled) build', () => {
        const versions = [
            entry('2.3000.OLD-alpha', 10 * 86_400_000, 50 * 86_400_000),
            entry('2.3000.NEW-alpha', settled() + 60_000, 50 * 86_400_000), // just past settle, newest qualifying
            entry('2.3000.MID-alpha', 5 * 86_400_000, 50 * 86_400_000),
        ];
        expect((0, wa_web_version_1.pickSettledWebVersion)(versions, now, '2.3000.FALLBACK-alpha')).toBe('2.3000.NEW-alpha');
    });
    it('skips beta builds', () => {
        const versions = [
            entry('2.3000.BETA-alpha', settled(), 50 * 86_400_000, true), // beta=true → skip
            entry('2.3000.STABLE-alpha', settled() + 1000, 50 * 86_400_000, false),
        ];
        expect((0, wa_web_version_1.pickSettledWebVersion)(versions, now, '2.3000.BETA-alpha')).toBe('2.3000.STABLE-alpha');
    });
    it('skips already-expired builds', () => {
        const versions = [
            entry('2.3000.EXPIRED-alpha', settled(), -1000, false), // expire in the past
            entry('2.3000.LIVE-alpha', settled() + 1000, 50 * 86_400_000, false),
        ];
        expect((0, wa_web_version_1.pickSettledWebVersion)(versions, now, '2.3000.EXPIRED-alpha')).toBe('2.3000.LIVE-alpha');
    });
    it('skips malformed entries (non-string version / unparseable released)', () => {
        const versions = [
            { version: 123, beta: false, released: new Date(now - settled()).toISOString() }, // non-string version
            { version: '2.3000.OK-alpha', beta: false, released: 'not-a-date' }, // bad released
            entry('2.3000.GOOD-alpha', settled() + 1000, 50 * 86_400_000, false),
        ];
        expect((0, wa_web_version_1.pickSettledWebVersion)(versions, now, null)).toBe('2.3000.GOOD-alpha');
    });
});
describe('resolveCurrentWebVersion', () => {
    beforeEach(() => (0, wa_web_version_1.__resetWebVersionCache)());
    afterEach(() => (0, wa_web_version_1.__resetWebVersionCache)());
    const json = (body) => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
    });
    it('pins a settled build from versions[] over the raw currentVersion', async () => {
        const fetcher = jest.fn(() => Promise.resolve(json({
            currentBeta: null,
            currentVersion: '2.3000.FRESH-alpha',
            versions: [
                {
                    version: '2.3000.FRESH-alpha',
                    beta: false,
                    released: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
                    expire: '2099-01-01T00:00:00Z',
                },
                {
                    version: '2.3000.SETTLED-alpha',
                    beta: false,
                    released: new Date(Date.now() - 2 * 86_400_000).toISOString(),
                    expire: '2099-01-01T00:00:00Z',
                },
            ],
        })));
        await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.SETTLED-alpha');
    });
    it('falls back to currentVersion when the registry carries no versions[]', async () => {
        const fetcher = jest.fn(() => Promise.resolve(json({ currentBeta: null, currentVersion: '2.3000.SOLO-alpha' })));
        await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.SOLO-alpha');
    });
    // The registry deletes a build's HTML about 60 days after release. A pin cached for the life of the
    // process ended up pointing at a 404, and the page silently loaded the live build (#488 class).
    describe('on a long-running process', () => {
        const DAY = 86_400_000;
        let now = FIXED_NOW;
        beforeEach(() => {
            now = FIXED_NOW;
            jest.spyOn(Date, 'now').mockImplementation(() => now);
        });
        afterEach(() => jest.restoreAllMocks());
        it('re-reads the registry once the pin is a day old', async () => {
            const fetcher = jest
                .fn()
                .mockResolvedValueOnce(json({ currentVersion: '2.3000.OLD-alpha' }))
                .mockResolvedValueOnce(json({ currentVersion: '2.3000.NEW-alpha' }));
            await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.OLD-alpha');
            now += DAY - 1;
            await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.OLD-alpha');
            expect(fetcher).toHaveBeenCalledTimes(1);
            now += 1;
            await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.NEW-alpha');
            expect(fetcher).toHaveBeenCalledTimes(2);
        });
        it('keeps the previous pin when a refresh fails, rather than dropping it', async () => {
            const fetcher = jest
                .fn()
                .mockResolvedValueOnce(json({ currentVersion: '2.3000.OLD-alpha' }))
                .mockRejectedValue(new Error('boom'));
            await (0, wa_web_version_1.resolveCurrentWebVersion)(fetcher);
            now += DAY;
            await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.OLD-alpha');
            // Inside the failure backoff too: no second fetch, and still the previous pin.
            await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.OLD-alpha');
            expect(fetcher).toHaveBeenCalledTimes(2);
        });
    });
});
// Remote-HTML pins execute inside the authenticated web.whatsapp.com origin with no integrity
// check, so taking one MUST be visible to the operator — once per process, with the source and
// the opt-outs. 'off' (first-party) is the only path that must stay silent.
describe('resolveWebVersionPin remote-trust warning', () => {
    const ORIGINAL_ENV = process.env.WWEBJS_WEB_VERSION;
    const json = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
    beforeEach(() => {
        (0, wa_web_version_1.__resetWebVersionCache)();
        mockWarn.mockClear();
    });
    afterEach(() => {
        (0, wa_web_version_1.__resetWebVersionCache)();
        if (ORIGINAL_ENV === undefined)
            delete process.env.WWEBJS_WEB_VERSION;
        else
            process.env.WWEBJS_WEB_VERSION = ORIGINAL_ENV;
    });
    it('warns once (with version, source URL, and opt-out) when an exact version is pinned', async () => {
        process.env.WWEBJS_WEB_VERSION = '2.3000.1234-alpha';
        await (0, wa_web_version_1.resolveWebVersionPin)();
        await (0, wa_web_version_1.resolveWebVersionPin)(); // second resolve must NOT re-warn
        expect(mockWarn).toHaveBeenCalledTimes(1);
        const [message, meta] = mockWarn.mock.calls[0];
        expect(message).toContain('WITHOUT an integrity check');
        expect(meta.webVersion).toBe('2.3000.1234-alpha');
        expect(meta.remotePath).toContain('2.3000.1234-alpha');
        expect(meta.optOut).toContain('WWEBJS_WEB_VERSION=off');
    });
    it('stays silent when pinning is off (first-party build)', async () => {
        process.env.WWEBJS_WEB_VERSION = 'off';
        await expect((0, wa_web_version_1.resolveWebVersionPin)()).resolves.toBeUndefined();
        expect(mockWarn).not.toHaveBeenCalled();
    });
    it('warns for the auto-resolved registry pin (the default posture)', async () => {
        delete process.env.WWEBJS_WEB_VERSION;
        const fetcher = jest.fn(() => Promise.resolve(json({ currentVersion: '2.3000.SOLO-alpha' })));
        await (0, wa_web_version_1.resolveWebVersionPin)(fetcher);
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('WITHOUT an integrity check'), expect.objectContaining({ webVersion: '2.3000.SOLO-alpha' }));
    });
});
// A failed resolve degrades the engine to whatsapp-web.js's own version selection — the #488 class
// the pin exists to prevent. It used to do so in total silence, so the operator had nothing to grep.
describe('resolveCurrentWebVersion failure warning', () => {
    const json = (body) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
    beforeEach(() => {
        (0, wa_web_version_1.__resetWebVersionCache)();
        mockWarn.mockClear();
    });
    afterEach(() => (0, wa_web_version_1.__resetWebVersionCache)());
    const failureMeta = () => mockWarn.mock.calls[0][1];
    it('warns when the registry cannot be reached', async () => {
        const fetcher = jest.fn(() => Promise.reject(new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com')));
        await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBeNull();
        expect(mockWarn).toHaveBeenCalledTimes(1);
        const meta = failureMeta();
        expect(meta.action).toBe('web_version_resolve_failed');
        expect(meta.reason).toContain('ENOTFOUND');
        expect(meta.registry).toBe(wa_web_version_1.WA_VERSION_REGISTRY_URL);
        expect(meta.remedy).toContain('WWEBJS_WEB_VERSION');
    });
    it('warns when the registry answers a non-ok status', async () => {
        const fetcher = jest.fn(() => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) }));
        await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBeNull();
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(failureMeta().reason).toContain('503');
    });
    it('warns when the registry answers with no usable build', async () => {
        const fetcher = jest.fn(() => Promise.resolve(json({ currentVersion: null, versions: [] })));
        await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBeNull();
        expect(mockWarn).toHaveBeenCalledTimes(1);
        expect(failureMeta().reason).toContain('no usable build');
    });
    it('stays silent on a successful resolve', async () => {
        const fetcher = jest.fn(() => Promise.resolve(json({ currentVersion: '2.3000.SOLO-alpha' })));
        await expect((0, wa_web_version_1.resolveCurrentWebVersion)(fetcher)).resolves.toBe('2.3000.SOLO-alpha');
        expect(mockWarn).not.toHaveBeenCalled();
    });
    // The warning repeats so it survives a bounded log window, but the existing backoff is what keeps
    // that from becoming a per-call flood: the second call returns before the fetcher is even reached.
    it('does not re-warn inside the failure backoff window', async () => {
        const fetcher = jest.fn(() => Promise.reject(new Error('boom')));
        await (0, wa_web_version_1.resolveCurrentWebVersion)(fetcher);
        await (0, wa_web_version_1.resolveCurrentWebVersion)(fetcher);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(mockWarn).toHaveBeenCalledTimes(1);
    });
});
// whatsapp-web.js fetches a remote pin's HTML with no timeout and, non-strict, loads the live build
// when that fails, silently. The HTML is now fetched here, bounded, and served as a strict local file.
describe('resolveWebVersionPin with a cache directory', () => {
    const ORIGINAL_ENV = process.env.WWEBJS_WEB_VERSION;
    const VERSION = '2.3000.1234';
    const HTML = `<!DOCTYPE html><html><head></head><body>${'x'.repeat(2048)}</body></html>`;
    let dir;
    const page = (body, status = 200) => ({ ok: status < 400, status, text: () => Promise.resolve(body) });
    const htmlWarning = () => mockWarn.mock.calls.find(([, meta]) => meta?.action === 'web_version_html_unavailable')?.[1];
    beforeEach(() => {
        (0, wa_web_version_1.__resetWebVersionCache)();
        mockWarn.mockClear();
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-web-cache-'));
        process.env.WWEBJS_WEB_VERSION = VERSION;
    });
    afterEach(() => {
        jest.useRealTimers();
        (0, wa_web_version_1.__resetWebVersionCache)();
        fs.rmSync(dir, { recursive: true, force: true });
        if (ORIGINAL_ENV === undefined)
            delete process.env.WWEBJS_WEB_VERSION;
        else
            process.env.WWEBJS_WEB_VERSION = ORIGINAL_ENV;
    });
    it('writes the HTML and answers a strict local cache for it', async () => {
        const fetcher = jest.fn(() => Promise.resolve(page(HTML)));
        await expect((0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir)).resolves.toEqual({
            webVersion: VERSION,
            webVersionCache: { type: 'local', path: dir, strict: true },
        });
        expect(fs.readFileSync(path.join(dir, `${VERSION}.html`), 'utf8')).toBe(HTML);
        expect(fs.readdirSync(dir)).toEqual([`${VERSION}.html`]);
        expect(htmlWarning()).toBeUndefined();
    });
    it('sends URL credentials as a Basic header, since fetch refuses a URL that carries them', async () => {
        process.env.WWEBJS_WEB_VERSION_REMOTE_PATH = 'https://u:p@mirror.example/{version}.html';
        try {
            const fetcher = jest.fn(() => Promise.resolve(page(HTML)));
            await expect((0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir)).resolves.toMatchObject({
                webVersionCache: { type: 'local' },
            });
            expect(fetcher).toHaveBeenCalledWith(`https://mirror.example/${VERSION}.html`, expect.objectContaining({ headers: { Authorization: 'Basic dTpw' } }));
            fetcher.mockResolvedValue(page('', 503));
            (0, wa_web_version_1.__resetWebVersionCache)();
            await (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
            expect(htmlWarning()?.remotePath).toBe(`https://mirror.example/${VERSION}.html`);
            const logged = JSON.stringify(mockWarn.mock.calls);
            expect(logged).not.toContain('u:p@');
        }
        finally {
            delete process.env.WWEBJS_WEB_VERSION_REMOTE_PATH;
        }
    });
    it('removes a build no start has written for a week, and keeps a recent one', async () => {
        const stale = path.join(dir, '2.3000.1.html');
        const recent = path.join(dir, '2.3000.2.html');
        fs.writeFileSync(stale, HTML);
        fs.writeFileSync(recent, HTML);
        const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);
        const fetcher = jest.fn(() => Promise.resolve(page(HTML)));
        await (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
        expect(fs.readdirSync(dir).sort()).toEqual(['2.3000.1234.html', '2.3000.2.html']);
    });
    it('gives up at the bound and drops the pin with a named warning', async () => {
        jest.useFakeTimers();
        const fetcher = jest.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
        const pending = (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
        await jest.advanceTimersByTimeAsync(wa_web_version_1.PINNED_HTML_TIMEOUT_MS);
        await expect(pending).resolves.toBeUndefined();
        const warning = htmlWarning();
        expect(warning?.webVersion).toBe(VERSION);
        expect(warning?.reason).toContain(`${wa_web_version_1.PINNED_HTML_TIMEOUT_MS} ms`);
        expect(warning?.remotePath).toContain(VERSION);
    });
    it.each([
        ['a non-ok status', page(HTML, 404), 'HTTP 404'],
        ['a body too short to be the page', page('<html></html>'), 'not a WhatsApp Web page'],
        ['a body that is not HTML', page('x'.repeat(4096)), 'not a WhatsApp Web page'],
    ])('drops the pin on %s and writes nothing', async (_label, response, reason) => {
        const fetcher = jest.fn(() => Promise.resolve(response));
        await expect((0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir)).resolves.toBeUndefined();
        expect(htmlWarning()?.reason).toContain(reason);
        expect(fs.readdirSync(dir)).toEqual([]);
    });
    it('fetches a build once, shares a concurrent fetch, and retries after a failure', async () => {
        const fetcher = jest.fn().mockResolvedValueOnce(page('', 503)).mockResolvedValue(page(HTML));
        await expect((0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir)).resolves.toBeUndefined();
        const [a, b] = await Promise.all([
            (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir),
            (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir),
        ]);
        await (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
        expect(a?.webVersionCache.type).toBe('local');
        expect(b?.webVersionCache.type).toBe('local');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
    // An auto pin moves to a newer build roughly daily, so keeping every build's page in memory grew
    // without bound over a long uptime. Only the current build is kept; an older one is fetched again.
    it('keeps only the latest build in memory', async () => {
        const fetcher = jest.fn(() => Promise.resolve(page(HTML)));
        await (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
        process.env.WWEBJS_WEB_VERSION = '2.3000.5678';
        await (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
        await (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
        process.env.WWEBJS_WEB_VERSION = VERSION;
        await (0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('refuses a version that is not a build number, without fetching or writing', async () => {
        process.env.WWEBJS_WEB_VERSION = '../../etc/x';
        const fetcher = jest.fn(() => Promise.resolve(page(HTML)));
        await expect((0, wa_web_version_1.resolveWebVersionPin)(fetcher, dir)).resolves.toBeUndefined();
        expect(fetcher).not.toHaveBeenCalled();
        expect(fs.readdirSync(dir)).toEqual([]);
        expect(htmlWarning()).toBeDefined();
    });
    it('keeps the remote shape when no cache directory is given', async () => {
        const fetcher = jest.fn();
        await expect((0, wa_web_version_1.resolveWebVersionPin)(fetcher)).resolves.toMatchObject({
            webVersionCache: { type: 'remote' },
        });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
