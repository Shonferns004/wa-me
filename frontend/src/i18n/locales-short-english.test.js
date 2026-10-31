// A catalogue in another script that holds the English value of a key shows English in that language's dashboard.
// The parity check warns about such a value only from 20 characters on, so a short label (a role name, a field
// caption) passes it unseen. Brand and technology names, font names and example inputs are the same in every
// language and are listed here; any other English value in these catalogues is text nobody translated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('./locales/', import.meta.url));
const NON_LATIN = ['ar', 'he', 'hi', 'ko', 'te', 'zh-CN', 'zh-HK'];
// The same text in every language.
const SAME_EVERYWHERE = new Set([
    'common.appName',
    'common.url',
    'nav.webhooks',
    'webhooks.title',
    'infrastructure.database.sqlite',
    'infrastructure.database.postgres',
    'infrastructure.redis.title',
    'infrastructure.storage.s3',
    'numberChecker.result.jid',
    'numberChecker.table.id',
    'sessions.proxy.urlPlaceholder',
    'messageTester.forwardFromPlaceholder',
    'messageTester.filenamePlaceholder',
    'messageTester.contactNamePlaceholder',
]);
const isFontName = (key) => key.startsWith('chats.status.fonts.') && key !== 'chats.status.fonts.system';
// Hebrew writes the terms Session and proxy in Latin script, in its sentences as in its labels.
const isKeptTerm = (lang, value) => lang === 'he' && /^(Sessions?|Proxy)$/.test(value);
function flatten(node, prefix = '', out = new Map()) {
    for (const [key, value] of Object.entries(node)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value))
            flatten(value, path, out);
        else
            out.set(path, value);
    }
    return out;
}
const read = (lang) => flatten(JSON.parse(readFileSync(`${dir}${lang}.json`, 'utf8')));
test('a catalogue in another script holds no English label outside the shared names', () => {
    assert.ok(NON_LATIN.every(lang => readdirSync(dir).includes(`${lang}.json`)));
    const en = read('en');
    const english = [];
    for (const lang of NON_LATIN) {
        const catalogue = read(lang);
        for (const [key, value] of en) {
            if (typeof value !== 'string' || catalogue.get(key) !== value)
                continue;
            if (!/[A-Za-z]{2,}/.test(value.replace(/\{\{.*?\}\}/g, '')))
                continue;
            if (SAME_EVERYWHERE.has(key) || isFontName(key) || isKeptTerm(lang, value))
                continue;
            english.push(`${lang} ${key} = ${value}`);
        }
    }
    assert.deepEqual(english, []);
});
