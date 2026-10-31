"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const wwebjs_groups_1 = require("./wwebjs-groups");
const wwebjs_messaging_1 = require("./wwebjs-messaging");
jest.mock('./wwebjs-messaging', () => ({ toMessageMedia: jest.fn() }));
jest.mock('./wwebjs-chats', () => ({ listChats: jest.fn() }));
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}
const GROUP = '120363123456@g.us';
const INPUT = { mimetype: 'image/png', data: 'QUJD' };
const PICTURE = { mimetype: 'image/png', data: 'QUJD', filename: 'dummy.png' };
function harness() {
    const media = deferred();
    const mediaEntered = deferred();
    const commands = [];
    const state = { ready: true };
    const client = {
        getChatById: () => Promise.resolve({
            id: { _serialized: GROUP },
            isGroup: true,
            setPicture(picture) {
                commands.push(picture);
                return Promise.resolve(true);
            },
        }),
    };
    jest.mocked(wwebjs_messaging_1.toMessageMedia).mockImplementation(() => {
        mediaEntered.resolve();
        return media.promise;
    });
    const host = {
        ensureReady() {
            if (!state.ready)
                throw new engine_not_ready_error_1.EngineNotReadyError();
        },
        getClient() {
            host.ensureReady();
            return client;
        },
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
        config: { sessionId: 'picture-session' },
        logger: { debug: jest.fn() },
    };
    return { groups: new wwebjs_groups_1.WwebjsGroups(host), state, commands, media, mediaEntered };
}
describe('group picture write when the session stops during media preparation', () => {
    afterEach(() => jest.clearAllMocks());
    it('writes the picture when the session stays ready', async () => {
        const fixture = harness();
        const pending = fixture.groups.setGroupPicture(GROUP, INPUT);
        await fixture.mediaEntered.promise;
        fixture.media.resolve(PICTURE);
        await pending;
        expect(fixture.commands).toEqual([PICTURE]);
    });
    it('answers not-ready without writing when the session stopped meanwhile', async () => {
        const fixture = harness();
        const pending = fixture.groups.setGroupPicture(GROUP, INPUT).catch(error => error);
        await fixture.mediaEntered.promise;
        fixture.state.ready = false;
        fixture.media.resolve(PICTURE);
        const result = await pending;
        expect(result).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(fixture.commands).toEqual([]);
    });
    it('keeps a media preparation error and writes nothing', async () => {
        const fixture = harness();
        const failure = new Error('Dummy media preparation failed');
        const pending = fixture.groups.setGroupPicture(GROUP, INPUT).catch(error => error);
        await fixture.mediaEntered.promise;
        fixture.media.reject(failure);
        expect(await pending).toBe(failure);
        expect(fixture.commands).toEqual([]);
    });
});
