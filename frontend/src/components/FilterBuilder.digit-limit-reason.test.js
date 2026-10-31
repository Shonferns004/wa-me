// A webhook filter value of more than 15 digits is not added, such as two numbers typed with a space between them.
// The field has to say so, as the Number Checker and the Message Tester do for the same entry: pressing Enter with
// nothing happening, over an empty suggestion box, reads as a broken field.
import '../test-helpers/register-hooks.js';
import { test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
let rtl;
let FilterBuilder;
const TOO_LONG = 'More than 15 digits is not one phone number. Enter one number.';
before(async () => {
    const { installJsdomGlobals } = await import('../test-helpers/jsdom.js');
    await installJsdomGlobals();
    const { i18nReady } = await import('../i18n/index.js');
    await i18nReady;
    rtl = await import('@testing-library/react');
    ({ FilterBuilder } = await import('./FilterBuilder.jsx'));
});
afterEach(() => rtl.cleanup());
function Harness() {
    const [filters, setFilters] = useState({
        conditions: [{ field: 'sender', operator: 'is', value: [] }],
    });
    return createElement(FilterBuilder, { filters, onChange: setFilters, chats: [] });
}
/** Types a value into the sender field, presses Enter, and returns the chips added and the status line shown. */
function typeAndEnter(value) {
    const { container } = rtl.render(createElement(Harness));
    const input = container.querySelector('.chips-text');
    rtl.fireEvent.focus(input);
    rtl.fireEvent.change(input, { target: { value } });
    rtl.fireEvent.keyDown(input, { key: 'Enter' });
    return {
        chips: Array.from(container.querySelectorAll('.chip')).map(chip => chip.getAttribute('title') ?? ''),
        status: container.querySelector('[role="status"]')?.textContent ?? null,
    };
}
test('a sender value of more than 15 digits that is not added says why', () => {
    const { chips, status } = typeAndEnter('6281234567890 6289876543210');
    assert.deepEqual(chips, []);
    assert.equal(status, TOO_LONG, 'nothing names the limit');
});
test('a fifteen-digit number is added with no note', () => {
    assert.deepEqual(typeAndEnter('123456789012345'), { chips: ['123456789012345@c.us'], status: null });
});
test('a full id with more than 15 digits is added with no note', () => {
    assert.deepEqual(typeAndEnter('120363012345678901@g.us'), { chips: ['120363012345678901@g.us'], status: null });
});
