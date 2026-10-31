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
const path = __importStar(require("path"));
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const engine_page_error_1 = require("../../common/errors/engine-page.error");
const recipient_unreachable_error_1 = require("../../common/errors/recipient-unreachable.error");
const logger_service_1 = require("../../common/services/logger.service");
const wwebjs_messaging_1 = require("./wwebjs-messaging");
const wwebjs_host_1 = require("./wwebjs-host");
/**
 * A send failure scripts/patch-wwebjs-send-error.js captured inside the page quotes WhatsApp Web's
 * own text, and the dead-page classifier reads error text. Without the exemption, a refusal whose
 * summary happened to say "connection closed" would tear down a session whose page had just proved
 * it was alive by running the catch. The patcher's own spec (node:test) covers what the page code
 * builds; this one covers how the gateway reads it.
 */
// The patcher is plain CommonJS under scripts/, loaded by path as engine-patch-status.spec.ts does.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const patcher = require(path.join(__dirname, '..', '..', '..', 'scripts', 'patch-wwebjs-send-error.js'));
const isPageTransportError = (error) => wwebjs_lifecycle_1.WwebjsLifecycle.prototype.isPageTransportError.call({}, error);
/** A captured error as puppeteer hands it over: a plain Error whose message is the prefix and the JSON. */
const captured = (info) => new Error(wwebjs_lifecycle_1.CAPTURED_PAGE_ERROR_PREFIX + JSON.stringify(info));
describe('a send failure captured inside the page', () => {
    it('uses the prefix the patcher builds it with', () => {
        // The patcher cannot import the TS constant (it runs at install time), so the two copies are
        // pinned here instead: a drifted prefix would silently switch the exemption below off.
        expect(patcher.PREFIX).toBe(wwebjs_lifecycle_1.CAPTURED_PAGE_ERROR_PREFIX);
    });
    it('is never read as a dead page, whatever WhatsApp Web text it quotes', () => {
        for (const quoted of ['connection closed', 'Target closed', 'Protocol error', 'Session closed']) {
            expect(isPageTransportError(captured({ ctor: 't', name: 't', message: quoted }))).toBe(false);
        }
    });
    it('leaves the same words a death when they are not a capture', () => {
        // Non-vacuity: the quoted text above is exactly what the pattern matches on its own, so the
        // exemption, and not the words, is what answers false there.
        expect(isPageTransportError(new Error('connection closed'))).toBe(true);
        expect(isPageTransportError(new Error('Protocol error (Runtime.callFunctionOn): Target closed'))).toBe(true);
        // A prefix that is not at the start is not a capture either.
        expect(isPageTransportError(new Error(`Session closed; ${wwebjs_lifecycle_1.CAPTURED_PAGE_ERROR_PREFIX}{}`))).toBe(true);
    });
});
describe('the reason a captured page failure gives the caller', () => {
    const summary = {
        build: '2.3000.1',
        ctor: 'MediaFileTooLarge',
        str: 'MediaFileTooLarge: too big',
        name: 'MediaFileTooLarge',
        message: 'too big',
        stack: 'MediaFileTooLarge: too big\n    at send (app.js:1:1)',
        code: '413',
    };
    it('is a 500 EnginePageError naming what WhatsApp Web threw, with no stack in the body', () => {
        const raw = captured(summary);
        const err = (0, wwebjs_lifecycle_1.toCapturedPageError)(raw);
        expect(err).toBeInstanceOf(engine_page_error_1.EnginePageError);
        expect(err.getStatus()).toBe(500);
        expect(err.message).toBe('WhatsApp Web rejected the operation: MediaFileTooLarge: too big (build 2.3000.1)');
        expect(err.getResponse()).toEqual({
            statusCode: 500,
            error: 'Internal Server Error',
            code: 'ENGINE_PAGE_ERROR',
            message: 'WhatsApp Web rejected the operation: MediaFileTooLarge: too big (build 2.3000.1)',
            pageError: { name: 'MediaFileTooLarge', message: 'too big' },
            build: '2.3000.1',
        });
        expect(JSON.stringify(err.getResponse())).not.toContain('app.js');
        // The full summary stays reachable for the server log.
        expect(err.cause).toBe(raw);
    });
    it('falls back to the constructor and string of a thrown value that is not an Error', () => {
        const err = (0, wwebjs_lifecycle_1.toCapturedPageError)(captured({ build: '(unreadable)', ctor: 'String', str: 'boom', name: 'undefined', message: 'undefined' }));
        expect(err.getResponse()).toMatchObject({ pageError: { name: 'String', message: 'boom' } });
        expect(err.getResponse()).not.toHaveProperty('build');
        expect(err.message).toBe('WhatsApp Web rejected the operation: String: boom');
    });
    it('cuts a long name and message', () => {
        const err = (0, wwebjs_lifecycle_1.toCapturedPageError)(captured({ name: 'N'.repeat(500), message: 'm'.repeat(500) }));
        const body = err.getResponse();
        expect(body.pageError.name.length).toBeLessThanOrEqual(203);
        expect(body.pageError.message.length).toBeLessThanOrEqual(203);
    });
    it('leaves everything that is not a parseable capture untouched', () => {
        const malformed = new Error(`${wwebjs_lifecycle_1.CAPTURED_PAGE_ERROR_PREFIX}{not json`);
        const plain = new Error('Evaluation failed: Error: something else broke');
        for (const value of [malformed, plain, 'text', undefined]) {
            expect((0, wwebjs_lifecycle_1.toCapturedPageError)(value)).toBe(value);
        }
    });
    const makeMessaging = () => {
        const client = { sendMessage: jest.fn() };
        const host = {
            ensureReady: jest.fn(),
            ensureNotChannelRecipient: jest.fn(),
            getClient: () => client,
            logger: (0, logger_service_1.createLogger)('wwebjs-send-page-error.spec'),
            config: {},
            getNumberId: jest.fn(),
            capInboundMediaFor: jest.fn(),
            isPageTransportError: () => false,
            reportIfPageTransportError: jest.fn(),
        };
        return { messaging: new wwebjs_messaging_1.WwebjsMessaging(host), client, host };
    };
    it('reaches the caller of a message send', async () => {
        const { messaging, client } = makeMessaging();
        client.sendMessage.mockRejectedValue(captured(summary));
        await expect(messaging.sendTextMessage('628111@c.us', 'hi')).rejects.toBeInstanceOf(engine_page_error_1.EnginePageError);
    });
    it('reaches the caller when the send fails on the LID retry', async () => {
        const { messaging, client, host } = makeMessaging();
        host.getNumberId.mockResolvedValueOnce(undefined).mockResolvedValueOnce('999@lid');
        client.sendMessage
            .mockRejectedValueOnce(new Error('Evaluation failed: Error: No LID for user'))
            .mockRejectedValueOnce(captured(summary));
        await expect(messaging.sendTextMessage('628111@c.us', 'hi')).rejects.toBeInstanceOf(engine_page_error_1.EnginePageError);
        expect(client.sendMessage).toHaveBeenCalledTimes(2);
    });
    // The first attempt reports a dead page before any remap; the LID retry must too, or a page that
    // dies during the retry leaves the session READY until the watchdog notices.
    it('reports a page that dies during the LID retry', async () => {
        const { messaging, client, host } = makeMessaging();
        host.getNumberId.mockResolvedValueOnce(undefined).mockResolvedValueOnce('999@lid');
        const dead = new Error('Protocol error (Runtime.callFunctionOn): Target closed');
        client.sendMessage
            .mockRejectedValueOnce(new Error('Evaluation failed: Error: No LID for user'))
            .mockRejectedValueOnce(dead);
        await expect(messaging.sendTextMessage('628111@c.us', 'hi')).rejects.toBe(dead);
        const report = host.reportIfPageTransportError;
        expect(report).toHaveBeenCalledWith(dead, 'sendMessage');
    });
    it('does not take over the recipient remap of a plain No LID failure', async () => {
        const { messaging, client, host } = makeMessaging();
        host.getNumberId.mockResolvedValue(undefined);
        client.sendMessage.mockRejectedValue(new Error('Evaluation failed: Error: No LID for user'));
        await expect(messaging.sendTextMessage('628111@c.us', 'hi')).rejects.toBeInstanceOf(recipient_unreachable_error_1.RecipientUnreachableError);
    });
    it('reaches the caller of a status post', async () => {
        const report = jest.fn();
        const host = {
            logger: { warn: jest.fn() },
            config: {},
            isPageTransportError: () => false,
            reportIfPageTransportError: report,
        };
        const raw = captured(summary);
        await expect((0, wwebjs_host_1.reportPageDeath)(host, 'postTextStatus', () => Promise.reject(raw))).rejects.toBeInstanceOf(engine_page_error_1.EnginePageError);
        expect(report).toHaveBeenCalledWith(raw, 'postTextStatus');
    });
    it('leaves the full summary of a status post failure in the server log', async () => {
        // The EnginePageError is an HttpException, which Nest does not log, and the status path logs
        // nothing of its own: without this line the stack and own properties reach no log at all.
        const warn = jest.fn();
        const host = {
            logger: { warn },
            config: { sessionId: 'sess-1' },
            isPageTransportError: () => false,
            reportIfPageTransportError: jest.fn(),
        };
        const raw = captured(summary);
        await expect((0, wwebjs_host_1.reportPageDeath)(host, 'postTextStatus', () => Promise.reject(raw))).rejects.toBeInstanceOf(engine_page_error_1.EnginePageError);
        expect(warn).toHaveBeenCalledWith('WhatsApp Web threw during postTextStatus', {
            sessionId: 'sess-1',
            cause: raw.message,
        });
    });
    it('logs nothing of its own for an error it passes through unchanged', async () => {
        const warn = jest.fn();
        const host = {
            logger: { warn },
            config: { sessionId: 'sess-1' },
            isPageTransportError: () => false,
            reportIfPageTransportError: jest.fn(),
        };
        const plain = new Error('boom');
        await expect((0, wwebjs_host_1.reportPageDeath)(host, 'postTextStatus', () => Promise.reject(plain))).rejects.toBe(plain);
        expect(warn).not.toHaveBeenCalled();
    });
});
