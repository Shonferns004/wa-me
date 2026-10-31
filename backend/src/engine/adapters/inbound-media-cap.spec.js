"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const concurrency_limiter_1 = require("../../common/utils/concurrency-limiter");
const logger_service_1 = require("../../common/services/logger.service");
const baileys_events_1 = require("./baileys-events");
const whatsapp_web_js_adapter_1 = require("./whatsapp-web-js.adapter");
const inbound_media_cap_1 = require("./inbound-media-cap");
/**
 * Serve a message's media download from `download`: production reads it through the page
 * (downloadCappedMedia), and the same mock stays reachable as `downloadMedia` for assertions.
 */
const onPage = (download) => ({
    downloadMedia: download,
    client: { pupPage: { evaluate: download } },
});
describe('inbound media cap', () => {
    const ENV = 'MEDIA_DOWNLOAD_MAX_BYTES';
    const CONC = 'INBOUND_MEDIA_CONCURRENCY';
    const TMO = 'MEDIA_DOWNLOAD_TIMEOUT_MS';
    const orig = process.env[ENV];
    const origConc = process.env[CONC];
    const origTmo = process.env[TMO];
    afterEach(() => {
        if (orig === undefined)
            delete process.env[ENV];
        else
            process.env[ENV] = orig;
        if (origConc === undefined)
            delete process.env[CONC];
        else
            process.env[CONC] = origConc;
        if (origTmo === undefined)
            delete process.env[TMO];
        else
            process.env[TMO] = origTmo;
    });
    describe('inboundMediaTimeoutMs', () => {
        it('defaults to 30000', () => {
            delete process.env[TMO];
            expect((0, inbound_media_cap_1.inboundMediaTimeoutMs)()).toBe(30_000);
        });
        it('honors a positive override', () => {
            process.env[TMO] = '5000';
            expect((0, inbound_media_cap_1.inboundMediaTimeoutMs)()).toBe(5000);
        });
        it('falls back to the default for a non-positive/garbage override', () => {
            process.env[TMO] = '0';
            expect((0, inbound_media_cap_1.inboundMediaTimeoutMs)()).toBe(30_000);
            process.env[TMO] = 'abc';
            expect((0, inbound_media_cap_1.inboundMediaTimeoutMs)()).toBe(30_000);
        });
    });
    describe('withInboundDownloadTimeout', () => {
        it('returns the value when the download settles before the deadline', async () => {
            const onTimeout = jest.fn();
            await expect((0, inbound_media_cap_1.withInboundDownloadTimeout)(Promise.resolve('buf'), 1000, onTimeout)).resolves.toBe('buf');
            expect(onTimeout).not.toHaveBeenCalled();
        });
        it('resolves null and runs onTimeout when the download outlasts the deadline', async () => {
            const onTimeout = jest.fn();
            const slow = new Promise(resolve => setTimeout(() => resolve('late'), 1000).unref?.());
            await expect((0, inbound_media_cap_1.withInboundDownloadTimeout)(slow, 5, onTimeout)).resolves.toBeNull();
            expect(onTimeout).toHaveBeenCalledTimes(1);
        });
        it('swallows a late rejection from the abandoned download (no unhandled rejection)', async () => {
            let rejectFn = () => undefined;
            const slow = new Promise((_, reject) => {
                rejectFn = reject;
            });
            await expect((0, inbound_media_cap_1.withInboundDownloadTimeout)(slow, 5)).resolves.toBeNull();
            // Reject AFTER the race settled — must not surface as an unhandled rejection.
            rejectFn(new Error('media socket closed'));
            await Promise.resolve();
        });
    });
    describe('inboundMediaConcurrency', () => {
        it('defaults to 4', () => {
            delete process.env[CONC];
            expect((0, inbound_media_cap_1.inboundMediaConcurrency)()).toBe(4);
        });
        it('honors a positive override', () => {
            process.env[CONC] = '2';
            expect((0, inbound_media_cap_1.inboundMediaConcurrency)()).toBe(2);
        });
        it('falls back to the default for a non-positive/garbage override', () => {
            process.env[CONC] = '0';
            expect((0, inbound_media_cap_1.inboundMediaConcurrency)()).toBe(4);
            process.env[CONC] = 'abc';
            expect((0, inbound_media_cap_1.inboundMediaConcurrency)()).toBe(4);
        });
    });
    describe('coerceDeclaredSize', () => {
        it('passes a finite number through', () => {
            expect((0, inbound_media_cap_1.coerceDeclaredSize)(1234)).toBe(1234);
        });
        it('reads a Long-like { toNumber() }', () => {
            expect((0, inbound_media_cap_1.coerceDeclaredSize)({ toNumber: () => 5000 })).toBe(5000);
        });
        it('parses a numeric string', () => {
            expect((0, inbound_media_cap_1.coerceDeclaredSize)('4096')).toBe(4096);
        });
        it("returns 0 for absent/garbage (never NaN — don't pre-gate on unknown)", () => {
            expect((0, inbound_media_cap_1.coerceDeclaredSize)(undefined)).toBe(0);
            expect((0, inbound_media_cap_1.coerceDeclaredSize)(null)).toBe(0);
            expect((0, inbound_media_cap_1.coerceDeclaredSize)('xyz')).toBe(0);
            expect((0, inbound_media_cap_1.coerceDeclaredSize)(NaN)).toBe(0);
            expect((0, inbound_media_cap_1.coerceDeclaredSize)({})).toBe(0);
        });
    });
    describe('inboundMediaMaxBytes', () => {
        it('defaults to 50 MiB', () => {
            delete process.env[ENV];
            expect((0, inbound_media_cap_1.inboundMediaMaxBytes)()).toBe(50 * 1024 * 1024);
        });
        it('honors a positive override', () => {
            process.env[ENV] = '1024';
            expect((0, inbound_media_cap_1.inboundMediaMaxBytes)()).toBe(1024);
        });
        it('falls back to the default for a non-positive/garbage override', () => {
            process.env[ENV] = '0';
            expect((0, inbound_media_cap_1.inboundMediaMaxBytes)()).toBe(50 * 1024 * 1024);
            process.env[ENV] = 'abc';
            expect((0, inbound_media_cap_1.inboundMediaMaxBytes)()).toBe(50 * 1024 * 1024);
        });
    });
    describe('isMediaDownloadEnabled', () => {
        const ENV = 'MEDIA_DOWNLOAD_ENABLED';
        const orig = process.env[ENV];
        afterEach(() => {
            if (orig === undefined)
                delete process.env[ENV];
            else
                process.env[ENV] = orig;
        });
        it('defaults to true when unset', () => {
            delete process.env[ENV];
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(true);
        });
        it('returns false when set to "false"', () => {
            process.env[ENV] = 'false';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(false);
        });
        it('returns false for case/whitespace variants of false', () => {
            process.env[ENV] = 'FALSE';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(false);
            process.env[ENV] = 'False';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(false);
            process.env[ENV] = ' false ';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(false);
            process.env[ENV] = ' FALSE ';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(false);
        });
        it('returns false when set to "0"', () => {
            process.env[ENV] = '0';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(false);
        });
        it('returns false when set to "no"', () => {
            process.env[ENV] = 'no';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(false);
        });
        it('returns true for any other value', () => {
            process.env[ENV] = 'true';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(true);
            process.env[ENV] = '1';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(true);
            process.env[ENV] = 'yes';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(true);
            process.env[ENV] = 'whatever';
            expect((0, inbound_media_cap_1.isMediaDownloadEnabled)()).toBe(true);
        });
    });
    describe('chatHistoryMediaBudgetBytes', () => {
        const ENV = 'CHAT_HISTORY_MEDIA_BUDGET_BYTES';
        const orig = process.env[ENV];
        afterEach(() => {
            if (orig === undefined)
                delete process.env[ENV];
            else
                process.env[ENV] = orig;
        });
        it('defaults to 25 MiB', () => {
            delete process.env[ENV];
            expect((0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)()).toBe(25 * 1024 * 1024);
        });
        it('honors a positive override', () => {
            process.env[ENV] = '1024';
            expect((0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)()).toBe(1024);
        });
        it('falls back to the default for a non-positive/garbage override', () => {
            process.env[ENV] = '0';
            expect((0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)()).toBe(25 * 1024 * 1024);
            process.env[ENV] = 'abc';
            expect((0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)()).toBe(25 * 1024 * 1024);
        });
    });
    describe('capInboundMedia', () => {
        it('keeps media within the cap, encoding base64 exactly once', () => {
            const toBase64 = jest.fn(() => 'BASE64DATA');
            const res = (0, inbound_media_cap_1.capInboundMedia)({
                mimetype: 'image/png',
                filename: 'p.png',
                sizeBytes: 1000,
                toBase64,
                maxBytes: 5000,
            });
            expect(res).toEqual({ mimetype: 'image/png', filename: 'p.png', data: 'BASE64DATA' });
            expect(toBase64).toHaveBeenCalledTimes(1);
        });
        it('drops over-cap media WITHOUT encoding it — marker only, no base64 (the RAM fix)', () => {
            const toBase64 = jest.fn(() => 'SHOULD-NOT-BE-CALLED');
            const res = (0, inbound_media_cap_1.capInboundMedia)({
                mimetype: 'video/mp4',
                filename: 'v.mp4',
                sizeBytes: 99_999,
                toBase64,
                maxBytes: 5000,
            });
            expect(res).toEqual({ mimetype: 'video/mp4', filename: 'v.mp4', omitted: true, sizeBytes: 99_999 });
            expect(res.data).toBeUndefined();
            expect(toBase64).not.toHaveBeenCalled();
        });
        it('treats exactly-at-the-cap as within the limit', () => {
            const res = (0, inbound_media_cap_1.capInboundMedia)({ mimetype: 'image/jpeg', sizeBytes: 5000, toBase64: () => 'D', maxBytes: 5000 });
            expect(res.data).toBe('D');
            expect(res.omitted).toBeUndefined();
        });
    });
});
describe('ingestMediaBudgetBytes', () => {
    // An ingest caller (the status seed) needs more headroom than one HTTP response, but "more" must
    // never mean unbounded: at a 10 MiB per-item cap a 50-item seed would otherwise stack ~650 MiB of
    // base64 on the heap at connect time.
    it('stays finite and scales with the per-item cap', () => {
        const budget = (0, inbound_media_cap_1.ingestMediaBudgetBytes)(10 * 1024 * 1024);
        expect(Number.isFinite(budget)).toBe(true);
        expect(budget).toBeGreaterThan((0, inbound_media_cap_1.ingestMediaBudgetBytes)(1024));
    });
    it('leaves room for several full-size items (the two-videos case that motivated it)', () => {
        const perItem = 10 * 1024 * 1024;
        // ~1.37x accounts for base64 inflation of the decoded cap.
        expect((0, inbound_media_cap_1.ingestMediaBudgetBytes)(perItem)).toBeGreaterThan(2 * perItem * 1.37);
    });
    it('never drops below the response budget, and falls back to it for a garbage cap', () => {
        expect((0, inbound_media_cap_1.ingestMediaBudgetBytes)(1)).toBe((0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)());
        expect((0, inbound_media_cap_1.ingestMediaBudgetBytes)(0)).toBe((0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)());
        expect((0, inbound_media_cap_1.ingestMediaBudgetBytes)(Number.NaN)).toBe((0, inbound_media_cap_1.chatHistoryMediaBudgetBytes)());
    });
});
describe('process-wide inbound media gate (INBOUND_MEDIA_GLOBAL_CONCURRENCY)', () => {
    const KEYS = [
        'INBOUND_MEDIA_GLOBAL_CONCURRENCY',
        'INBOUND_MEDIA_CONCURRENCY',
        'MEDIA_DOWNLOAD_TIMEOUT_MS',
        'MEDIA_DOWNLOAD_MAX_BYTES',
        'MEDIA_DOWNLOAD_ENABLED',
    ];
    const saved = {};
    beforeEach(() => {
        KEYS.forEach(k => (saved[k] = process.env[k]));
        process.env.MEDIA_DOWNLOAD_ENABLED = 'true';
        process.env.MEDIA_DOWNLOAD_MAX_BYTES = String(10 * 1024 * 1024);
        (0, inbound_media_cap_1.__resetGlobalInboundMediaGate)();
    });
    afterEach(() => {
        KEYS.forEach(k => {
            if (saved[k] === undefined)
                delete process.env[k];
            else
                process.env[k] = saved[k];
        });
        (0, inbound_media_cap_1.__resetGlobalInboundMediaGate)();
        jest.useRealTimers();
    });
    const defer = () => {
        let resolve = () => undefined;
        const promise = new Promise(res => (resolve = res));
        return { promise, resolve };
    };
    it('is off unless set to a positive integer', () => {
        for (const value of [undefined, '', '0', 'abc']) {
            if (value === undefined)
                delete process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY;
            else
                process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = value;
            expect((0, inbound_media_cap_1.inboundMediaGlobalConcurrency)()).toBe(0);
            (0, inbound_media_cap_1.__resetGlobalInboundMediaGate)();
            expect((0, inbound_media_cap_1.globalInboundMediaGate)()).toBeNull();
        }
        process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '8';
        expect((0, inbound_media_cap_1.inboundMediaGlobalConcurrency)()).toBe(8);
    });
    it('builds one shared gate and runs tasks directly when off', async () => {
        process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '3';
        const gate = (0, inbound_media_cap_1.globalInboundMediaGate)();
        expect(gate).toBeInstanceOf(concurrency_limiter_1.ConcurrencyLimiter);
        expect((0, inbound_media_cap_1.globalInboundMediaGate)()).toBe(gate);
        (0, inbound_media_cap_1.__resetGlobalInboundMediaGate)();
        process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '0';
        let ran = false;
        const pending = (0, inbound_media_cap_1.runUnderGlobalMediaGate)(() => {
            ran = true;
            return Promise.resolve('ok');
        });
        expect(ran).toBe(true); // no gate: the task starts synchronously
        await expect(pending).resolves.toBe('ok');
    });
    describe('whatsapp-web.js', () => {
        const newAdapter = (sessionId) => new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({ sessionId, sessionDataPath: './data/sessions', puppeteer: {} });
        const cap = (adapter, m) => adapter.capInboundMediaFor(m);
        it('caps downloads in flight across sessions while each session keeps its own cap', async () => {
            process.env.INBOUND_MEDIA_CONCURRENCY = '4';
            process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '2';
            process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '100000';
            let inFlight = 0;
            let maxInFlight = 0;
            const downloads = [];
            const makeMsg = (id) => ({
                id: { _serialized: id },
                _data: { size: 100, mimetype: 'image/png' },
                ...onPage(jest.fn(() => {
                    inFlight++;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    const d = defer();
                    downloads.push(d);
                    return d.promise.finally(() => inFlight--);
                })),
            });
            const a = newAdapter('gate-a');
            const b = newAdapter('gate-b');
            const results = [
                ...['a1', 'a2', 'a3'].map(id => cap(a, makeMsg(id))),
                ...['b1', 'b2', 'b3'].map(id => cap(b, makeMsg(id))),
            ];
            for (let settled = 0; settled < 6; settled++) {
                await new Promise(resolve => setImmediate(resolve));
                expect(inFlight).toBeLessThanOrEqual(2);
                downloads[settled].resolve({ mimetype: 'image/png', data: Buffer.from(`m${settled}`).toString('base64') });
            }
            expect((await Promise.all(results)).every(r => typeof r.data === 'string')).toBe(true);
            expect(maxInFlight).toBe(2);
        });
        it('never downloads a message that timed out while queued on the shared gate', async () => {
            process.env.INBOUND_MEDIA_CONCURRENCY = '4';
            process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '1';
            process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
            jest.useFakeTimers();
            const held = defer();
            const first = {
                id: { _serialized: 'x1' },
                _data: { size: 100, mimetype: 'image/png' },
                ...onPage(jest.fn(() => held.promise)),
            };
            const second = {
                id: { _serialized: 'y1' },
                _data: { size: 100, mimetype: 'image/png' },
                ...onPage(jest.fn()),
            };
            const r1 = cap(newAdapter('gate-x'), first);
            const r2 = cap(newAdapter('gate-y'), second);
            await jest.advanceTimersByTimeAsync(60);
            expect(await r2).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 100 }));
            held.resolve({ mimetype: 'image/png', data: Buffer.from('late').toString('base64') });
            await jest.advanceTimersByTimeAsync(0);
            expect(second.downloadMedia).not.toHaveBeenCalled();
            await r1;
        });
    });
    describe('Baileys', () => {
        const imageMessage = (id) => ({
            key: { id, remoteJid: '15550001111@s.whatsapp.net', fromMe: false },
            messageTimestamp: 1_700_000_000,
            message: { imageMessage: { mimetype: 'image/png', fileLength: 64 } },
        });
        const build = (downloadMediaMessage) => new baileys_events_1.BaileysEvents({
            getSocket: () => ({ updateMediaMessage: jest.fn() }),
            getSocketOrNull: () => null,
            logger: { ...(0, logger_service_1.createLogger)('InboundMediaGateSpec'), warn: () => undefined },
            loadLib: () => Promise.resolve({
                normalizeMessageContent: (c) => c,
                extractMessageContent: (c) => c,
                getContentType: (c) => Object.keys(c ?? {})[0],
                downloadMediaMessage,
            }),
            getFetchDispatcher: () => undefined,
            toNeutralJid: (jid) => jid,
            normalizedSelfJid: () => '6280000000000@s.whatsapp.net',
            inboundLimiter: new concurrency_limiter_1.ConcurrencyLimiter(4),
        });
        it('makes a second session wait for the gate and gives up at the deadline without downloading', async () => {
            process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '1';
            process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '1000';
            jest.useFakeTimers();
            const release = defer();
            const slow = {
                async *[Symbol.asyncIterator]() {
                    await release.promise;
                    yield Buffer.from('first');
                },
                destroy: jest.fn(),
            };
            const downloadA = jest.fn().mockResolvedValue(slow);
            const downloadB = jest.fn();
            // Session A takes the only slot at t=0 with a 1s deadline; session B asks at t=30 with a 50 ms
            // one, so B's deadline (t=80) passes while A still holds the gate.
            const pendingA = build(downloadA).mapMessage(imageMessage('A1'), 'imageMessage');
            await jest.advanceTimersByTimeAsync(30);
            process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
            const pendingB = build(downloadB).mapMessage(imageMessage('B1'), 'imageMessage');
            await jest.advanceTimersByTimeAsync(60);
            expect((await pendingB).media).toEqual(expect.objectContaining({ omitted: true, sizeBytes: 64 }));
            release.resolve();
            await jest.advanceTimersByTimeAsync(0);
            await pendingA;
            expect(downloadA).toHaveBeenCalledTimes(1);
            expect(downloadB).not.toHaveBeenCalled();
        });
        it('frees the slot at the deadline when a download never produces a stream', async () => {
            process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '1';
            process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '50';
            jest.useFakeTimers();
            // Session A's fetch never settles: an expired-media re-upload that the phone never answers.
            const stuck = jest.fn(() => new Promise(() => undefined));
            const stream = {
                // eslint-disable-next-line @typescript-eslint/require-await
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from('ok');
                },
                destroy: jest.fn(),
            };
            const downloadB = jest.fn().mockResolvedValue(stream);
            const pendingA = build(stuck).mapMessage(imageMessage('A2'), 'imageMessage');
            await jest.advanceTimersByTimeAsync(60);
            expect((await pendingA).media).toEqual(expect.objectContaining({ omitted: true }));
            const pendingB = build(downloadB).mapMessage(imageMessage('B2'), 'imageMessage');
            await jest.advanceTimersByTimeAsync(60);
            expect((await pendingB).media).toEqual(expect.objectContaining({ data: Buffer.from('ok').toString('base64') }));
            expect(stuck).toHaveBeenCalledTimes(1);
        });
        it('downloads immediately when the gate is off', async () => {
            process.env.INBOUND_MEDIA_GLOBAL_CONCURRENCY = '0';
            process.env.MEDIA_DOWNLOAD_TIMEOUT_MS = '10000';
            const stream = {
                // eslint-disable-next-line @typescript-eslint/require-await
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from('ok');
                },
                destroy: jest.fn(),
            };
            const download = jest.fn().mockResolvedValue(stream);
            const incoming = await build(download).mapMessage(imageMessage('C1'), 'imageMessage');
            expect(incoming.media).toEqual(expect.objectContaining({ data: Buffer.from('ok').toString('base64') }));
        });
    });
});
