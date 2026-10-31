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
const common_1 = require("@nestjs/common");
const node_child_process_1 = require("node:child_process");
const node_path_1 = require("node:path");
const node_util_1 = require("node:util");
const whatsapp_web_js_1 = require("whatsapp-web.js");
const configuration_1 = __importStar(require("../../config/configuration"));
const env_validation_1 = require("../../config/env.validation");
const whatsapp_web_js_adapter_1 = require("./whatsapp-web-js.adapter");
const wwebjs_lifecycle_1 = require("./wwebjs-lifecycle");
const wwebjs_groups_1 = require("./wwebjs-groups");
const wwebjs_labels_1 = require("./wwebjs-labels");
const wwebjs_chats_1 = require("./wwebjs-chats");
const wwebjs_contacts_1 = require("./wwebjs-contacts");
const logger_service_1 = require("../../common/services/logger.service");
const engine_transport_error_1 = require("../../common/errors/engine-transport.error");
const group_not_found_error_1 = require("../../common/errors/group-not-found.error");
const invalid_invite_code_error_1 = require("../../common/errors/invalid-invite-code.error");
const label_not_found_error_1 = require("../../common/errors/label-not-found.error");
/**
 * Provoked from the INSTALLED puppeteer-core rather than copied from it. The guard exists to
 * survive a message the library may reshape on a version bump, so a hand-written literal would
 * keep passing while the real string drifted out from under it — the one drift this test is
 * here to catch. Driving the real `Callback` is also what shows the label is the bare CDP
 * method name, with no `Protocol error (...)` prefix for the death pattern to match.
 */
const puppeteerProtocolTimeoutMessage = async () => {
    // Load the ESM dependency in Node, outside Jest's CommonJS module loader.
    const { stdout } = await (0, node_util_1.promisify)(node_child_process_1.execFile)(process.execPath, [
        '--input-type=module',
        '-e',
        `import { Callback } from 'puppeteer-core/internal/common/CallbackRegistry.js';
       const callback = new Callback(1, 'Runtime.callFunctionOn', 1);
       try { await callback.promise; throw new Error('protocolTimeout did not expire'); }
       catch (error) { console.log(error.message); }`,
    ], { cwd: (0, node_path_1.join)(__dirname, '../../..'), encoding: 'utf8', timeout: 10_000 });
    return stdout.trim();
};
/**
 * The per-CDP-command budget handed to Puppeteer, and the one error it produces.
 *
 * Three invariants worth pinning: the value is range-checked before it leaves the config layer,
 * the option reaches the Client when set and is absent when not, and a protocol timeout is never
 * read as a dead page. The death signatures themselves are covered in whatsapp-web-js.adapter.spec.
 */
describe('whatsapp-web.js protocol timeout', () => {
    const SESSION_ID = 'sess-protocol-timeout';
    let clientInitSpy;
    let savedWebVersion;
    const launchedPuppeteerOptions = async (protocolTimeoutMs) => {
        const adapter = new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({
            sessionId: SESSION_ID,
            sessionDataPath: './data/sessions',
            puppeteer: { protocolTimeoutMs },
        });
        await adapter.initialize({});
        return adapter.client.options
            .puppeteer;
    };
    beforeEach(() => {
        // Keep initialize() offline: 'off' skips the wa-version registry fetch in resolveWebVersionPin.
        savedWebVersion = process.env.WWEBJS_WEB_VERSION;
        process.env.WWEBJS_WEB_VERSION = 'off';
        // Build the real wwebjs Client — that is what carries the launch options — but launch no browser.
        clientInitSpy = jest
            .spyOn(whatsapp_web_js_1.Client.prototype, 'initialize')
            .mockResolvedValue(undefined);
    });
    afterEach(() => {
        clientInitSpy.mockRestore();
        if (savedWebVersion === undefined) {
            delete process.env.WWEBJS_WEB_VERSION;
        }
        else {
            process.env.WWEBJS_WEB_VERSION = savedWebVersion;
        }
    });
    it('hands a configured budget to the Client as puppeteer.protocolTimeout', async () => {
        expect(await launchedPuppeteerOptions(300_000)).toMatchObject({ protocolTimeout: 300_000 });
    });
    it('omits the option when unset, leaving Puppeteer its own default', async () => {
        const options = await launchedPuppeteerOptions(undefined);
        // Truly absent: `toHaveProperty` passes on a present-but-undefined key, so this is the check
        // that the option was never spread rather than spread as undefined.
        expect(options).not.toHaveProperty('protocolTimeout');
    });
    it('omits the option for a value configuration.ts would never produce', async () => {
        // The config layer is not the only writer: a plugin config (PUT /api/plugins/{id}/config) is
        // validated as an object and merged over the env blob at boot, so the sink enforces the bounds
        // too. 0 arms no timer at all; over MAX_TIMER_MS overflows Node's and fires after 1 ms.
        expect(await launchedPuppeteerOptions(0)).not.toHaveProperty('protocolTimeout');
        expect(await launchedPuppeteerOptions(-1)).not.toHaveProperty('protocolTimeout');
        expect(await launchedPuppeteerOptions(configuration_1.MAX_TIMER_MS + 1)).not.toHaveProperty('protocolTimeout');
        expect(await launchedPuppeteerOptions(configuration_1.MAX_TIMER_MS)).toMatchObject({ protocolTimeout: configuration_1.MAX_TIMER_MS });
    });
    describe('the bounds this knob exists to enforce', () => {
        it('rejects a non-positive or over-range value at boot instead of handing it to Puppeteer', () => {
            expect(() => (0, env_validation_1.validateEnv)({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '0' })).toThrow(/positive integer/);
            expect(() => (0, env_validation_1.validateEnv)({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '-1' })).toThrow(/positive integer/);
            expect(() => (0, env_validation_1.validateEnv)({ PUPPETEER_PROTOCOL_TIMEOUT_MS: 'abc' })).toThrow(/positive integer/);
            // The row of nines an operator reaches for when the docs forbid 0.
            expect(() => (0, env_validation_1.validateEnv)({ PUPPETEER_PROTOCOL_TIMEOUT_MS: String(configuration_1.MAX_TIMER_MS + 1) })).toThrow(/must not exceed/);
            expect(() => (0, env_validation_1.validateEnv)({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '999999999999' })).toThrow(/must not exceed/);
            expect(() => (0, env_validation_1.validateEnv)({ PUPPETEER_PROTOCOL_TIMEOUT_MS: String(configuration_1.MAX_TIMER_MS) })).not.toThrow();
            expect(() => (0, env_validation_1.validateEnv)({ PUPPETEER_PROTOCOL_TIMEOUT_MS: '300000' })).not.toThrow();
        });
        it('leaves the option unset for anything out of range, never falsy', () => {
            const parsed = (raw) => {
                const saved = process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS;
                if (raw === undefined)
                    delete process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS;
                else
                    process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS = raw;
                try {
                    return (0, configuration_1.default)().engine.puppeteer
                        .protocolTimeoutMs;
                }
                finally {
                    if (saved === undefined)
                        delete process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS;
                    else
                        process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS = saved;
                }
            };
            // A blank compose forward is "unset", not 0.
            expect(parsed(undefined)).toBeUndefined();
            expect(parsed('')).toBeUndefined();
            expect(parsed('0')).toBeUndefined();
            expect(parsed('-1')).toBeUndefined();
            expect(parsed('abc')).toBeUndefined();
            expect(parsed(String(configuration_1.MAX_TIMER_MS + 1))).toBeUndefined();
            expect(parsed('300000')).toBe(300_000);
            expect(parsed(String(configuration_1.MAX_TIMER_MS))).toBe(configuration_1.MAX_TIMER_MS);
        });
    });
    describe('the transport classifier', () => {
        const classify = (message) => {
            const adapter = new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({
                sessionId: SESSION_ID,
                sessionDataPath: './data/sessions',
                puppeteer: {},
            });
            return adapter.isPageTransportError(new Error(message));
        };
        it('does not treat a protocol timeout as a dead page', async () => {
            const message = await puppeteerProtocolTimeoutMessage();
            // Guard the guard: if a bump ever drops the phrase this classifier keys on, fail here rather
            // than silently start reporting slow reads as deaths.
            expect(message).toMatch(/timed out\. Increase the 'protocolTimeout'/);
            expect(classify(message)).toBe(false);
            // The case that makes the carve-out load-bearing rather than decorative: puppeteer's own
            // `_reject` formats a rejected command as `Protocol error (label): message`, which the death
            // pattern matches. Without the carve-out this reads as a dead page.
            expect(classify(`Protocol error (Runtime.callFunctionOn): ${message}`)).toBe(false);
        });
        it('reports a death whose message also mentions a timeout', () => {
            // Why the guard matches Puppeteer's full phrase instead of a bare /timed out/: the broad
            // version swallows this, turning a reportable dead page into a silent one.
            expect(classify('Protocol error (Runtime.callFunctionOn): Session closed. Request timed out')).toBe(true);
        });
    });
});
/**
 * A timed-out command got no answer at all, so the verdict branches that read a rejection as "no such
 * group" (404), "no such invite" (404), "invalid invite" (400), "no such label" (404), "no such
 * contact" (404), "no such chat" (400) or "declined" (200 `success: false`) must not see it. It is
 * the 503 those routes document for a query that never came back, and it is not a death: the session
 * must not be torn down for a slow renderer.
 */
describe('a protocol timeout is a 503, never a not-found verdict', () => {
    const makeHost = (client) => {
        const reportIfPageTransportError = jest.fn();
        const host = {
            ensureReady: jest.fn(),
            getClient: () => client,
            isPageTransportError: (error) => wwebjs_lifecycle_1.WwebjsLifecycle.prototype.isPageTransportError.call({}, error),
            reportIfPageTransportError,
            logger: (0, logger_service_1.createLogger)('wwebjs-protocol-timeout.spec'),
        };
        return { host, reportIfPageTransportError };
    };
    const CHAT = '628@c.us';
    const chats = (host) => new wwebjs_chats_1.WwebjsChats(host, {});
    const OPS = {
        getGroupInfo: ['getChatById', host => new wwebjs_groups_1.WwebjsGroups(host).getGroupInfo('120363@g.us')],
        getGroupJoinInfo: ['getInviteInfo', host => new wwebjs_groups_1.WwebjsGroups(host).getGroupJoinInfo('AbCdEf')],
        joinGroupViaInviteCode: ['acceptInvite', host => new wwebjs_groups_1.WwebjsGroups(host).joinGroupViaInviteCode('AbCdEf')],
        getChatsByLabel: ['getChatsByLabelId', host => new wwebjs_labels_1.WwebjsLabels(host).getChatsByLabel('7')],
        getContactById: ['getContactById', host => new wwebjs_contacts_1.WwebjsContacts(host).getContactById('628@c.us')],
        sendSeen: ['getChatById', host => chats(host).sendSeen(CHAT)],
        clearChatMessages: ['getChatById', host => chats(host).clearChatMessages(CHAT)],
        archiveChat: ['archiveChat', host => chats(host).archiveChat(CHAT, true)],
        muteChat: ['getChatById', host => chats(host).muteChat(CHAT, null)],
        markUnread: ['getChatById', host => chats(host).markUnread(CHAT)],
        deleteChat: ['getChatById', host => chats(host).deleteChat(CHAT)],
    };
    it.each(Object.keys(OPS))('%s answers an expired protocolTimeout with a 503 and reports no death', async (op) => {
        const [method, call] = OPS[op];
        const timeout = new Error(await puppeteerProtocolTimeoutMessage());
        const { host, reportIfPageTransportError } = makeHost({ [method]: jest.fn().mockRejectedValue(timeout) });
        await expect(call(host)).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
    // Mute and pin resolve the chat first, so the write itself is where a slow renderer runs out the budget.
    it.each([
        ['muteChat', (host) => chats(host).muteChat(CHAT, Date.now() + 60_000)],
        ['unmuteChat', (host) => chats(host).muteChat(CHAT, null)],
        ['pinChat', (host) => chats(host).pinChat(CHAT, true)],
        ['unpinChat', (host) => chats(host).pinChat(CHAT, false)],
    ])('%s answers a protocolTimeout on its write with a 503 and reports no death', async (method, call) => {
        const timeout = new Error(await puppeteerProtocolTimeoutMessage());
        const { host, reportIfPageTransportError } = makeHost({
            getChatById: jest.fn().mockResolvedValue({ id: { _serialized: CHAT } }),
            [method]: jest.fn().mockRejectedValue(timeout),
        });
        await expect(call(host)).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
    // The list reads walk the whole store in one command, so they are the ones a large account
    // pushes past the budget; none has a not-found verdict, but a raw rethrow would answer 500.
    it.each([
        ['getContacts', (host) => new wwebjs_contacts_1.WwebjsContacts(host).getContacts()],
        ['getChats', (host) => chats(host).getChats()],
        ['getGroups', (host) => new wwebjs_groups_1.WwebjsGroups(host).getGroups()],
    ])('%s answers an expired protocolTimeout with a 503 and reports no death', async (_op, call) => {
        const timeout = jest.fn().mockRejectedValue(new Error(await puppeteerProtocolTimeoutMessage()));
        const { host, reportIfPageTransportError } = makeHost({ pupPage: { evaluate: timeout } });
        await expect(call(host)).rejects.toBeInstanceOf(engine_transport_error_1.EngineTransportError);
        expect(timeout).toHaveBeenCalledTimes(1);
        expect(reportIfPageTransportError).not.toHaveBeenCalled();
    });
    // Negative twin: an ordinary page-side refusal keeps its not-found verdict.
    it.each([
        ['getGroupInfo', null],
        ['getGroupJoinInfo', group_not_found_error_1.GroupNotFoundError],
        ['joinGroupViaInviteCode', invalid_invite_code_error_1.InvalidInviteCodeError],
        ['getChatsByLabel', label_not_found_error_1.LabelNotFoundError],
        ['getContactById', null],
        ['sendSeen', false],
        ['clearChatMessages', false],
        ['archiveChat', false],
        ['muteChat', common_1.BadRequestException],
        ['markUnread', false],
        ['deleteChat', false],
    ])('%s keeps its verdict for an ordinary refusal', async (op, verdict) => {
        const [method, call] = OPS[op];
        const { host } = makeHost({ [method]: jest.fn().mockRejectedValue(new Error('Evaluation failed: not found')) });
        if (typeof verdict === 'function') {
            await expect(call(host)).rejects.toBeInstanceOf(verdict);
        }
        else {
            await expect(call(host)).resolves.toBe(verdict ?? null);
        }
    });
});
