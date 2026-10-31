// First-visit language detection against the real i18n module. The browser's preference list is read
// once, while the module initializes, so this lives in its own file: node:test gives every file its own
// process, and nothing else here may import i18n before the preferences below are in place.
import '../test-helpers/register-hooks.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
let i18n;
before(async () => {
    const { installJsdomGlobals } = (await import('../test-helpers/jsdom.js'));
    await installJsdomGlobals();
    // A visitor whose first preference is a language the dashboard does not ship.
    Object.defineProperty(navigator, 'languages', { value: ['ja-JP', 'id-ID'], configurable: true });
    const module = (await import('./index.js'));
    i18n = module.default;
    await module.i18nReady;
});
test('an unsupported first preference yields to the next supported one, not to English', () => {
    assert.equal(i18n.language, 'id');
    assert.equal(localStorage.getItem('openwa_language'), 'id');
});
