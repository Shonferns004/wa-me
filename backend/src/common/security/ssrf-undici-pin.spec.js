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
const undici_1 = require("undici");
const ssrf_guard_1 = require("./ssrf-guard");
// Real-connection invariant for the SSRF guard: the *installed* undici must honor an Agent's
// `connect.lookup` AND the per-request `dispatcher` option on fetch — that pairing is the whole
// DNS-rebind defense (ssrf-guard.ts pins the resolved IPs into a dispatcher). The unit spec mocks
// undici's fetch, so it can't see a silent break across an undici upgrade; this test makes a real
// loopback connection so a future bump that drops/renames either feature fails loudly here instead
// of leaving the SSRF pin a no-op.
describe('undici honors the SSRF connect.lookup pin (real connection)', () => {
    let server;
    let port;
    beforeAll(() => new Promise(resolve => {
        server = http.createServer((_req, res) => res.end('pinned-ok'));
        server.listen(0, '127.0.0.1', () => {
            port = server.address().port;
            resolve();
        });
    }));
    afterAll(() => new Promise(resolve => server.close(() => resolve())));
    it('routes the connection to the pinned IP for a host that does not resolve via DNS', async () => {
        // `.invalid` (RFC 2606) never resolves, so the request can ONLY reach the server if undici used
        // our pinned lookup → 127.0.0.1.
        const dispatcher = new undici_1.Agent({ connect: { lookup: (0, ssrf_guard_1.pinnedLookup)([{ address: '127.0.0.1', family: 4 }]) } });
        try {
            const res = await (0, undici_1.fetch)(`http://pinned.invalid:${port}/`, { dispatcher });
            expect(res.status).toBe(200);
            expect(await res.text()).toBe('pinned-ok');
        }
        finally {
            await dispatcher.destroy();
        }
    });
    it('control: the same host is genuinely unresolvable without the pin', async () => {
        // Proves the test above succeeds because of the pin, not because the host happens to resolve.
        //
        // Bounded by our own signal rather than left to the resolver: a `.invalid` lookup returns NXDOMAIN
        // instantly on most machines, but a resolver that black-holes unknown TLDs instead makes the OS
        // retry through its own multi-second schedule, which blew past Jest's 5s default and failed this
        // suite in CI while passing everywhere else. The claim under test is "without the pin this request
        // does not reach the server", and an abort satisfies it exactly as a DNS failure does. It does not
        // weaken the control: had the host resolved, the connection is to 127.0.0.1 and would have
        // succeeded well inside the budget, resolving the promise and failing this assertion.
        await expect((0, undici_1.fetch)(`http://pinned.invalid:${port}/`, { signal: AbortSignal.timeout(2000) })).rejects.toThrow();
    });
});
