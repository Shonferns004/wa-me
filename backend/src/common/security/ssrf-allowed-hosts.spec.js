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
const dnsPromises = __importStar(require("dns/promises"));
const ssrf_guard_1 = require("./ssrf-guard");
jest.mock('dns/promises', () => {
    const actual = jest.requireActual('dns/promises');
    return { __esModule: true, ...actual, lookup: jest.fn(actual.lookup) };
});
describe('SSRF_ALLOWED_HOSTS entries the guard can never match', () => {
    const original = process.env.SSRF_ALLOWED_HOSTS;
    let warn;
    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => {
        warn.mockRestore();
        jest.mocked(dnsPromises.lookup).mockReset();
        if (original === undefined)
            delete process.env.SSRF_ALLOWED_HOSTS;
        else
            process.env.SSRF_ALLOWED_HOSTS = original;
    });
    const warnings = () => warn.mock.calls.map(([line]) => String(line)).filter(line => line.includes('SSRF_ALLOWED_HOSTS'));
    it('names each entry by position and reason, once, without echoing it, and still refuses the destination', async () => {
        process.env.SSRF_ALLOWED_HOSTS =
            'https://user:token@n8n-a:5678, n8n-b:5678, n8n-c.local/hooks, *.corp-a, minio, 127.1, 0:0:0:0:0:0:0:1, 2130706433';
        jest.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
        await expect((0, ssrf_guard_1.assertSafeFetchUrl)('http://n8n-b:5678/hook')).rejects.toBeInstanceOf(ssrf_guard_1.SsrfBlockedError);
        await expect((0, ssrf_guard_1.assertSafeFetchUrl)('http://n8n-b:5678/hook')).rejects.toBeInstanceOf(ssrf_guard_1.SsrfBlockedError);
        const lines = warnings();
        expect(lines).toHaveLength(1);
        for (const named of [
            'entry 1 (a scheme or credentials)',
            'entry 2 (a port)',
            'entry 3 (a path)',
            'entry 4 (a wildcard)',
            'entry 6 (a spelling the URL parser rewrites)',
            'entry 7 (a spelling the URL parser rewrites)',
            'entry 8 (a spelling the URL parser rewrites)',
        ]) {
            expect(lines[0]).toContain(named);
        }
        expect(lines[0]).not.toContain('entry 5');
        expect(lines[0]).not.toMatch(/token|user|n8n|corp|hooks|minio/);
    });
    it('gives a value the URL parser refuses its own reason, apart from one it rewrites', () => {
        process.env.SSRF_ALLOWED_HOSTS = '[::1]:8080, fe80::1%eth0, exa mple.com, 127.1';
        (0, ssrf_guard_1.warnUnusableAllowedHosts)();
        const [line] = warnings();
        expect(line).toContain('entry 1 (a value the URL parser rejects)');
        expect(line).toContain('entry 2 (a value the URL parser rejects)');
        expect(line).toContain('entry 3 (a value the URL parser rejects)');
        expect(line).toContain('entry 4 (a spelling the URL parser rewrites)');
    });
    it('lists at most 20 unusable entries in one line and counts the rest', () => {
        process.env.SSRF_ALLOWED_HOSTS = Array.from({ length: 30000 }, (_, i) => `*.many${i}`).join(',');
        (0, ssrf_guard_1.warnUnusableAllowedHosts)();
        const lines = warnings();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('entry 20 (a wildcard)');
        expect(lines[0]).not.toContain('entry 21 ');
        expect(lines[0]).toContain('29980 more are not listed (the list shows at most 20)');
        expect(lines[0].length).toBeLessThan(2000);
    });
    it('adds no summary when every unusable entry fits', () => {
        process.env.SSRF_ALLOWED_HOSTS = Array.from({ length: 20 }, (_, i) => `*.few${i}`).join(',');
        (0, ssrf_guard_1.warnUnusableAllowedHosts)();
        expect(warnings()[0]).toContain('entry 20 (a wildcard)');
        expect(warnings()[0]).not.toContain('not listed');
    });
    // The URL parser rewrites these hosts, and the guard compares the rewritten hostname, so the spelling written in
    // the entry never equals it; the same address written as the parser prints it does.
    it('is right that a non-canonical IP address entry never matches, and that the canonical one does', async () => {
        process.env.SSRF_ALLOWED_HOSTS = '127.1';
        await expect((0, ssrf_guard_1.assertSafeFetchUrl)('http://127.1/')).rejects.toBeInstanceOf(ssrf_guard_1.SsrfBlockedError);
        process.env.SSRF_ALLOWED_HOSTS = '0:0:0:0:0:0:0:1';
        await expect((0, ssrf_guard_1.assertSafeFetchUrl)('http://[::1]/')).rejects.toBeInstanceOf(ssrf_guard_1.SsrfBlockedError);
        process.env.SSRF_ALLOWED_HOSTS = '127.0.0.1, ::1';
        jest
            .mocked(dnsPromises.lookup)
            .mockImplementation(((host) => Promise.resolve([{ address: host, family: host.includes(':') ? 6 : 4 }])));
        await expect((0, ssrf_guard_1.assertSafeFetchUrl)('http://127.1/')).resolves.toBeUndefined();
        await expect((0, ssrf_guard_1.assertSafeFetchUrl)('http://[0:0:0:0:0:0:0:1]/')).resolves.toBeUndefined();
    });
    it('says nothing for host names and IP literals the parser keeps as written', async () => {
        process.env.SSRF_ALLOWED_HOSTS =
            'Localhost, minio, my_service.internal, host.docker.internal, minio., 10.0.0.9, [::1], ::2, fe80::1, ,';
        jest.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        await expect((0, ssrf_guard_1.assertSafeFetchUrl)('http://localhost/')).resolves.toBeUndefined();
        (0, ssrf_guard_1.warnUnusableAllowedHosts)();
        expect(warnings()).toEqual([]);
    });
});
