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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const feature_flags_1 = require("./feature-flags");
describe('feature-flags', () => {
    describe('computeFeatureFlags', () => {
        it('applies the documented defaults for an empty environment', () => {
            const flags = (0, feature_flags_1.computeFeatureFlags)({});
            expect(flags).toEqual({
                autoStartSessions: false, // opt-in
                storeEphemeralMessages: true, // opt-out
                resolveLidToPhone: false, // opt-in
                simulateTyping: true, // opt-out
                simulateTypingMaxMs: 5000,
            });
        });
        it('treats opt-in flags (autoStart, resolveLid) as ON only for the exact string "true"', () => {
            expect((0, feature_flags_1.computeFeatureFlags)({ AUTO_START_SESSIONS: 'true' }).autoStartSessions).toBe(true);
            expect((0, feature_flags_1.computeFeatureFlags)({ RESOLVE_LID_TO_PHONE: 'true' }).resolveLidToPhone).toBe(true);
            // Anything else stays OFF.
            for (const v of ['false', 'TRUE', '1', 'yes', '']) {
                expect((0, feature_flags_1.computeFeatureFlags)({ AUTO_START_SESSIONS: v }).autoStartSessions).toBe(false);
                expect((0, feature_flags_1.computeFeatureFlags)({ RESOLVE_LID_TO_PHONE: v }).resolveLidToPhone).toBe(false);
            }
        });
        it('treats opt-out flags (storeEphemeral, simulateTyping) as OFF only for the exact string "false"', () => {
            expect((0, feature_flags_1.computeFeatureFlags)({ STORE_EPHEMERAL_MESSAGES: 'false' }).storeEphemeralMessages).toBe(false);
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING: 'false' }).simulateTyping).toBe(false);
            // Anything else stays ON.
            for (const v of ['true', 'FALSE', '0', 'no', '']) {
                expect((0, feature_flags_1.computeFeatureFlags)({ STORE_EPHEMERAL_MESSAGES: v }).storeEphemeralMessages).toBe(true);
                expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING: v }).simulateTyping).toBe(true);
            }
        });
        it('reads simulateTypingMaxMs as a positive integer (0, negative and non-numeric values fall back to 5000)', () => {
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: '3000' }).simulateTypingMaxMs).toBe(3000);
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: '1' }).simulateTypingMaxMs).toBe(1);
            // Critical: "0" must fall back to 5000, NOT stay 0 as parseInt would.
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: '0' }).simulateTypingMaxMs).toBe(5000);
            // A negative cap would reach setTimeout and shrink the humanising pause to about 1 ms.
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: '-1' }).simulateTypingMaxMs).toBe(5000);
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: '-5' }).simulateTypingMaxMs).toBe(5000);
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: '' }).simulateTypingMaxMs).toBe(5000);
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: 'abc' }).simulateTypingMaxMs).toBe(5000);
            expect((0, feature_flags_1.computeFeatureFlags)({ SIMULATE_TYPING_MAX_MS: undefined }).simulateTypingMaxMs).toBe(5000);
        });
    });
    describe('resolveFeatureFlags', () => {
        const original = process.env.AUTO_START_SESSIONS;
        afterEach(() => {
            if (original === undefined)
                delete process.env.AUTO_START_SESSIONS;
            else
                process.env.AUTO_START_SESSIONS = original;
        });
        it('prefers the ConfigService-loaded features object when present', () => {
            const features = (0, feature_flags_1.computeFeatureFlags)({ AUTO_START_SESSIONS: 'true' });
            const configService = { get: jest.fn().mockReturnValue(features) };
            expect((0, feature_flags_1.resolveFeatureFlags)(configService)).toBe(features);
            expect(configService.get).toHaveBeenCalledWith('features');
        });
        it('falls back to a live process.env read when ConfigService is absent', () => {
            process.env.AUTO_START_SESSIONS = 'true';
            expect((0, feature_flags_1.resolveFeatureFlags)(undefined).autoStartSessions).toBe(true);
            process.env.AUTO_START_SESSIONS = 'false';
            expect((0, feature_flags_1.resolveFeatureFlags)(undefined).autoStartSessions).toBe(false);
        });
        it('falls back to process.env when ConfigService has no "features" entry (e.g. a partial mock)', () => {
            process.env.AUTO_START_SESSIONS = 'true';
            const configService = { get: jest.fn().mockImplementation((_k, def) => def) };
            expect((0, feature_flags_1.resolveFeatureFlags)(configService).autoStartSessions).toBe(true);
        });
    });
    // A flag the app reads is useless if the bundled compose never hands it to the container: the
    // operator sets it in .env, nothing happens, and there is no error to go on. That was the state of
    // AUTO_START_SESSIONS until this guard landed, so assert the forward exists rather than trusting it.
    describe('bundled production compose', () => {
        it('forwards AUTO_START_SESSIONS to the container', () => {
            const compose = fs.readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8');
            expect(compose).toMatch(/^\s*- AUTO_START_SESSIONS=\$\{AUTO_START_SESSIONS:-\}$/m);
        });
    });
    // PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS gates a security-sensitive hop in ssrf-guard (off unless
    // the exact string 'true'). Both bundled manifests must forward it with a secure default so an
    // operator's .env takes effect; whole-file contains() is not enough — the line must land on the API
    // service, never on a datastore/proxy service.
    describe('bundled compose forwards the plugin redirect policy', () => {
        // Extract the body of one top-level service block. Compose indents a service's keys two spaces
        // under the `name:` key, so the block runs from `  serviceName:` to the next sibling service or
        // top-level key, whichever comes first.
        function extractTopLevelService(compose, serviceName) {
            const start = compose.indexOf(`\n  ${serviceName}:\n`);
            if (start === -1)
                throw new Error(`service ${serviceName} not found`);
            const rest = compose.slice(start + 1);
            const next = rest.search(/\n(?: {2})?[a-z]/);
            return next === -1 ? rest : rest.slice(0, next);
        }
        it.each([
            ['docker-compose.yml', 'openwa-api'],
            ['docker-compose.dev.yml', 'openwa'],
        ])('%s forwards the redirect flag on service %s', (file, serviceName) => {
            const compose = fs.readFileSync(path.join(__dirname, '../../', file), 'utf8');
            const service = extractTopLevelService(compose, serviceName);
            // The block holds only this service: no sibling service header may follow its own.
            expect(service.split('\n').filter(line => /^ {2}[a-z]/.test(line))).toEqual([`  ${serviceName}:`]);
            expect(service).toContain('PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS=${PLUGIN_DOWNLOAD_ALLOW_INSECURE_REDIRECTS:-false}');
        });
    });
});
