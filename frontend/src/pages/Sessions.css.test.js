import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SESSION_STATUSES } from '../utils/sessionForm.js';
// The session detail modal renders `status-badge <status>` and a session card renders `status-pill <status>`, both
// with the live status as the second class. A status without a rule renders as plain text: the badge once styled
// only the retired names connected, disconnected and connecting, so a ready session showed no green pill and a
// failed one looked the same.
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
// The statuses come from the same runtime list the API surface publishes, so a status added there
// cannot silently render without a pill.
const statuses = SESSION_STATUSES;
const css = readFileSync(join(SRC, 'pages/Sessions.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = new Set([...css.matchAll(/([^{}]+)\{[^{}]*\}/g)].flatMap(m => m[1].split(',').map(s => s.trim().replace(/\s+/g, ' '))));
test('the session detail badge and the card pill are styled for every session status', () => {
    assert.ok(statuses.includes('ready') && statuses.includes('action_required'), `read only ${statuses.join(', ')}`);
    const missing = ['status-badge', 'status-pill'].flatMap(kind => statuses.filter(status => !selectors.has(`.sessions-page .${kind}.${status}`)).map(status => `${kind}.${status}`));
    assert.deepEqual(missing, []);
});
