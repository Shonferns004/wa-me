"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const export_tables_1 = require("./export-tables");
/**
 * The credentials a backup payload must not carry.
 *
 * `GET /api/infra/export-data` is the JSON half of the documented backup runbook (docs/11), and
 * docs/04 records per secret how it is protected. Webhook secrets were already stripped here; the
 * session proxy URL was not, so a payload that deliberately omitted one credential shipped its
 * sibling in full. Neither redaction had a test.
 */
const tableFor = (key) => {
    const entry = export_tables_1.EXPORT_TABLES.find(t => t.key === key);
    if (!entry)
        throw new Error(`no export table registered for ${key}`);
    return entry;
};
const runAfterRead = (key, rows) => {
    const { afterRead } = tableFor(key);
    if (!afterRead)
        throw new Error(`${key} registers no afterRead hook`);
    afterRead(rows);
    return rows;
};
const session = (proxyUrl) => ({ id: 's1', name: 'main', status: 'ready', proxyUrl });
describe('export redaction', () => {
    describe('session proxy credentials', () => {
        it('strips userinfo and keeps the proxy reachable', () => {
            const [row] = runAfterRead('sessions', [session('http://bob:hunter2@proxy.example.com:8080')]);
            expect(row.proxyUrl).toBe('http://proxy.example.com:8080/');
            expect(row.proxyUrl).not.toContain('bob');
            expect(row.proxyUrl).not.toContain('hunter2');
        });
        /**
         * `socks5:` is not a WHATWG "special" scheme, so `URL.toString()` adds no trailing slash where
         * it would for `http:`. Both forms re-parse identically and both proxy agents accept them; the
         * assertion pins the shape so a future normalisation change is visible rather than silent.
         */
        it('strips a username with no password, on a socks scheme', () => {
            const [row] = runAfterRead('sessions', [session('socks5://bob@proxy.example.com:1080')]);
            expect(row.proxyUrl).toBe('socks5://proxy.example.com:1080');
            expect(row.proxyUrl).not.toContain('bob');
        });
        /**
         * The column is kept rather than dropped on purpose: an importer that restored no proxy would
         * let the session connect DIRECT on its next start, leaking the host's real egress IP with
         * nothing to notice. Host and scheme survive so the operator can see what was configured.
         */
        it('leaves a credential-free proxy untouched', () => {
            const [row] = runAfterRead('sessions', [session('http://proxy.example.com:8080')]);
            expect(row.proxyUrl).toBe('http://proxy.example.com:8080');
        });
        it('leaves a session with no proxy alone', () => {
            const [row] = runAfterRead('sessions', [session(null)]);
            expect(row.proxyUrl).toBeNull();
        });
        /** Unparseable means unprovable: it cannot be shown to be credential-free, so it does not ship. */
        it('clears a value the URL parser rejects', () => {
            const [row] = runAfterRead('sessions', [session('not a url')]);
            expect(row.proxyUrl).toBeNull();
        });
        it('redacts every row, not just the first', () => {
            const rows = runAfterRead('sessions', [
                session('http://a:1@one.example.com:8080'),
                session('http://b:2@two.example.com:8080'),
            ]);
            expect(rows.every(r => r.proxyUrl !== null && !r.proxyUrl.includes('@'))).toBe(true);
        });
    });
    describe('webhook credentials', () => {
        it('omits the secret and the custom headers', () => {
            const rows = runAfterRead('webhooks', [
                { id: 'w1', url: 'https://example.com/hook', secret: 's3cr3t', headers: { Authorization: 'Bearer t' } },
            ]);
            expect(rows[0]).not.toHaveProperty('secret');
            expect(rows[0]).not.toHaveProperty('headers');
            expect(rows[0].url).toBe('https://example.com/hook');
        });
    });
    describe('webhook delivery-failure replay payload', () => {
        it('drops the replay copy of the event and keeps the record', () => {
            const rows = runAfterRead('webhookDeliveryFailures', [
                { id: 'f1', webhookId: 'w1', lastError: 'HTTP 503: x', payload: '{"body":"private"}' },
            ]);
            expect(rows[0]).not.toHaveProperty('payload');
            expect(rows[0].lastError).toBe('HTTP 503: x');
        });
    });
});
