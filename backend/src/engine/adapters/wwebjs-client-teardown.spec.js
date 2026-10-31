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
const whatsapp_web_js_adapter_1 = require("./whatsapp-web-js.adapter");
const whatsapp_engine_interface_1 = require("../interfaces/whatsapp-engine.interface");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const recipient_unreachable_error_1 = require("../../common/errors/recipient-unreachable.error");
const send_pacing_service_1 = require("../../modules/message/send-pacing.service");
const loadRemoteMediaModule = __importStar(require("../../common/media/load-remote-media"));
/**
 * A teardown (stop, logout, a browser crash) lands while an operation is parked on an await of its own: a
 * recipient lookup, a media fetch, the lookup of a chat. The adapter is in one of two states by then. While
 * client.destroy() runs it still holds the client but already reports DISCONNECTED; once destroy() settles
 * the client is null. In both the operation must answer the retryable not-ready 409 without touching the
 * page: left alone, a closing page fails a send with a plain 500 that the send breaker counts, and a null
 * client fails every other operation with a TypeError 500.
 */
const CHAT = '628111@c.us';
const LID = '159442138038327@lid';
const MEDIA_URL = 'https://files.example.com/a.png';
function gate() {
    let open;
    const wait = new Promise(resolve => {
        open = resolve;
    });
    const parked = {
        wait,
        open,
        parkedCalls: 0,
        park: () => {
            parked.parkedCalls += 1;
            return wait;
        },
    };
    return parked;
}
const PHASES = ['while destroy() runs', 'after destroy() settled'];
/** A READY adapter around `client`, and a way to begin its teardown in either phase. */
function readyAdapter(client) {
    const destroyed = gate();
    const adapter = new whatsapp_web_js_adapter_1.WhatsAppWebJsAdapter({ sessionId: 's', sessionDataPath: './data/sessions', puppeteer: {} });
    adapter.status = whatsapp_engine_interface_1.EngineStatus.READY;
    adapter.client = { ...client, destroy: jest.fn(() => destroyed.wait) };
    let teardown;
    return {
        adapter,
        tearDown: async (phase) => {
            teardown = adapter.disconnect();
            if (phase === 'after destroy() settled') {
                destroyed.open();
                await teardown;
            }
        },
        finish: async () => {
            destroyed.open();
            await teardown;
        },
    };
}
/** Let every pending microtask and the macrotasks queued before this call run. */
const settle = () => new Promise(resolve => setImmediate(resolve));
/** How an operation ended, kept apart so a resolved value cannot be mistaken for a rejection. */
const outcomeOf = (operation) => operation.then(value => ({ value }), (error) => ({ error }));
const found = (wid) => ({ _serialized: wid });
const closedTarget = () => new Error('Protocol error (Runtime.callFunctionOn): Target closed.');
const mediaFetchParked = (parked) => {
    jest
        .spyOn(loadRemoteMediaModule, 'loadRemoteMediaBuffer')
        .mockImplementation(() => parked.park().then(() => ({ data: Buffer.from([1]), mimetype: 'image/png' })));
};
const CASES = [
    {
        name: 'a text send',
        build: parked => {
            const sendMessage = jest.fn();
            return {
                client: { getNumberId: () => parked.park().then(() => found(CHAT)), sendMessage },
                unreached: sendMessage,
            };
        },
        run: adapter => adapter.sendTextMessage(CHAT, 'hi'),
    },
    {
        name: 'an image status post',
        build: parked => {
            mediaFetchParked(parked);
            const sendMessage = jest.fn();
            return { client: { sendMessage }, unreached: sendMessage };
        },
        run: adapter => adapter.postImageStatus({ mimetype: 'image/png', data: MEDIA_URL }, {}),
    },
    {
        name: 'a profile picture upload',
        build: parked => {
            mediaFetchParked(parked);
            const setProfilePicture = jest.fn();
            return { client: { setProfilePicture }, unreached: setProfilePicture };
        },
        run: adapter => adapter.setProfilePicture({ mimetype: 'image/png', data: MEDIA_URL }),
    },
    {
        name: 'a group invite revoke',
        build: parked => {
            const evaluate = jest.fn();
            return {
                client: { getChatById: () => parked.park().then(() => ({ isGroup: true })), pupPage: { evaluate } },
                unreached: evaluate,
            };
        },
        run: adapter => adapter.revokeGroupInviteCode('120363@g.us'),
    },
    {
        // requireGroupChat is the preamble of every group write, and the write goes out right after it. A
        // non-idempotent one (an add) would otherwise reach the closing page and fail as a plain 500.
        name: 'a participant add parked in the group lookup',
        build: parked => {
            const addParticipants = jest.fn();
            const chat = { isGroup: true, addParticipants };
            return { client: { getChatById: () => parked.park().then(() => chat) }, unreached: addParticipants };
        },
        run: adapter => adapter.addParticipants('120363@g.us', ['628111@c.us']),
    },
    {
        name: 'a group subject change parked in the group lookup',
        build: parked => {
            const setSubject = jest.fn();
            const chat = { isGroup: true, setSubject };
            return { client: { getChatById: () => parked.park().then(() => chat) }, unreached: setSubject };
        },
        run: adapter => adapter.setGroupSubject('120363@g.us', 'New subject'),
    },
    {
        name: 'a chat label change',
        build: parked => {
            const addOrRemoveLabels = jest.fn();
            const chat = { getLabels: () => Promise.resolve([]) };
            return {
                client: { getChatById: () => parked.park().then(() => chat), addOrRemoveLabels },
                unreached: addOrRemoveLabels,
            };
        },
        run: adapter => adapter.addLabelToChat(CHAT, '7'),
    },
    {
        name: 'a chat mute',
        build: parked => {
            const muteChat = jest.fn();
            return { client: { getChatById: () => parked.park().then(() => ({})), muteChat }, unreached: muteChat };
        },
        run: adapter => adapter.muteChat(CHAT, Date.now() + 60_000),
    },
    {
        // The phone behind the lid is read after the lookup.
        name: 'a number check of a migrated contact',
        build: parked => {
            const getContactLidAndPhone = jest.fn();
            return {
                client: { getNumberId: () => parked.park().then(() => found(LID)), getContactLidAndPhone },
                unreached: getContactLidAndPhone,
            };
        },
        run: adapter => adapter.getNumberId('5511987654321'),
    },
    {
        // A picture lookup by phone id that came back empty is retried by the LID the page holds.
        name: 'a profile picture read retried by its LID',
        build: parked => {
            const evaluate = jest.fn();
            return {
                client: { getProfilePicUrl: () => parked.park().then(() => undefined), pupPage: { evaluate } },
                unreached: evaluate,
            };
        },
        run: adapter => adapter.getProfilePicture(CHAT),
    },
    {
        // The client is read again after the lookup, inside a catch that answers a missing group with null.
        name: 'a group info read',
        build: parked => {
            const group = {
                isGroup: true,
                id: { _serialized: '120363@g.us' },
                name: 'G',
                participants: [],
                groupMetadata: {},
            };
            return { client: { getChatById: () => parked.park().then(() => group), info: { wid: found(CHAT) } } };
        },
        run: adapter => adapter.getGroupInfo('120363@g.us'),
    },
    {
        // The reply and forward legs send through the quoted Message's own client, never through the host accessor.
        name: 'a reply',
        build: parked => {
            const reply = jest.fn();
            const chat = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'Q1' }, reply }]) };
            return {
                client: { getNumberId: () => parked.park().then(() => found(CHAT)), getChatById: () => Promise.resolve(chat) },
                unreached: reply,
            };
        },
        run: adapter => adapter.replyToMessage(CHAT, 'Q1', 'hi'),
    },
    {
        // The history read precedes the send: a page that dies under it means nothing went out.
        name: 'a reply parked in its history read',
        build: parked => {
            const reply = jest.fn();
            const chat = { fetchMessages: () => parked.park().then(() => Promise.reject(closedTarget())) };
            return {
                client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.resolve(chat) },
                unreached: reply,
            };
        },
        run: adapter => adapter.replyToMessage(CHAT, 'Q1', 'hi'),
    },
    {
        name: 'a forward parked in the read of its source chat',
        build: parked => {
            const forward = jest.fn();
            const source = { fetchMessages: () => parked.park().then(() => Promise.reject(closedTarget())) };
            return {
                client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.resolve(source) },
                unreached: forward,
            };
        },
        run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
    },
    {
        name: 'a forward parked in the destination lookup',
        build: parked => {
            const forward = jest.fn();
            const chat = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
            return {
                client: { getNumberId: () => parked.park().then(() => found(CHAT)), getChatById: () => Promise.resolve(chat) },
                unreached: forward,
            };
        },
        run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
    },
    {
        name: 'a forward parked in the read of the destination chat',
        build: parked => {
            const forward = jest.fn();
            const source = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
            const destination = { fetchMessages: () => Promise.resolve([]) };
            return {
                client: {
                    getNumberId: () => Promise.resolve(found(CHAT)),
                    getChatById: (id) => id === 'src@c.us' ? Promise.resolve(source) : parked.park().then(() => destination),
                },
                unreached: forward,
            };
        },
        run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
    },
];
describe('whatsapp-web.js operations that race a session teardown', () => {
    afterEach(() => jest.restoreAllMocks());
    describe.each(PHASES)('%s', phase => {
        it.each(CASES)('answers the not-ready 409 for $name, before it reaches the page', async (testCase) => {
            const parked = gate();
            const { client, unreached } = testCase.build(parked);
            const { adapter, tearDown, finish } = readyAdapter(client);
            const outcome = outcomeOf(testCase.run(adapter));
            await settle();
            expect(parked.parkedCalls).toBe(1);
            await tearDown(phase);
            parked.open();
            const result = await outcome;
            await finish();
            if (unreached)
                expect(unreached).not.toHaveBeenCalled();
            expect(result).toEqual({ error: expect.any(engine_not_ready_error_1.EngineNotReadyError) });
            const { error } = result;
            expect((0, send_pacing_service_1.countsTowardSendBreaker)(error)).toBe(false);
            expect((0, send_pacing_service_1.sentNothing)(error)).toBe(true);
        });
    });
    describe('the send retry after "No LID for user"', () => {
        it.each(PHASES)('answers the not-ready 409, not an unreachable recipient, %s', async (phase) => {
            // The first send fails on a stale id; the re-resolve parks, and the lookup then fails on the closing page.
            const parked = gate();
            const sendMessage = jest.fn().mockRejectedValue(new Error('No LID for user'));
            const getNumberId = jest
                .fn()
                .mockResolvedValueOnce(found(CHAT))
                .mockImplementationOnce(() => parked.park().then(() => Promise.reject(new Error('Protocol error: Target closed'))));
            const { adapter, tearDown, finish } = readyAdapter({ getNumberId, sendMessage });
            const outcome = outcomeOf(adapter.sendTextMessage(CHAT, 'hi'));
            await settle();
            expect(parked.parkedCalls).toBe(1);
            await tearDown(phase);
            parked.open();
            const result = await outcome;
            await finish();
            expect(result).toEqual({ error: expect.any(engine_not_ready_error_1.EngineNotReadyError) });
            expect(result.error).not.toBeInstanceOf(recipient_unreachable_error_1.RecipientUnreachableError);
            expect(sendMessage).toHaveBeenCalledTimes(1);
        });
        it.each(PHASES)('does not retry a reply once the session is going away, %s', async (phase) => {
            // The re-resolve names a different id, which would normally be retried, here on the Message's own client.
            const parked = gate();
            const reply = jest.fn().mockRejectedValue(new Error('No LID for user'));
            const chat = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'Q1' }, reply }]) };
            const getNumberId = jest
                .fn()
                .mockResolvedValueOnce(found(LID))
                .mockImplementationOnce(() => parked.park().then(() => found(CHAT)));
            const { adapter, tearDown, finish } = readyAdapter({ getNumberId, getChatById: () => Promise.resolve(chat) });
            const outcome = outcomeOf(adapter.replyToMessage(CHAT, 'Q1', 'hi'));
            await settle();
            expect(parked.parkedCalls).toBe(1);
            await tearDown(phase);
            parked.open();
            const result = await outcome;
            await finish();
            expect(reply).toHaveBeenCalledTimes(1);
            expect(result).toEqual({ error: expect.any(engine_not_ready_error_1.EngineNotReadyError) });
        });
    });
    it.each([
        ['a reply', (adapter) => adapter.replyToMessage(CHAT, 'Q1', 'hi')],
        ['a forward', (adapter) => adapter.forwardMessage('src@c.us', CHAT, 'M1')],
    ])('leaves an ordinary failure in the history read of %s untouched on a ready session', async (_kind, run) => {
        const boom = new Error('Evaluation failed: boom');
        const chat = { fetchMessages: () => Promise.reject(boom) };
        const { adapter, finish } = readyAdapter({
            getNumberId: () => Promise.resolve(found(CHAT)),
            getChatById: () => Promise.resolve(chat),
        });
        await expect(run(adapter)).rejects.toBe(boom);
        await finish();
    });
    it('lets a forward go on when the read of its destination chat merely fails', async () => {
        const forward = jest.fn().mockResolvedValue(undefined);
        const source = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
        const destination = { fetchMessages: () => Promise.reject(new Error('Evaluation failed: boom')) };
        const { adapter } = readyAdapter({
            getNumberId: () => Promise.resolve(found(CHAT)),
            getChatById: (id) => Promise.resolve(id === 'src@c.us' ? source : destination),
        });
        const onDisconnected = jest.fn();
        adapter.callbacks = { onDisconnected };
        await expect(adapter.forwardMessage('src@c.us', CHAT, 'M1')).resolves.toEqual({
            id: '',
            timestamp: expect.any(Number),
        });
        expect(forward).toHaveBeenCalledTimes(1);
        expect(onDisconnected).not.toHaveBeenCalled();
        expect(adapter.getStatus()).toBe(whatsapp_engine_interface_1.EngineStatus.READY);
    });
    // A page-side exception reaches Node as "Evaluation failed: ..." and can quote WhatsApp Web's own socket
    // ("connection closed"), or a transport phrase of the caller's own making. With the page alive that is a
    // failed read, not a death: the forward goes on as it did before the read reported anything.
    it.each([
        ['Evaluation failed: Error: connection closed'],
        ['Evaluation failed: Error: Protocol error: target closed'],
    ])('lets a forward go on when the destination read says "%s" and the page is alive', async (message) => {
        const forward = jest.fn().mockResolvedValue(undefined);
        const source = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
        const destination = { fetchMessages: () => Promise.reject(new Error(message)) };
        const { adapter } = readyAdapter({
            pupPage: { isClosed: () => false },
            pupBrowser: { connected: true },
            getNumberId: () => Promise.resolve(found(CHAT)),
            getChatById: (id) => Promise.resolve(id === 'src@c.us' ? source : destination),
        });
        const onDisconnected = jest.fn();
        adapter.callbacks = { onDisconnected };
        await expect(adapter.forwardMessage('src@c.us', CHAT, 'M1')).resolves.toEqual({
            id: '',
            timestamp: expect.any(Number),
        });
        expect(forward).toHaveBeenCalledTimes(1);
        expect(onDisconnected).not.toHaveBeenCalled();
        expect(adapter.getStatus()).toBe(whatsapp_engine_interface_1.EngineStatus.READY);
    });
    // Puppeteer rejects a call pending on a dying page a few milliseconds before it marks the page closed
    // (measured with Chromium stopped by SIGTERM and a tab closed from outside), so the flags read alive at
    // the moment the read fails.
    it('still refuses a forward when the page reads gone only a moment after its destination read failed', async () => {
        const forward = jest.fn();
        const source = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
        const destination = { fetchMessages: () => Promise.reject(closedTarget()) };
        let closed = false;
        const { adapter } = readyAdapter({
            pupPage: { isClosed: () => closed },
            pupBrowser: { connected: true },
            getNumberId: () => Promise.resolve(found(CHAT)),
            getChatById: (id) => Promise.resolve(id === 'src@c.us' ? source : destination),
        });
        const onDisconnected = jest.fn();
        adapter.callbacks = { onDisconnected };
        setTimeout(() => (closed = true), 60);
        const result = await outcomeOf(adapter.forwardMessage('src@c.us', CHAT, 'M1'));
        expect(result).toEqual({ error: expect.any(engine_not_ready_error_1.EngineNotReadyError) });
        expect(forward).not.toHaveBeenCalled();
        expect(onDisconnected).toHaveBeenCalledTimes(1);
        expect(adapter.getStatus()).toBe(whatsapp_engine_interface_1.EngineStatus.DISCONNECTED);
    });
    it('keeps a send that was already on the wire an outcome-unknown failure', async () => {
        const onWire = gate();
        const sendMessage = jest.fn(() => onWire.park().then(() => Promise.reject(new Error('Protocol error (Runtime.callFunctionOn): Target closed.'))));
        const { adapter, tearDown, finish } = readyAdapter({
            getNumberId: () => Promise.resolve(found(CHAT)),
            sendMessage,
        });
        const outcome = outcomeOf(adapter.sendTextMessage(CHAT, 'hi'));
        await settle();
        expect(onWire.parkedCalls).toBe(1);
        await tearDown('while destroy() runs');
        onWire.open();
        const { error } = (await outcome);
        await finish();
        expect(error).toBeInstanceOf(Error);
        expect(error).not.toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect((0, send_pacing_service_1.countsTowardSendBreaker)(error)).toBe(true);
        expect((0, send_pacing_service_1.sentNothing)(error)).toBe(false);
    });
});
const DEATH_CASES = [
    {
        name: 'the chat lookup of a reply',
        build: () => ({
            client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.reject(closedTarget()) },
        }),
        run: adapter => adapter.replyToMessage(CHAT, 'Q1', 'hi'),
    },
    {
        name: 'the history read of a reply',
        build: () => {
            const reply = jest.fn();
            const chat = { fetchMessages: () => Promise.reject(closedTarget()) };
            return {
                client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.resolve(chat) },
                unreached: reply,
            };
        },
        run: adapter => adapter.replyToMessage(CHAT, 'Q1', 'hi'),
    },
    {
        name: 'the source chat lookup of a forward',
        build: () => ({
            client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.reject(closedTarget()) },
        }),
        run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
    },
    {
        name: 'the source history read of a forward',
        build: () => {
            const forward = jest.fn();
            const source = { fetchMessages: () => Promise.reject(closedTarget()) };
            return {
                client: { getNumberId: () => Promise.resolve(found(CHAT)), getChatById: () => Promise.resolve(source) },
                unreached: forward,
            };
        },
        run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
    },
    {
        // A failed destination read never blocks a forward by itself, but a page that died under it does.
        name: 'the destination chat lookup of a forward',
        build: () => {
            const forward = jest.fn();
            const source = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
            return {
                client: {
                    pupPage: { isClosed: () => true },
                    getNumberId: () => Promise.resolve(found(CHAT)),
                    getChatById: (id) => (id === 'src@c.us' ? Promise.resolve(source) : Promise.reject(closedTarget())),
                },
                unreached: forward,
            };
        },
        run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
    },
    {
        name: 'the destination history read of a forward',
        build: () => {
            const forward = jest.fn();
            const source = { fetchMessages: () => Promise.resolve([{ id: { _serialized: 'M1' }, forward }]) };
            const destination = { fetchMessages: () => Promise.reject(closedTarget()) };
            return {
                client: {
                    pupPage: { isClosed: () => false },
                    pupBrowser: { connected: false },
                    getNumberId: () => Promise.resolve(found(CHAT)),
                    getChatById: (id) => Promise.resolve(id === 'src@c.us' ? source : destination),
                },
                unreached: forward,
            };
        },
        run: adapter => adapter.forwardMessage('src@c.us', CHAT, 'M1'),
    },
];
describe('whatsapp-web.js operations whose page dies on its own', () => {
    it.each(DEATH_CASES)('reports the death and answers the not-ready 409 when $name fails', async (testCase) => {
        const { client, unreached } = testCase.build();
        const { adapter } = readyAdapter(client);
        const onDisconnected = jest.fn();
        adapter.callbacks = { onDisconnected };
        const result = await outcomeOf(testCase.run(adapter));
        if (unreached)
            expect(unreached).not.toHaveBeenCalled();
        expect(result).toEqual({ error: expect.any(engine_not_ready_error_1.EngineNotReadyError) });
        const { error } = result;
        expect((0, send_pacing_service_1.countsTowardSendBreaker)(error)).toBe(false);
        expect((0, send_pacing_service_1.sentNothing)(error)).toBe(true);
        expect(onDisconnected).toHaveBeenCalledTimes(1);
        expect(adapter.getStatus()).toBe(whatsapp_engine_interface_1.EngineStatus.DISCONNECTED);
    });
});
