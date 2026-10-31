"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const plugin_interfaces_1 = require("./plugin.interfaces");
const baseManifest = () => ({
    id: 'chatwoot',
    name: 'Chatwoot',
    version: '1.0.0',
    main: 'index.js',
    sdkVersion: '1',
    permissions: ['webhook:ingress', 'conversation:send', 'net:fetch'],
    ingress: [
        {
            route: 'chatwoot',
            mode: 'async',
            verify: 'core',
            maxBodyBytes: 262144,
            signature: {
                scheme: 'hmac-sha256',
                header: 'X-Chatwoot-Signature',
                contentTemplate: '{rawBody}',
                encoding: 'hex',
                toleranceSec: 300,
                dedupHeader: 'X-Chatwoot-Delivery',
            },
        },
    ],
});
describe('validateIngressManifest', () => {
    it('accepts a well-formed sdkVersion 1 ingress manifest', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(baseManifest())).not.toThrow();
    });
    it('refuses a plugin whose declared SDK major differs from the host major', () => {
        const m = baseManifest();
        m.sdkVersion = '2';
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/sdk.*major/i);
        expect(plugin_interfaces_1.SUPPORTED_SDK_MAJOR).toBe(1);
    });
    it('rejects an ingress route declared without the webhook:ingress permission', () => {
        const m = baseManifest();
        m.permissions = ['conversation:send'];
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/webhook:ingress/);
    });
    it('the ingress refusal names the array and the manifest file to fix', () => {
        // Load-time twin of the capability denial: an author who sees only "is missing the
        // 'webhook:ingress' permission" is told the fault, not where to declare it.
        const m = baseManifest();
        m.permissions = ['conversation:send'];
        const error = (() => {
            try {
                (0, plugin_interfaces_1.validateIngressManifest)(m);
                return null;
            }
            catch (e) {
                return e;
            }
        })();
        expect(error?.message).toContain('webhook:ingress');
        expect(error?.message).toContain('permissions');
        expect(error?.message).toContain('manifest.json');
    });
    it('rejects toleranceSec <= 0 (replay guard would be a no-op)', () => {
        const m = baseManifest();
        m.ingress[0].signature.toleranceSec = 0;
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/toleranceSec/);
    });
    it('rejects a toleranceSec that is not a finite number, which would disable the replay window', () => {
        for (const tol of ['5m', '300s', '', {}, true, [], null, JSON.parse('1e999')]) {
            for (const scheme of ['hmac-sha256', 'standard-webhooks']) {
                const m = baseManifest();
                m.ingress[0].signature.scheme = scheme;
                m.ingress[0].signature.toleranceSec = tol;
                expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/toleranceSec/);
            }
        }
    });
    it('still loads a numeric toleranceSec, quoted or not', () => {
        for (const tol of [300, '300']) {
            const m = baseManifest();
            m.ingress[0].signature.toleranceSec = tol;
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).not.toThrow();
        }
    });
    it('rejects a route that is not a single URL path segment', () => {
        for (const route of ['events/message', '/hook', 'a\\b', 'a?b', 'a#b', 'a%2Fb', 'a\nb', '.', '..']) {
            const m = baseManifest();
            m.ingress[0].route = route;
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/single URL path segment/);
        }
        // A space or a non-ASCII letter is percent-encoded by the client and decoded before the match.
        for (const route of ['send-sms', 'chatwoot', 'v1.events', 'a_b~c', 'a b', 'café', '...']) {
            const m = baseManifest();
            m.ingress[0].route = route;
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).not.toThrow();
        }
    });
    it('rejects a route holding a lone UTF-16 surrogate (no URL can encode or decode to it)', () => {
        for (const route of ['\ud800', 'a\udc00b', 'x\ud83d']) {
            const m = baseManifest();
            m.ingress[0].route = route;
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/single URL path segment/);
        }
        // A well-formed surrogate pair is an ordinary astral character.
        const m = baseManifest();
        m.ingress[0].route = 'hook-\ud83d\ude80';
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).not.toThrow();
    });
    it('rejects a dedupOn value other than header or body', () => {
        const m = baseManifest();
        m.ingress[0].dedupOn = 'bdy';
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/dedupOn/);
    });
    it('accepts dedupOn: body', () => {
        const m = baseManifest();
        m.ingress[0].dedupOn = 'body';
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).not.toThrow();
    });
    // An unknown scheme used to load and then fail every delivery as a signature mismatch, with nothing
    // pointing at the manifest; a missing signature object failed the load with a bare TypeError.
    it.each(['hmac_sha256', 'HMAC-SHA256', 'standard-webhook', undefined])('rejects signature.scheme %p, naming the route', scheme => {
        const m = baseManifest();
        m.ingress[0].signature.scheme = scheme;
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/route 'chatwoot' signature\.scheme must be one of/);
    });
    it('rejects a route with no signature object as a manifest error', () => {
        const m = baseManifest();
        delete m.ingress[0].signature;
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/route 'chatwoot' signature\.scheme must be one of/);
    });
    it('rejects an hmac-sha256 signature.encoding other than hex or base64', () => {
        const m = baseManifest();
        m.ingress[0].signature.encoding = 'b64';
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/route 'chatwoot' signature\.encoding must be/);
    });
    // Only hmac-sha256 reads `encoding`, so a stray value on another scheme must not fail the plugin's load.
    it.each(['shared-secret', 'standard-webhooks'])('ignores signature.encoding on a %s route', scheme => {
        const m = baseManifest();
        m.ingress[0].signature.scheme = scheme;
        m.ingress[0].signature.encoding = 'b64';
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).not.toThrow();
    });
    it('accepts every declared scheme', () => {
        for (const scheme of ['hmac-sha256', 'shared-secret', 'standard-webhooks', 'none']) {
            const m = baseManifest();
            m.ingress[0].signature.scheme = scheme;
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m, true)).not.toThrow();
        }
    });
    it('rejects a duplicate route within one manifest', () => {
        const m = baseManifest();
        m.ingress.push({ ...m.ingress[0] });
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(m)).toThrow(/duplicate/i);
    });
});
describe('validateIngressManifest: signature.scheme "none" opt-in gate', () => {
    // A none-scheme route is an unauthenticated @Public endpoint that can trigger WhatsApp sends.
    // It must be rejected at load unless the operator explicitly opted in via ALLOW_UNSIGNED_INGRESS.
    const noneManifest = () => ({
        id: 'p',
        name: 'p',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        sdkVersion: '1',
        permissions: ['webhook:ingress'],
        ingress: [{ route: 'r', mode: 'async', verify: 'core', maxBodyBytes: 1024, signature: { scheme: 'none' } }],
    });
    it('rejects a none-scheme route by default (no opt-in)', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(noneManifest())).toThrow(/ALLOW_UNSIGNED_INGRESS/i);
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(noneManifest())).toThrow(/unauthenticated/i);
    });
    it('rejects a none-scheme route when explicitly passed allowUnsignedIngress=false', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(noneManifest(), false)).toThrow(/ALLOW_UNSIGNED_INGRESS/i);
    });
    it('accepts a none-scheme route when the operator opted in (allowUnsignedIngress=true)', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(noneManifest(), true)).not.toThrow();
    });
    it('still accepts signed routes regardless of the opt-in flag', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(baseManifest(), false)).not.toThrow();
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(baseManifest(), true)).not.toThrow();
    });
});
describe('warnUnauthenticatedIngressRoutes', () => {
    it('warns once per scheme:none route, naming the plugin and route', () => {
        const logger = { warn: jest.fn() };
        const m = baseManifest();
        m.ingress[0].signature.scheme = 'none';
        (0, plugin_interfaces_1.warnUnauthenticatedIngressRoutes)(m, logger);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/UNAUTHENTICATED/i), expect.objectContaining({ pluginId: 'chatwoot', route: 'chatwoot', action: 'ingress_unauthenticated_route' }));
    });
    it('does not warn for an authenticated scheme', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnauthenticatedIngressRoutes)(baseManifest(), logger);
        expect(logger.warn).not.toHaveBeenCalled();
    });
    it('is a no-op for a manifest with no ingress routes', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnauthenticatedIngressRoutes)({ id: 'x', name: 'X', version: '1.0.0', main: 'i.js' }, logger);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
describe('warnUnsignedTimestampRoutes', () => {
    const hmacRoute = (signature) => ({
        id: 'p',
        name: 'p',
        version: '1.0.0',
        main: 'index.js',
        sdkVersion: '1',
        permissions: ['webhook:ingress'],
        ingress: [{ route: 'r', mode: 'async', verify: 'core', maxBodyBytes: 1024, signature }],
    });
    it('warns when a timestampHeader is declared but the contentTemplate does not sign it', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(hmacRoute({
            scheme: 'hmac-sha256',
            header: 'X-Sig',
            contentTemplate: '{rawBody}',
            timestampHeader: 'X-Ts',
        }), logger);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/UNSIGNED/i), expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_unsigned_timestamp' }));
    });
    it('warns when the contentTemplate signs {timestamp} but no timestampHeader is declared', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(hmacRoute({ scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{timestamp}.{rawBody}' }), logger);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/no timestampHeader/i), expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_unsigned_timestamp' }));
    });
    it('stays silent when the declared timestamp is signed (the bound form)', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(hmacRoute({
            scheme: 'hmac-sha256',
            header: 'X-Sig',
            contentTemplate: '{timestamp}.{rawBody}',
            timestampHeader: 'X-Ts',
            toleranceSec: 300,
        }), logger);
        expect(logger.warn).not.toHaveBeenCalled();
    });
    const withDedupOnBody = (manifest) => ({
        ...manifest,
        ingress: manifest.ingress.map(route => ({ ...route, dedupOn: 'body' })),
    });
    it('warns once when an hmac route binds no timestamp and dedups on its header', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(hmacRoute({ scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{rawBody}' }), logger);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/dedupOn: 'body'/), expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_replayable_route' }));
    });
    it('stays silent for an hmac route without a timestamp that dedups on the body', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(withDedupOnBody(hmacRoute({ scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{rawBody}' })), logger);
        expect(logger.warn).not.toHaveBeenCalled();
    });
    it('warns for a shared-secret route unless it dedups on the body', () => {
        const logger = { warn: jest.fn() };
        const route = hmacRoute({ scheme: 'shared-secret', header: 'X-Token', timestampHeader: 'X-Ts' });
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(route, logger);
        expect(logger.warn).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/shared-secret/), expect.objectContaining({ pluginId: 'p', route: 'r', action: 'ingress_replayable_route' }));
        logger.warn.mockClear();
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(withDedupOnBody(route), logger);
        expect(logger.warn).not.toHaveBeenCalled();
    });
    it('ignores standard-webhooks (its dedup id and timestamp are signed)', () => {
        const logger = { warn: jest.fn() };
        (0, plugin_interfaces_1.warnUnsignedTimestampRoutes)(hmacRoute({ scheme: 'standard-webhooks', dedupHeader: 'webhook-id' }), logger);
        expect(logger.warn).not.toHaveBeenCalled();
    });
});
function manifestWithRoute(overrides = {}) {
    return {
        id: 'p',
        name: 'p',
        version: '1.0.0',
        type: 'extension',
        main: 'index.js',
        sdkVersion: '1',
        permissions: ['webhook:ingress'],
        ingress: [
            // Default to a signed scheme so the response-contract / standard-webhooks suites below
            // exercise fields other than the scheme. The scheme:'none' opt-in gate has its own block.
            {
                route: 'r',
                mode: 'async',
                verify: 'core',
                maxBodyBytes: 1024,
                signature: { scheme: 'hmac-sha256', header: 'X-Sig', contentTemplate: '{rawBody}', encoding: 'hex' },
                ...overrides,
            },
        ],
    };
}
describe('validateIngressManifest: response contract', () => {
    it('accepts a route with no response (default fast-ack)', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute())).not.toThrow();
    });
    it('accepts a valid response contract', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({
            response: {
                preflight: [{ type: 'session-alive' }],
                ack: { status: 200, body: '{"ok":true}', headers: { 'content-type': 'application/json' } },
            },
        }))).not.toThrow();
    });
    it('rejects an out-of-range ack.status', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { status: 99 } } }))).toThrow(/ack\.status/);
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { status: 600 } } }))).toThrow(/ack\.status/);
    });
    it('rejects a CR/LF in an ack header value (injection guard)', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { headers: { 'content-type': 'text/plain\r\nX-Injected: yes' } } } }))).toThrow(/invalid characters/);
    });
    it('rejects a 1xx ack.status, which Node sends with no final response after it', () => {
        for (const status of [100, 103, 199]) {
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { status } } }))).toThrow(/ack\.status/);
        }
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { status: 200 } } }))).not.toThrow();
    });
    it('rejects an ack header value Node cannot write, and keeps Latin-1 and HTAB', () => {
        for (const value of ['ok \u2713', 'a\u0000b', 'a\u007fb', 'a\u001bb']) {
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { headers: { 'x-note': value } } } }))).toThrow(/invalid characters/);
        }
        for (const value of ['caf\u00e9', 'a\tb']) {
            expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { headers: { 'x-note': value } } } }))).not.toThrow();
        }
    });
    it('rejects a non-string ack body', () => {
        // A manifest is third-party JSON. Left unchecked, a number or object here reached the renderer,
        // which drops anything that is not a string, so the route answered every delivery with an EMPTY
        // ack while the manifest read as if it declared one.
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { body: 42 } } }))).toThrow(/ack\.body/);
    });
    it('rejects a non-string ack header value', () => {
        // Same silent drop, and the character guard does not catch it: RegExp.test coerces its
        // argument, so a number passes the injection check and is then filtered out at render time.
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { headers: { 'x-retry': 5 } } } }))).toThrow(/'x-retry'/);
    });
    it('rejects a non-token ack header name', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ response: { ack: { headers: { 'bad header': 'x' } } } }))).toThrow(/'bad header'/);
    });
});
describe('validateIngressManifest: standard-webhooks scheme', () => {
    it('loads a standard-webhooks route without header/contentTemplate', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ signature: { scheme: 'standard-webhooks', dedupHeader: 'webhook-id' } }))).not.toThrow();
    });
    it('rejects a standard-webhooks route with a non-positive toleranceSec', () => {
        expect(() => (0, plugin_interfaces_1.validateIngressManifest)(manifestWithRoute({ signature: { scheme: 'standard-webhooks', dedupHeader: 'webhook-id', toleranceSec: 0 } }))).toThrow(/toleranceSec/);
    });
});
