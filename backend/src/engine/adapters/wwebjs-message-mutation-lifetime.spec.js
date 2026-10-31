"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const wwebjs_messaging_1 = require("./wwebjs-messaging");
const CHAT = '628111@c.us';
const MESSAGE = 'true_628111@c.us_dummy';
const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
const operations = ['react', 'delete', 'edit', 'vote', 'pin', 'star', 'unstar', 'unpin'];
const stages = ['chat', 'messages'];
const invoke = (messaging, operation) => {
    switch (operation) {
        case 'react':
            return messaging.reactToMessage(CHAT, MESSAGE, 'x');
        case 'delete':
            return messaging.deleteMessage(CHAT, MESSAGE, true);
        case 'edit':
            return messaging.editMessage(CHAT, MESSAGE, 'edited body');
        case 'vote':
            return messaging.votePoll(CHAT, MESSAGE, ['a']);
        case 'pin':
            return messaging.pinMessage(CHAT, MESSAGE, 86400);
        case 'star':
            return messaging.starMessage(CHAT, MESSAGE, true);
        case 'unstar':
            return messaging.starMessage(CHAT, MESSAGE, false);
        case 'unpin':
            return messaging.unpinMessage(CHAT, MESSAGE);
    }
};
/** A READY client whose chat lookup or message fetch is held at `stage` until the test releases it. */
function fixture(operation, stage) {
    const entered = deferred();
    const gate = deferred();
    const result = { id: { _serialized: MESSAGE, id: 'dummy' }, timestamp: 1 };
    const mutation = jest
        .fn()
        .mockResolvedValue(operation === 'edit' ? result : operation === 'pin' || operation === 'unpin' ? true : undefined);
    const message = {
        ...result,
        pollOptions: [{ name: 'a' }, { name: 'b' }],
        react: mutation,
        delete: mutation,
        edit: mutation,
        vote: mutation,
        pin: mutation,
        star: mutation,
        unstar: mutation,
        unpin: mutation,
    };
    const wait = async (name, value) => {
        if (stage === name) {
            entered.resolve();
            await gate.promise;
        }
        return value;
    };
    const chat = { fetchMessages: jest.fn(() => wait('messages', [message])) };
    const client = { getChatById: jest.fn(() => wait('chat', chat)) };
    let ready = true;
    const host = {
        ensureReady() {
            if (!ready)
                throw new engine_not_ready_error_1.EngineNotReadyError();
        },
        getClient() {
            host.ensureReady();
            return client;
        },
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
        logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
        config: {},
    };
    return {
        messaging: new wwebjs_messaging_1.WwebjsMessaging(host),
        mutation,
        entered,
        gate,
        stopSession: () => {
            ready = false;
        },
    };
}
describe('message mutations when the session stops during their lookup', () => {
    it.each(operations)('runs %s on a session that stays ready', async (operation) => {
        const test = fixture(operation);
        await invoke(test.messaging, operation);
        expect(test.mutation).toHaveBeenCalledTimes(1);
    });
    const stopped = operations.flatMap(operation => stages.map(stage => ({ operation, stage })));
    it.each(stopped)('refuses $operation after the session stopped during the $stage lookup', async ({ operation, stage }) => {
        const test = fixture(operation, stage);
        const done = invoke(test.messaging, operation).catch((error) => error);
        await test.entered.promise;
        test.stopSession();
        test.gate.resolve();
        expect(await done).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(test.mutation).not.toHaveBeenCalled();
    });
    it.each(stopped)('keeps the $stage lookup failure of $operation', async ({ operation, stage }) => {
        const test = fixture(operation, stage);
        const failure = new Error('dummy lookup unavailable');
        const done = invoke(test.messaging, operation).catch((error) => error);
        await test.entered.promise;
        test.gate.reject(failure);
        expect(await done).toBe(failure);
        expect(test.mutation).not.toHaveBeenCalled();
    });
});
