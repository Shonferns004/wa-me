"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const node_vm_1 = require("node:vm");
const whatsapp_web_js_1 = require("whatsapp-web.js");
const engine_not_ready_error_1 = require("../../common/errors/engine-not-ready.error");
const wwebjs_labels_1 = require("./wwebjs-labels");
const CHAT = '628123456789@c.us';
const OTHER_CHAT = '628987654321@c.us';
function deferred() {
    let resolve;
    const promise = new Promise(done => {
        resolve = done;
    });
    return { promise, resolve };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
/** Run the installed SDK's action generator with inert collections and explicit visibility. */
function harness(initial = [], failure) {
    const entered = deferred();
    const release = deferred();
    const committed = deferred();
    const commands = [];
    const definitions = ['A', 'B', 'C'].map(id => ({ id, name: id, hexColor: '#000000' }));
    const state = { ready: true, client: undefined };
    function makeClient() {
        const chats = [CHAT, OTHER_CHAT].map(id => ({
            id: { _serialized: id },
            labels: id === CHAT ? [...initial] : [],
        }));
        let targetEvaluations = 0;
        let heldFirstWrite = false;
        const window = {
            WWebJS: { getLabels: () => definitions },
            require(module) {
                if (module === 'WAWebConnModel')
                    return { Conn: { platform: 'smba' } };
                if (module !== 'WAWebCollections')
                    throw new Error(`Unexpected page module: ${module}`);
                return {
                    Chat: { filter: (predicate) => chats.filter(predicate) },
                    Label: {
                        async addOrRemoveLabels(actions, selected) {
                            commands.push({
                                chats: selected.map(chat => chat.id._serialized),
                                actions: actions.map(action => ({ id: action.id, type: action.type })),
                            });
                            const hold = !heldFirstWrite && selected.some(chat => chat.id._serialized === CHAT);
                            if (hold) {
                                heldFirstWrite = true;
                                entered.resolve();
                                await release.promise;
                            }
                            try {
                                if (hold && failure)
                                    throw failure;
                                for (const chat of selected) {
                                    const ids = new Set(chat.labels);
                                    for (const action of actions) {
                                        if (action.type === 'add')
                                            ids.add(action.id);
                                        else
                                            ids.delete(action.id);
                                    }
                                    chat.labels = [...ids];
                                }
                            }
                            finally {
                                if (hold)
                                    committed.resolve();
                            }
                        },
                    },
                };
            },
        };
        const client = {
            getChatById(id) {
                const model = chats.find(chat => chat.id._serialized === id);
                return Promise.resolve(model
                    ? {
                        id: model.id,
                        getLabels: () => Promise.resolve(model.labels.map(label => definitions.find(definition => definition.id === label))),
                    }
                    : undefined);
            },
            getLabels: () => Promise.resolve(definitions),
            addOrRemoveLabels(ids, chatIds) {
                return whatsapp_web_js_1.Client.prototype.addOrRemoveLabels.call(client, ids, chatIds);
            },
            pupPage: {
                async evaluate(fn, ids, chatIds) {
                    if (chatIds.includes(CHAT) && ++targetEvaluations > 1) {
                        await committed.promise;
                    }
                    const evaluate = (0, node_vm_1.runInNewContext)(`(${fn.toString()})`, { window });
                    return evaluate(ids, chatIds);
                },
            },
        };
        return {
            client: client,
            labels: (id = CHAT) => [...chats.find(chat => chat.id._serialized === id).labels].sort(),
        };
    }
    const original = makeClient();
    state.client = original.client;
    const host = {
        ensureReady() {
            if (!state.ready)
                throw new engine_not_ready_error_1.EngineNotReadyError();
        },
        getClient() {
            host.ensureReady();
            return state.client;
        },
        isPageTransportError: () => false,
        reportIfPageTransportError: jest.fn(),
        logger: { debug: jest.fn() },
        config: { sessionId: 'label-session' },
    };
    return { labels: new wwebjs_labels_1.WwebjsLabels(host), state, original, commands, entered, release };
}
describe('chat label membership updates', () => {
    it('keeps both additions when the first write becomes visible before the second SDK evaluation', async () => {
        const fixture = harness();
        const first = fixture.labels.addLabelToChat(CHAT, 'A');
        await fixture.entered.promise;
        const second = fixture.labels.addLabelToChat(CHAT, 'B');
        await nextTurn();
        fixture.release.resolve();
        await Promise.all([first, second]);
        expect(fixture.commands[1].actions).not.toContainEqual({ id: 'A', type: 'remove' });
        expect(fixture.original.labels()).toEqual(['A', 'B']);
    });
    it('does not restore a removed label while adding a different label', async () => {
        const fixture = harness(['A']);
        const first = fixture.labels.removeLabelFromChat(CHAT, 'A');
        await fixture.entered.promise;
        const second = fixture.labels.addLabelToChat(CHAT, 'B');
        await nextTurn();
        fixture.release.resolve();
        await Promise.all([first, second]);
        expect(fixture.commands[1].actions).not.toContainEqual({ id: 'A', type: 'add' });
        expect(fixture.original.labels()).toEqual(['B']);
    });
    it('releases a failed write so the next update can complete', async () => {
        const failure = new Error('Dummy label write failed');
        const fixture = harness([], failure);
        const first = fixture.labels.addLabelToChat(CHAT, 'A').catch(error => error);
        await fixture.entered.promise;
        const second = fixture.labels.addLabelToChat(CHAT, 'B');
        await nextTurn();
        fixture.release.resolve();
        expect(await first).toBe(failure);
        await second;
        expect(fixture.original.labels()).toEqual(['B']);
    });
    it('lets a different chat update finish while the first chat is waiting', async () => {
        const fixture = harness();
        const first = fixture.labels.addLabelToChat(CHAT, 'A');
        await fixture.entered.promise;
        let otherFinished = false;
        const other = fixture.labels.addLabelToChat(OTHER_CHAT, 'B').then(() => {
            otherFinished = true;
        });
        await nextTurn();
        const observedBeforeRelease = { finished: otherFinished, labels: fixture.original.labels(OTHER_CHAT) };
        fixture.release.resolve();
        await Promise.all([first, other]);
        expect(observedBeforeRelease).toEqual({ finished: true, labels: ['B'] });
    });
    it('rejects an update waiting behind a write when the session stops', async () => {
        const fixture = harness();
        const first = fixture.labels.addLabelToChat(CHAT, 'A').catch(error => error);
        await fixture.entered.promise;
        const second = fixture.labels.addLabelToChat(CHAT, 'B').catch(error => error);
        await nextTurn();
        fixture.state.ready = false;
        fixture.release.resolve();
        const results = await Promise.all([first, second]);
        expect(results[1]).toBeInstanceOf(engine_not_ready_error_1.EngineNotReadyError);
        expect(fixture.commands).toHaveLength(1);
        expect(fixture.original.labels()).toEqual(['A']);
    });
});
