// First-visit detection for Portuguese outside Brazil. The browser's preference list is read once, while the module
// initializes, so this lives in its own file (see detect-language.test.js).
import '../test-helpers/register-hooks.js';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
let i18n;
let resolveSupportedLanguage;
before(async () => {
    const { installJsdomGlobals } = (await import('../test-helpers/jsdom.js'));
    await installJsdomGlobals();
    Object.defineProperty(navigator, 'languages', { value: ['pt-PT', 'pt', 'en-US'], configurable: true });
    const module = (await import('./index.js'));
    i18n = module.default;
    resolveSupportedLanguage = module.resolveSupportedLanguage;
    await module.i18nReady;
});
test('a Portuguese visitor outside Brazil gets the Portuguese catalogue, not English', () => {
    assert.equal(i18n.language, 'pt-BR');
    assert.equal(localStorage.getItem('openwa_language'), 'pt-BR');
});
test('every Portuguese tag resolves to the one Portuguese catalogue', () => {
    for (const tag of ['pt', 'pt-PT', 'pt-pt', 'pt-AO', 'pt-BR', 'PT-br']) {
        assert.equal(resolveSupportedLanguage(tag), 'pt-BR', tag);
    }
});
