// The New Session modal keeps its draft across a create that is still in flight: the answer must not clear or
// close a draft that was edited, or typed after the modal was closed and opened again, since the request was sent.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
let rtl;
let useSessionCreateForm;
let ToastContext;
let createAnswer = new Promise(() => { });
const created = [];
const sentNames = [];
function sessionRow(name) {
    return { id: `id-${name}`, name, status: 'created', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '' };
}
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/api/sessions') && init?.method === 'POST') {
            sentNames.push(JSON.parse(String(init.body)).name);
            return createAnswer;
        }
        return Promise.resolve(new Response('{}', { status: 404 }));
    };
    rtl = await import('@testing-library/react');
    ({ useSessionCreateForm } = await import('./useSessionCreateForm.js'));
    ({ ToastContext } = await import('./useToast.js'));
});
afterEach(() => {
    rtl.cleanup();
    createAnswer = new Promise(() => { });
    created.length = 0;
    sentNames.length = 0;
});
function renderForm() {
    const noop = () => { };
    const value = {
        toasts: [],
        addToast: noop,
        removeToast: noop,
        success: noop,
        error: noop,
        warning: noop,
        info: noop,
    };
    const wrapper = ({ children }) => createElement(ToastContext.Provider, { value }, children);
    return rtl.renderHook(() => useSessionCreateForm({ onCreated: session => created.push(session), onFailed: noop }), {
        wrapper,
    });
}
function holdAnswer() {
    let release;
    createAnswer = new Promise(resolve => (release = resolve));
    return name => release(new Response(JSON.stringify(sessionRow(name)), { status: 201 }));
}
const settle = () => rtl.act(async () => void (await new Promise(resolve => setImmediate(resolve))));
test('a create answered in the visit that sent it clears the draft and closes the modal', async () => {
    const { result } = renderForm();
    const answer = holdAnswer();
    rtl.act(() => result.current.setShowCreateModal(true));
    rtl.act(() => result.current.setNewSessionName('dummy-a'));
    await rtl.act(async () => void result.current.handleCreate());
    assert.deepEqual(sentNames, ['dummy-a']);
    answer('dummy-a');
    await settle();
    assert.equal(result.current.showCreateModal, false);
    assert.equal(result.current.newSessionName, '');
    assert.deepEqual(created.map(s => s.name), ['dummy-a']);
});
test('a name edited while a create is in flight is kept when it is answered', async () => {
    const { result } = renderForm();
    const answer = holdAnswer();
    rtl.act(() => result.current.setShowCreateModal(true));
    rtl.act(() => result.current.setNewSessionName('dummy-a'));
    await rtl.act(async () => void result.current.handleCreate());
    rtl.act(() => result.current.setNewSessionName('dummy-ab'));
    answer('dummy-a');
    await settle();
    assert.equal(result.current.showCreateModal, true);
    assert.equal(result.current.newSessionName, 'dummy-ab');
});
test('a create cancelled while in flight still clears the form when it is answered', async () => {
    const { result } = renderForm();
    const answer = holdAnswer();
    rtl.act(() => result.current.setShowCreateModal(true));
    rtl.act(() => result.current.setNewSessionName('dummy-a'));
    await rtl.act(async () => void result.current.handleCreate());
    rtl.act(() => result.current.setShowCreateModal(false));
    answer('dummy-a');
    await settle();
    assert.equal(result.current.showCreateModal, false);
    assert.equal(result.current.newSessionName, '');
});
test('a create answered after the modal was closed and opened again leaves the new draft alone', async () => {
    const { result } = renderForm();
    const answer = holdAnswer();
    rtl.act(() => result.current.setShowCreateModal(true));
    rtl.act(() => result.current.setNewSessionName('dummy-a'));
    await rtl.act(async () => void result.current.handleCreate());
    rtl.act(() => result.current.setShowCreateModal(false));
    rtl.act(() => result.current.setShowCreateModal(true));
    rtl.act(() => result.current.setNewSessionName('dummy-b'));
    answer('dummy-a');
    await settle();
    assert.equal(result.current.showCreateModal, true);
    assert.equal(result.current.newSessionName, 'dummy-b');
    assert.equal(result.current.creating, false);
    assert.deepEqual(created.map(s => s.name), ['dummy-a']);
});
