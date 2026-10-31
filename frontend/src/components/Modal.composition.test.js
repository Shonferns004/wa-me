// An input method (Chinese, Japanese, Korean) takes Escape to cancel the text it is composing. That key
// belongs to the composition, not to the dialog around the field: closing the dialog on it discards the whole
// form the operator was filling in, which the page's other Escape handlers already avoid.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
let rtl;
let Modal;
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    rtl = await import('@testing-library/react');
    ({ Modal } = await import('./Modal.jsx'));
});
afterEach(() => rtl.cleanup());
function renderDialog(onClose) {
    rtl.render(createElement(Modal, {
        open: true,
        onClose,
        title: 'Create API key',
        closeLabel: 'Close',
        children: [
            createElement('label', { key: 'label', htmlFor: 'name' }, 'Name'),
            createElement('input', { key: 'input', id: 'name', type: 'text' }),
        ],
    }));
    const input = rtl.screen.getByLabelText('Name');
    input.focus();
    return input;
}
test('an Escape that cancels an IME composition in a dialog field keeps the dialog open', () => {
    let closes = 0;
    const input = renderDialog(() => closes++);
    rtl.fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    assert.equal(closes, 0, 'the Escape of a composition closed the dialog');
});
test('a plain Escape in a dialog field still closes the dialog', () => {
    let closes = 0;
    const input = renderDialog(() => closes++);
    rtl.fireEvent.keyDown(input, { key: 'Escape' });
    assert.equal(closes, 1);
});
